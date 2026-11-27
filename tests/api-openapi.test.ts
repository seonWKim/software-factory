// The OpenAPI document (design 09-api-registry): docs/api/openapi.json is what `npm run gen:api` writes from the
// declarations, so a schema changed without regenerating fails here; a breaking change between two documents needs a
// greater info.version (API_VERSION); and the items output schema (owner answer 3) types its top-level fields and
// types nested objects as JSON objects.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "../src/api/index.js";
import { API_VERSION, buildRegistry, declare, openApi, openApiText } from "../src/api/registry.js";
import { integer, nullable, object, optional, string } from "../src/api/schema.js";
import { ITEMS_OUTPUT, ITEM_ROW } from "../src/api/schemas/items.js";

const OPENAPI = join(import.meta.dirname, "..", "docs", "api", "openapi.json");

const echo = (output: ReturnType<typeof object>) =>
  buildRegistry([declare({ id: "fixture.echo", area: "fixture", description: "Echo.", permission: "read", method: "GET", path: "/api/v1/fixture/echo", input: object({}), output, run: () => ({}) })]);

type Doc = Record<string, unknown>;
type JsonSchema = { type?: string; anyOf?: JsonSchema[]; enum?: unknown[]; items?: JsonSchema; properties?: Record<string, JsonSchema>; required?: string[] };
type Operation = { parameters?: { name: string; required: boolean; schema: JsonSchema }[]; requestBody?: { content: { "application/json": { schema: JsonSchema } } }; responses?: { "200"?: { content: { "application/json": { schema: JsonSchema } } } } };

/** A schema's type as one word: its type (with its enum), or the types of an anyOf joined by `|`. */
const typeOf = (s: JsonSchema): string => (s.anyOf ? s.anyOf.map(typeOf).join("|") : `${s.type ?? "any"}${s.enum ? `(${s.enum.join(",")})` : ""}`);

/** The breaking changes from one schema to the next at `at`: a changed type, a removed or newly required property, and in an input a new required field. */
function schemaChanges(prev: JsonSchema, next: JsonSchema, at: string, input: boolean): string[] {
  if (typeOf(prev) !== typeOf(next)) return [`${at}: type ${typeOf(prev)} became ${typeOf(next)}`];
  if (prev.anyOf && next.anyOf) return prev.anyOf.flatMap((p, i) => schemaChanges(p, next.anyOf![i]!, at, input));
  if (prev.items && next.items) return schemaChanges(prev.items, next.items, `${at}[]`, input);
  const [pp, np] = [prev.properties ?? {}, next.properties ?? {}];
  const [pr, nr] = [new Set(prev.required ?? []), new Set(next.required ?? [])];
  const out: string[] = [];
  for (const [k, s] of Object.entries(pp)) {
    if (!(k in np)) out.push(`${at}.${k}: removed`);
    else if (nr.has(k) && !pr.has(k)) out.push(`${at}.${k}: became required`);
    else out.push(...schemaChanges(s, np[k]!, `${at}.${k}`, input));
  }
  if (input) for (const k of Object.keys(np)) if (!(k in pp) && nr.has(k)) out.push(`${at}.${k}: new required input field`);
  return out;
}

/** A GET's query parameters as one input object schema. */
const queryInput = (op: Operation): JsonSchema => ({
  type: "object",
  properties: Object.fromEntries((op.parameters ?? []).map((p) => [p.name, p.schema])),
  required: (op.parameters ?? []).filter((p) => p.required).map((p) => p.name),
});
const inputOf = (op: Operation): JsonSchema => op.requestBody?.content["application/json"].schema ?? queryInput(op);
const outputOf = (op: Operation): JsonSchema => op.responses?.["200"]?.content["application/json"].schema ?? {};

/**
 * The breaking changes from one OpenAPI document to the next: a removed path or method, a removed property, a changed
 * type, a property that becomes required, or a new required input field. An added optional field is not one.
 */
function breakingChanges(previous: Doc, next: Doc): string[] {
  const [pp, np] = [previous.paths, next.paths] as Record<string, Record<string, Operation>>[];
  const out: string[] = [];
  for (const [path, ops] of Object.entries(pp ?? {})) {
    for (const [method, op] of Object.entries(ops)) {
      const now = np?.[path]?.[method];
      const at = `${method.toUpperCase()} ${path}`;
      if (!now) out.push(`${at}: removed`);
      else out.push(...schemaChanges(inputOf(op), inputOf(now), `${at} input`, true), ...schemaChanges(outputOf(op), outputOf(now), `${at} output`, false));
    }
  }
  return out;
}

const versionOf = (d: Doc): number => Number((d.info as { version: string }).version);

/** The breaking changes the next document makes without a greater version; empty when it makes none or bumps the version. */
const unversionedBreaks = (previous: Doc, next: Doc): string[] => (versionOf(next) > versionOf(previous) ? [] : breakingChanges(previous, next));

