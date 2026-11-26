// The API registry (design 09-api-registry): a capability declared once, here a test fixture, appears in the HTTP API,
// the OpenAPI document, the typed client and the feature map with no other code; its routes send free text through
// the Withholder; its write route keeps write-routes.ts's guards in their order; src/api/index.ts lists every
// declaration file; web/src/api/generated.ts is the declarations' client and typechecks.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "../src/api/index.js";
import { DECLARATION_DIR, buildRegistry, clientText, declare, indexGaps, openApi, refuse } from "../src/api/registry.js";
import { integer, jsonObject, object, oneOf, optional, string } from "../src/api/schema.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { PauseDeps, UiPauses } from "../src/ui/pause-api.js";
import { type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { POST_ONLY } from "../src/ui/write-routes.js";
import { silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

const REPO = join(import.meta.dirname, "..");
const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
/** A string the egress scanner withholds (its github_token pattern). */
const SECRET = `ghp_${"a".repeat(36)}`;

/** Every note the write fixture saved, in order. */
const saved: string[] = [];

const ECHO = declare({
  id: "fixture.echo",
  area: "fixture",
  description: "Echoes a note back, a number of times.",
  permission: "read",
  method: "GET",
  path: "/api/v1/fixture/echo",
  input: object({ note: string(), times: optional(integer()) }),
  output: object({ notes: object({ first: string() }), times: integer(), level: oneOf(["low", "high"] as const), extra: jsonObject() }),
  run: (_c, i) => (i.note === "refuse" ? refuse(409, `refused ${SECRET}`) : { notes: { first: i.note }, times: i.times ?? 1, level: "low" as const, extra: { deep: [i.note] } }),
});

const SAVE = declare({
  id: "fixture.save",
  area: "fixture",
  description: "Saves a note.",
  permission: "owner",
  method: "POST",
  path: "/api/v1/fixture/save",
  input: object({ note: string() }),
  output: object({ saved: string() }),
  run: (_c, i) => (saved.push(i.note), { saved: i.note }),
});

const FIXTURE = buildRegistry([ECHO, SAVE]);

async function setup(registry = FIXTURE) {
  const clock = new FakeClock("2026-11-26T12:00:00.000Z");
  const { store } = await newStore(clock);
  const pauses: UiPauses = { principal: async () => "local:owner@example.com" as UserId, authorize: async () => ({ allow: true }), csrfToken: newCsrfToken(), log: silent };
  const base: PauseDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses };
  const d = { ...base, api_registry: registry };
  const get = async (url: string, deps: PauseDeps = d) => {
    const r = await respond(deps, { method: "GET", url, host: HOST });
    return { status: r.status, value: JSON.parse(r.body) };
  };
  const post = async (body: unknown, over: Partial<UiRequest> = {}) => {
    const r = await respond(d, { method: "POST", url: SAVE.path, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: pauses.csrfToken, body: JSON.stringify(body), ...over });
    return { status: r.status, value: JSON.parse(r.body) };
  };
  return { base, get, post, token: pauses.csrfToken };
}

describe("a capability declared in a fixture", () => {
  it("answers over HTTP: GET from the query, POST from the body, a bad input a 400; the declared registry does not have it", async () => {
    const { base, get, post } = await setup();
    expect(await get("/api/v1/fixture/echo?note=hi&times=3&other=x")).toEqual({ status: 200, value: { notes: { first: "hi" }, times: 3, level: "low", extra: { deep: ["hi"] } } });
    expect(await get("/api/v1/fixture/echo")).toEqual({ status: 400, value: { error: "note must be a string." } });
    expect(await get("/api/v1/fixture/echo?note=hi&times=x")).toEqual({ status: 400, value: { error: "times must be an integer." } });
    expect(await post({ note: "kept" })).toEqual({ status: 200, value: { saved: "kept" } });
    expect(await post({ note: 1 })).toEqual({ status: 400, value: { error: "note must be a string." } });
    expect(await post({ note: "x", more: 1 })).toEqual({ status: 400, value: { error: "more is not a field." } });
    expect((await get("/api/v1/fixture/echo?note=hi", base)).status).toBe(404);
  });

  it("is in the OpenAPI document, the typed client and the feature map", async () => {
    const doc = openApi(FIXTURE) as { paths: Record<string, Record<string, { operationId: string; parameters?: unknown[]; requestBody?: unknown }>> };
    expect(doc.paths[ECHO.path]!.get).toMatchObject({ operationId: "fixture.echo", parameters: [{ name: "note", in: "query", required: true }, { name: "times", in: "query", required: false }] });
    expect(doc.paths[SAVE.path]!.post).toMatchObject({ operationId: "fixture.save", "x-permission": "owner", requestBody: { required: true } });
    const client = clientText(FIXTURE);
    expect(client).toContain("export type FixtureEchoInput = ");
    expect(client).toContain("export const fixtureEcho = (input: FixtureEchoInput)");
    expect(client).toContain("export const fixtureSave = (token: string, input: FixtureSaveInput)");
    const { get } = await setup();
    expect((await get("/api/v1/feature-map/capabilities")).value.capabilities.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(["fixture.echo", "fixture.save"]));
  });

  it("refuses a malformed or clashing declaration", () => {
    expect(() => buildRegistry([{ ...ECHO, id: "echo" }])).toThrow(/<area>\.<name>/);
    expect(() => buildRegistry([{ ...ECHO, path: "/api/v1/feature-map/x" }])).toThrow(/outside/);
    expect(() => buildRegistry([ECHO, { ...ECHO, id: "fixture.other" }])).toThrow(/declared twice/);
  });
});

describe("free text through the Withholder", () => {
  it("withholds a finding in every string of a GET's answer, nested JSON objects too, and in a refusal; fixed words stay", async () => {
    const { get } = await setup();
    const withheld = "[withheld: github_token]";
    expect(await get(`/api/v1/fixture/echo?note=${SECRET}`)).toEqual({ status: 200, value: { notes: { first: withheld }, times: 1, level: "low", extra: { deep: [withheld] } } });
    expect(await get("/api/v1/fixture/echo?note=refuse")).toEqual({ status: 409, value: { error: withheld } });
  });

  it("withholds a finding in a POST's answer", async () => {
    const { post } = await setup();
    expect(await post({ note: SECRET })).toEqual({ status: 200, value: { saved: "[withheld: github_token]" } });
  });
});

describe("the registry's write route", () => {
  it("runs Origin, Content-Type, CSRF token, then body size before the capability, in that order", async () => {
    const { post, token } = await setup();
    const before = saved.length;
    const all = { origin: "http://evil.example", contentType: "text/plain", csrfToken: "wrong", bodyTooLarge: true };
    const steps: [Partial<UiRequest>, number, string][] = [
      [all, 403, "Origin"],
      [{ ...all, origin: ORIGIN }, 415, "Content-Type"],
      [{ ...all, origin: ORIGIN, contentType: "application/json" }, 403, "x-csrf-token"],
      [{ ...all, origin: ORIGIN, contentType: "application/json", csrfToken: token }, 413, "too large"],
    ];
    for (const [over, status, says] of steps) {
      const r = await post({ note: "guarded" }, over);
      expect({ status: r.status, error: r.value.error }).toEqual({ status, error: expect.stringContaining(says) });
    }
    expect(saved.length).toBe(before);
    expect(await post({ note: "guarded" }, { body: "{" })).toEqual({ status: 400, value: { error: "The body must be JSON." } });
    expect((await post({ note: "guarded" })).status).toBe(200);
    expect(saved.slice(before)).toEqual(["guarded"]);
  });

  it("is named in POST_ONLY; a POST to a GET capability's path is the 405", async () => {
    expect(POST_ONLY).toContain("API registry capability");
    const { post } = await setup();
    expect((await post({ note: "x" }, { url: ECHO.path })).status).toBe(405);
  });
});

describe("src/api/index.ts", () => {
  const dir = join(REPO, "src", "api", DECLARATION_DIR);
  const index = readFileSync(join(REPO, "src", "api", "index.ts"), "utf8");

  it("lists every declaration file, and names none that is gone", () => {
    expect(indexGaps(index, existsSync(dir) ? readdirSync(dir) : [])).toEqual({ unlisted: [], missing: [] });
  });

  it("is stale when a declaration file is not imported, or an import has no file", () => {
    expect(indexGaps(index, [...(existsSync(dir) ? readdirSync(dir) : []), "fixture.ts"])).toEqual({ unlisted: ["fixture"], missing: [] });
    expect(indexGaps('import { CAPABILITIES as a } from "./capabilities/gone.js";', [])).toEqual({ unlisted: [], missing: ["gone"] });
  });
});

/** The type errors of a generated client, checked as web/tsconfig.json checks web/src, against client.ts's signatures. */
function typeErrors(client: string): string[] {
  const files: Record<string, string> = {
    "/virtual/generated.ts": client,
    "/virtual/client.ts": [
      "export declare function getJson<T>(url: string): Promise<T>;",
      "export declare function postJson<T extends { error?: string }>(url: string, token: string, body: unknown): Promise<{ ok: boolean; status: number; value: T }>;",
    ].join("\n"),
  };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, verbatimModuleSyntax: true, isolatedModules: true, noEmit: true, types: [],
  };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, lang, ...rest) => (name in files ? ts.createSourceFile(name, files[name]!, lang) : getSourceFile.call(host, name, lang, ...rest));
  host.fileExists = (name) => name in files || fileExists.call(host, name);
  host.readFile = (name) => files[name] ?? readFile.call(host, name);
  host.directoryExists = (name) => name === "/virtual" || ts.sys.directoryExists(name);
  const program = ts.createProgram(["/virtual/generated.ts"], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("web/src/api/generated.ts", () => {
  it("is the client of the declared capabilities (npm run gen:api)", () => {
    expect(readFileSync(join(REPO, "web", "src", "api", "generated.ts"), "utf8")).toBe(clientText(REGISTRY));
  });

  it("typechecks, for the declared registry and for the fixture", () => {
    expect(typeErrors(clientText(REGISTRY))).toEqual([]);
    expect(typeErrors(clientText(FIXTURE))).toEqual([]);
    expect(typeErrors(`${clientText(FIXTURE)}\nexport const wrong: FixtureEchoOutput = fixtureEcho({ note: "x" });\n`)).not.toEqual([]);
  });
});
