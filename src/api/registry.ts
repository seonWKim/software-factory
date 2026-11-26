// The API registry (design 09-api-registry): each capability is declared once, with its id, area, description,
// permission, method, path and input and output schemas, and its run. From that one declaration come its HTTP route
// (registryRead and registryWrite, wired by one READ_ROUTES and one WRITE_ROUTES entry), the OpenAPI document
// (openApi), the typed client (clientText) and the feature map (feature-map.ts). A write route is reached only behind
// write-routes.ts's guards (Origin, Content-Type, CSRF token, body size); every string a route answers goes through
// the Withholder by its output schema. The permission is declared only: no guard reads it yet.
// scripts/gen-api.mjs loads the declarations (src/api/index.ts) through its resolve hook with Node's type stripping: this
// file imports outside src/api/ only as types, and a declaration file imports code outside src/api/ inside its run
// (a dynamic import), so the script never loads a handler.

import type { ApiResult } from "../ui/api.js";
import type { ServerDeps } from "../ui/server.js";
import type { Withholder } from "../ui/withhold.js";
import { FEATURE_MAP_PREFIX, isFeatureMapPath, readFeatureMap } from "./feature-map.js";
import { type ObjectSchema, type Schema, fromQuery } from "./schema.js";

/** Who may call a capability: anyone who can read the dashboard, or the owner. Declared, not yet enforced. */
export type Permission = "read" | "owner";
export type Method = "GET" | "POST";

/** What a capability's run gets: the server's dependencies and the request's time. */
export interface CapabilityCtx {
  d: ServerDeps;
  now: Date;
}

const REFUSED: unique symbol = Symbol("refused");
/** A run's refusal: answered as `{ error }` with its status, never checked against the output schema. */
export interface Refusal {
  [REFUSED]: true;
  status: number;
  error: string;
}
export const refuse = (status: number, error: string): Refusal => ({ [REFUSED]: true, status, error });
const isRefusal = (v: unknown): v is Refusal => typeof v === "object" && v !== null && REFUSED in v;

export interface Capability<I, O> {
  /** `<area>.<name>`, lowercase words joined by `-`. */
  id: string;
  area: string;
  description: string;
  permission: Permission;
  method: Method;
  /** Under /api/v1/, outside the feature map's own paths. */
  path: string;
  /** A GET reads it from the query parameters, a POST from the JSON body. */
  input: ObjectSchema<I>;
  output: Schema<O>;
  run(c: CapabilityCtx, input: I): O | Refusal | Promise<O | Refusal>;
}

/** A capability as the registry keeps it, its input type erased (the registry parses the input before run). */
export interface Declared extends Omit<Capability<unknown, unknown>, "run"> {
  run(c: CapabilityCtx, input: unknown): Promise<unknown>;
}

/** The one call a declaration file makes per capability. */
export function declare<I, O>(c: Capability<I, O>): Declared {
  return { ...c, run: async (ctx, input) => c.run(ctx, input as I) };
}

export interface Registry {
  readonly capabilities: readonly Declared[];
}

/** A server's registry: the declarations of src/api/index.ts, or a test's own (`api_registry`). */
export interface RegistryDeps {
  api_registry?: Registry;
}

const ID = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

/** The registry of these declarations; throws on a malformed id or path, or on two that clash. */
export function buildRegistry(capabilities: readonly Declared[]): Registry {
  const ids = new Set<string>(), routes = new Set<string>();
  for (const c of capabilities) {
    if (!ID.test(c.id) || !c.id.startsWith(`${c.area}.`)) throw new Error(`capability ${c.id}: the id must be <area>.<name> in lowercase words`);
    if (!c.path.startsWith("/api/v1/") || isFeatureMapPath(c.path)) throw new Error(`capability ${c.id}: the path must be under /api/v1/, outside ${FEATURE_MAP_PREFIX}`);
    const route = `${c.method} ${c.path}`;
    if (ids.has(c.id) || routes.has(route)) throw new Error(`capability ${c.id}: its id or ${route} is declared twice`);
    ids.add(c.id);
    routes.add(route);
  }
  return { capabilities: [...capabilities].sort((a, b) => a.id.localeCompare(b.id)) };
}

const capabilityAt = (r: Registry, method: Method, path: string): Declared | undefined => r.capabilities.find((c) => c.method === method && c.path === path);

/** True when the registry answers this GET path: the feature map or a GET capability. */
export function registryReads(r: Registry, path: string): boolean {
  return isFeatureMapPath(path) || capabilityAt(r, "GET", path) !== undefined;
}

/** True when a POST capability is declared at this path. */
export const registryWrites = (r: Registry, path: string): boolean => capabilityAt(r, "POST", path) !== undefined;

/** Parses the input, runs the capability and renders its answer through the Withholder by its output schema. */
async function serve(c: Declared, d: ServerDeps, raw: unknown, w: Pick<Withholder, "plain">): Promise<ApiResult> {
  const input = c.input.parse(raw);
  if (!input.ok) return { status: 400, value: { error: input.error } };
  const result = await c.run({ d, now: d.clock.now() }, input.value);
  const text = async (v: string) => (await w.plain(v)).text;
  if (isRefusal(result)) return { status: result.status, value: { error: await text(result.error) } };
  const out = await c.output.render(result, text);
  return out.ok ? { status: 200, value: out.value } : { status: 500, value: { error: `The capability's answer does not match its schema: ${out.error}` } };
}