describe("docs/api/openapi.json", () => {
  it("is the document of the declared capabilities (npm run gen:api)", () => {
    expect(readFileSync(OPENAPI, "utf8")).toBe(openApiText(REGISTRY));
  });

  it("goes stale when a capability's schema changes: the regenerated document differs", () => {
    const checkedIn = openApiText(echo(object({ note: string() })));
    expect(openApiText(echo(object({ note: integer() })))).not.toBe(checkedIn);
    expect(openApiText(echo(object({ note: string(), more: string() })))).not.toBe(checkedIn);
    expect(openApiText(echo(object({ note: string() })))).toBe(checkedIn);
  });

  it("carries API_VERSION as its info.version", () => {
    expect((JSON.parse(readFileSync(OPENAPI, "utf8")) as { info: { version: string } }).info.version).toBe(API_VERSION);
  });

  it("makes no breaking change against the checked-in document without a version bump", () => {
    expect(unversionedBreaks(JSON.parse(readFileSync(OPENAPI, "utf8")) as Doc, openApi(REGISTRY))).toEqual([]);
  });
});

describe("a breaking schema change", () => {
  type Shape = Parameters<typeof object>[0];
  const doc = (version: string, fields: { input?: Shape; output?: Shape; method?: "GET" | "POST"; path?: string } = {}): Doc => {
    const method = fields.method ?? "GET";
    const r = buildRegistry([declare({ id: "fixture.echo", area: "fixture", description: "Echo.", permission: "read", method, path: fields.path ?? "/api/v1/fixture/echo", input: object(fields.input ?? { q: optional(string()) }), output: object(fields.output ?? { note: string(), extra: optional(string()) }), run: () => ({}) })]);
    const d = openApi(r);
    return { ...d, info: { ...(d.info as object), version } };
  };
  const base = doc("1");
  const pairs: [string, Doc][] = [
    ["a removed path", doc("1", { path: "/api/v1/fixture/other" })],
    ["a removed method", doc("1", { method: "POST" })],
    ["a removed property", doc("1", { output: { extra: optional(string()) } })],
    ["a changed type", doc("1", { output: { note: integer(), extra: optional(string()) } })],
    ["a nullable type", doc("1", { output: { note: nullable(string()), extra: optional(string()) } })],
    ["a property that becomes required", doc("1", { output: { note: string(), extra: string() } })],
    ["an input field that becomes required", doc("1", { input: { q: string() } })],
    ["a new required input field", doc("1", { input: { q: optional(string()), must: string() } })],
    ["a new required POST body field", doc("1", { method: "POST", input: { must: string() } })],
  ];
  const postBase = doc("1", { method: "POST" });

  it("without a version bump fails", () => {
    for (const [name, next] of pairs) {
      const prev = name === "a new required POST body field" ? postBase : base;
      expect(unversionedBreaks(prev, next), name).not.toEqual([]);
    }
  });

  it("with a bumped version passes", () => {
    for (const [name, next] of pairs) {
      const prev = name === "a new required POST body field" ? postBase : base;
      expect(unversionedBreaks(prev, { ...next, info: { ...(next.info as object), version: "2" } }), name).toEqual([]);
    }
  });

  it("names what broke", () => {
    expect(breakingChanges(base, pairs[0]![1])).toEqual(["GET /api/v1/fixture/echo: removed"]);
    expect(breakingChanges(base, pairs[2]![1])).toEqual(["GET /api/v1/fixture/echo output.note: removed"]);
    expect(breakingChanges(base, pairs[3]![1])).toEqual(["GET /api/v1/fixture/echo output.note: type string became integer"]);
    expect(breakingChanges(base, pairs[5]![1])).toEqual(["GET /api/v1/fixture/echo output.extra: became required"]);
    expect(breakingChanges(base, pairs[7]![1])).toEqual(["GET /api/v1/fixture/echo input.must: new required input field"]);
  });

  it("is not an added optional field, in the output or the input", () => {
    expect(unversionedBreaks(base, doc("1", { output: { note: string(), extra: optional(string()), more: optional(string()) } }))).toEqual([]);
    expect(unversionedBreaks(base, doc("1", { input: { q: optional(string()), more: optional(string()) } }))).toEqual([]);
    expect(unversionedBreaks(base, doc("1"))).toEqual([]);
  });
});

describe("the items output schema", () => {
  const props = (s: { json(): Record<string, unknown> }) => s.json().properties as Record<string, Record<string, unknown>>;

  it("types the answer's top-level fields, and the list's rows", () => {
    const top = props(ITEMS_OUTPUT);
    expect(top.as_of).toEqual({ type: "string" });
    expect(top.total).toEqual({ type: "integer" });
    expect(top.items).toEqual({ type: "array", items: ITEM_ROW.json() });
    const row = props(ITEM_ROW);
    expect(row.id).toEqual({ type: "string" });
    expect(row.version).toEqual({ type: "integer" });
    expect(row.title).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(ITEM_ROW.json().required).toEqual(expect.arrayContaining(["id", "title", "stage", "updated_at", "why"]));
    expect(ITEM_ROW.json().required).not.toContain("need");
  });

  it("types nested objects as JSON objects", () => {
    const top = props(ITEMS_OUTPUT), row = props(ITEM_ROW);
    for (const nested of [top.facets, top.counts, row.source, row.why, row.conflicts]) expect(nested).toEqual({ type: "object" });
    for (const nested of [row.issue, row.merge_check, row.run, row.claim]) expect(nested).toEqual({ anyOf: [{ type: "object" }, { type: "null" }] });
  });
});