/** A GET the registry answers (registryReads): the feature map or a capability with its query as input. */
export async function registryRead(r: Registry, d: ServerDeps, url: URL, w: Pick<Withholder, "plain">): Promise<ApiResult> {
  const map = readFeatureMap(r, url.pathname);
  if (map !== null) return map;
  const c = capabilityAt(r, "GET", url.pathname);
  return c ? serve(c, d, fromQuery(c.input, url.searchParams), w) : { status: 404, value: { error: "Not found." } };
}

/** A POST capability's answer, after write-routes.ts's guards parsed the body. */
export async function registryWrite(r: Registry, d: ServerDeps, path: string, body: unknown, w: Pick<Withholder, "plain">): Promise<ApiResult> {
  const c = capabilityAt(r, "POST", path);
  return c ? serve(c, d, body, w) : { status: 404, value: { error: "Not found." } };
}

const ERROR_BODY = { type: "object", properties: { error: { type: "string" } }, required: ["error"] };

/** The OpenAPI 3.1 document of the registry's capabilities. */
export function openApi(r: Registry): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const c of r.capabilities) {
    const io = c.method === "GET"
      ? { parameters: Object.entries(c.input.fields).map(([name, s]) => ({ name, in: "query", required: !s.optional, schema: s.json() })) }
      : { requestBody: { required: true, content: { "application/json": { schema: c.input.json() } } } };
    (paths[c.path] ??= {})[c.method.toLowerCase()] = {
      operationId: c.id,
      summary: c.description,
      tags: [c.area],
      "x-permission": c.permission,
      ...io,
      responses: {
        "200": { description: "OK", content: { "application/json": { schema: c.output.json() } } },
        default: { description: "Refused", content: { "application/json": { schema: ERROR_BODY } } },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "software-factory API", version: "1", description: "Generated by scripts/gen-api.mjs from the declarations in src/api/index.ts. Do not edit: run `npm run gen:api`." },
    paths,
  };
}

/** docs/api/openapi.json's text. */
export const openApiText = (r: Registry): string => `${JSON.stringify(openApi(r), null, 2)}\n`;

const words = (id: string): string[] => id.split(/[.-]/);
const pascal = (id: string): string => words(id).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
const camel = (id: string): string => { const p = pascal(id); return p[0]!.toLowerCase() + p.slice(1); };

/** web/src/api/generated.ts's text: per capability its input and output types and one call through client.ts. */
export function clientText(r: Registry): string {
  const head = [
    "// GENERATED by scripts/gen-api.mjs from the capability declarations in src/api/index.ts (design 09-api-registry).",
    "// Do not edit this file: change a declaration and run `npm run gen:api`.",
  ];
  if (r.capabilities.length === 0) return [...head, "", "export {};", ""].join("\n");
  const gets = r.capabilities.some((c) => c.method === "GET"), posts = r.capabilities.some((c) => c.method === "POST");
  const lines = [...head, "", `import { ${[gets && "getJson", posts && "postJson"].filter(Boolean).join(", ")} } from "./client.js";`, ""];
  if (gets) {
    lines.push(
      "/** A GET's query string from its input: fields left out or null are not sent. */",
      "function query(input: Record<string, unknown>): string {",
      "  const p = new URLSearchParams();",
      "  for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null) p.set(k, String(v));",
      "  const s = p.toString();",
      "  return s === \"\" ? \"\" : `?${s}`;",
      "}",
      "",
    );
  }
  for (const c of r.capabilities) {
    const [In, Out] = [`${pascal(c.id)}Input`, `${pascal(c.id)}Output`];
    lines.push(`export type ${In} = ${c.input.ts()};`, `export type ${Out} = ${c.output.ts()};`, `/** ${c.description} (${c.method} ${c.path}, permission ${c.permission}) */`);
    lines.push(c.method === "GET"
      ? `export const ${camel(c.id)} = (input: ${In}): Promise<${Out}> => getJson<${Out}>(${JSON.stringify(c.path)} + query(input));`
      : `export const ${camel(c.id)} = (token: string, input: ${In}) => postJson<${Out} & { error?: string }>(${JSON.stringify(c.path)}, token, input);`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Where the declaration files sit, beside the index that lists them. */
export const DECLARATION_DIR = "capabilities";

/** The declaration files (base names, no `.ts`) the index does not import, and the imports with no file. */
export function indexGaps(indexText: string, files: readonly string[]): { unlisted: string[]; missing: string[] } {
  const listed = new Set([...indexText.matchAll(new RegExp(`from "\\./${DECLARATION_DIR}/([a-z0-9-]+)\\.js"`, "g"))].map((m) => m[1]!));
  const present = new Set(files.filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -".ts".length)));
  return { unlisted: [...present].filter((f) => !listed.has(f)).sort(), missing: [...listed].filter((f) => !present.has(f)).sort() };
}
