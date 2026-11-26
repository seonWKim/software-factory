// The API registry's architecture checks (design 09-api-registry): the schedules and items routes are capabilities the
// registry answers, with no hand-wired entry left; every declaration is complete; and every /api/v1 path in src/ui/ or
// web/src/api/routes.ts that no capability declares is on the ratchet's list below, which may only shrink.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "../src/api/index.js";
import { isFeatureMapPath } from "../src/api/feature-map.js";
import { type Declared, type Registry, buildRegistry, declare, registryReads, registryWrites } from "../src/api/registry.js";
import { object, string } from "../src/api/schema.js";
import { ITEM_ROW } from "../src/api/schemas/items.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { UiDeps } from "../src/ui/deps.js";
import { HealthMonitor } from "../src/ui/health.js";
import { readApi } from "../src/ui/read-routes.js";
import { cleanScanner } from "./helpers/fakes/config.js";
import { issue, newStore, system } from "./helpers/store.js";

const REPO = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

/** The files the ratchet scans: the UI server's route files and the dashboard's route map. */
const SCANNED = [...readdirSync(join(REPO, "src", "ui")).filter((f) => f.endsWith(".ts")).map((f) => `src/ui/${f}`), "web/src/api/routes.ts"];

/**
 * The unregistered /api/v1 paths (hand-written routes and page paths no capability declares), as the scan writes them:
 * a template's `${…}` is `:param`. The ratchet: a path the scan finds must be here, and the list may not grow past
 * CEILING. A path that moves into the registry leaves the list, and CEILING falls with it.
 */
const UNREGISTERED: readonly string[] = [
  "/api/v1/agents/stop", "/api/v1/alarms/dismiss", "/api/v1/attachments", "/api/v1/calendar",
  "/api/v1/calendar/connect", "/api/v1/calendar/disconnect", "/api/v1/calendar/events",
  "/api/v1/calendar/local-events", "/api/v1/calendar/local-events/delete", "/api/v1/calendar/local-events/edit",
  "/api/v1/calendar/sync", "/api/v1/data/ask", "/api/v1/data/autonomy", "/api/v1/data/tables",
  "/api/v1/data/tables/:param", "/api/v1/evals", "/api/v1/evals/write", "/api/v1/failures", "/api/v1/health",
  "/api/v1/improve/run", "/api/v1/items/:param", "/api/v1/items/:param/changes", "/api/v1/items/:param/commands",
  "/api/v1/items/:param/merge-check/recheck", "/api/v1/items/:param/runs/:param/transcript", "/api/v1/items/graph",
  "/api/v1/migrate", "/api/v1/model-credential", "/api/v1/notices", "/api/v1/overview", "/api/v1/packs/approvals",
  "/api/v1/pauses", "/api/v1/pauses/resume", "/api/v1/plugins", "/api/v1/plugins/import", "/api/v1/projects",
  "/api/v1/projects/delete", "/api/v1/projects/files/read", "/api/v1/projects/files/tree",
  "/api/v1/projects/files/write", "/api/v1/projects/folder", "/api/v1/proposals", "/api/v1/proposals/verdict",
  "/api/v1/queue", "/api/v1/routines", "/api/v1/rules", "/api/v1/rules/edit", "/api/v1/rules/entry",
  "/api/v1/rules/pushbacks/dismiss", "/api/v1/rules/skill-verdict", "/api/v1/rules/verdict", "/api/v1/runs",
  "/api/v1/screenshot", "/api/v1/session", "/api/v1/settings", "/api/v1/settings/capabilities", "/api/v1/spend",
  "/api/v1/standing", "/api/v1/supervisor", "/api/v1/tasks", "/api/v1/tasks/:param", "/api/v1/tasks/body",
  "/api/v1/tasks/build", "/api/v1/tasks/create", "/api/v1/tasks/delete", "/api/v1/tasks/done", "/api/v1/tasks/edit",
  "/api/v1/tasks/preview", "/api/v1/tasks/project", "/api/v1/tasks/reopen", "/api/v1/tasks/sub",
  "/api/v1/unreviewed-merges", "/api/v1/workers",
];
const CEILING = 73;

/** Text with its comments blanked (a `//` after `:` is a URL's, kept). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");

/** The /api/v1 route paths in a file's code: no query, no trailing `/` or `.`, `${…}` as `:param`. */
function apiPaths(text: string): string[] {
  const found = code(text).replace(/\$\{[^}]*\}/g, ":param").matchAll(/\/api\/v1(?:\/[A-Za-z0-9_.:-]*)*/g);
  const path = (m: string) => m.replace(/([^/]):param/g, "$1").replace(/[/.:]+$/, "");
  return [...new Set([...found].map((m) => path(m[0])))].filter((p) => p !== "/api/v1");
}

/** True when a capability declares the path; a `:param` segment stands for any one segment (a page's `${verb}`). */
function declares(r: Registry, path: string): boolean {
  const segment = (s: string) => (s === ":param" ? "[^/]+" : s.replace(/[.*+?^$()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`^${path.split("/").map(segment).join("/")}$`);
  return isFeatureMapPath(path) || r.capabilities.some((c) => pattern.test(c.path));
}

/** The scanned paths no capability of the registry declares (the feature map is the registry's own). */
function unregistered(r: Registry, files: Iterable<string>): string[] {
  const paths = new Set<string>();
  for (const text of files) for (const p of apiPaths(text)) if (!declares(r, p)) paths.add(p);
  return [...paths].sort();
}

/** The ratchet's findings: scanned paths not on the list, and the list past its ceiling. */
function ratchet(found: readonly string[], list: readonly string[], ceiling: number): { unlisted: string[]; over: number } {
  return { unlisted: found.filter((p) => !list.includes(p)), over: Math.max(0, list.length - ceiling) };
}

/** What a declaration lacks of its description, input and output schemas, kind (its method) and permission. */
function lacks(c: Declared): string[] {
  const out: string[] = [];
  if (typeof c.description !== "string" || c.description.trim() === "") out.push("description");
  if (typeof c.input?.json !== "function" || typeof c.input?.fields !== "object") out.push("input");
  if (typeof c.output?.json !== "function" || typeof c.output?.render !== "function") out.push("output");
  if (c.method !== "GET" && c.method !== "POST") out.push("kind");
  if (c.permission !== "read" && c.permission !== "owner") out.push("permission");
  return out;
}

const MOVED_READS = ["/api/v1/items", "/api/v1/schedules", "/api/v1/schedules/runs", "/api/v1/schedules/suggestions"];
const MOVED_WRITES = ["add", "edit", "pause", "resume", "run", "delete", "draft", "improve"].map((v) => `/api/v1/schedules/${v}`);

describe("the schedules and items routes", () => {
  it("are declared in src/api/capabilities/, reads with permission read and writes with permission owner, and the registry answers them", () => {
    for (const path of MOVED_READS) {
      expect(REGISTRY.capabilities.find((c) => c.path === path), path).toMatchObject({ method: "GET", permission: "read" });
      expect(registryReads(REGISTRY, path), path).toBe(true);
    }
    for (const path of MOVED_WRITES) {
      expect(REGISTRY.capabilities.find((c) => c.path === path), path).toMatchObject({ method: "POST", permission: "owner", id: `schedules.${path.split("/").pop()}` });
      expect(registryWrites(REGISTRY, path), path).toBe(true);
    }
    expect(REGISTRY.capabilities.map((c) => c.id)).toEqual(expect.arrayContaining(["items.list", "schedules.list", "schedules.runs", "schedules.suggestions"]));
  });

  it("type the items list's tier as an integer or null", () => {
    const tier = ITEM_ROW.fields.tier!;
    expect(tier.parse(2)).toMatchObject({ ok: true });
    expect(tier.parse(null)).toMatchObject({ ok: true });
    expect(tier.parse("2")).toMatchObject({ ok: false });
  });

  it("answer a list with a tier with 200 through the registry", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const item = (await store.createWorkItem(issue(1), system)).item;
    const t = await store.transition({ id: item.id, expected_version: item.version, patch: { tier: 2 }, actor: system, reason: "x" });
    expect(t.ok).toBe(true);
    const deps: UiDeps = { store, scanner: cleanScanner, clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock) };
    const r = await readApi(deps, new URL("http://127.0.0.1/api/v1/items"), { method: "GET", url: "/api/v1/items", host: "127.0.0.1" });
    expect(r.status).toBe(200);
    expect((r.value as { items: { id: string; tier: unknown }[] }).items).toContainEqual(expect.objectContaining({ id: item.id, tier: 2 }));
  });

  it("have no hand-wired entry left in read-routes.ts, write-routes-owner.ts or api.ts", () => {
    const reads = code(read("src/ui/read-routes.ts")), owner = code(read("src/ui/write-routes-owner.ts")), api = code(read("src/ui/api.ts"));
    expect(reads).not.toMatch(/schedules-api|readSchedule|SCHEDULE/);
    expect(owner).not.toMatch(/schedules-api|postSchedule|SCHEDULE_/);
    expect(api).not.toMatch(/case "\/items":/);
  });

  it("leave none of the route-table exports only the removed entries used, and nothing imports them", () => {
    const gone = /\b(SCHEDULE_RUNS_PATH|SCHEDULE_SUGGESTIONS_PATH|SCHEDULE_WRITE_PATHS|SCHEDULE_DRAFT_PATHS)\b/;
    const files = (dir: string): string[] =>
      readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) =>
        e.name === "node_modules" ? [] : e.isDirectory() ? files(`${dir}/${e.name}`) : /\.(ts|tsx|mjs|js)$/.test(e.name) && e.name !== "api-architecture.test.ts" ? [`${dir}/${e.name}`] : [],
      );
    const users = ["src", "tests", "web/src", "scripts"].flatMap(files).filter((f) => gone.test(read(f)));
    expect(users).toEqual([]);
  });
});

describe("every declaration", () => {
  it("has a description, an input and an output schema, a kind (GET or POST) and a permission (read or owner)", () => {
    expect(REGISTRY.capabilities.length).toBeGreaterThan(0);
    for (const c of REGISTRY.capabilities) expect({ id: c.id, lacks: lacks(c) }).toEqual({ id: c.id, lacks: [] });
  });

  it("missing one is caught", () => {
    const full = declare({ id: "fixture.full", area: "fixture", description: "Full.", permission: "read", method: "GET", path: "/api/v1/fixture/full", input: object({}), output: object({ a: string() }), run: () => ({ a: "" }) });
    expect(lacks(full)).toEqual([]);
    const without = (field: keyof Declared) => ({ ...full, [field]: undefined }) as unknown as Declared;
    expect(lacks(without("description"))).toEqual(["description"]);
    expect(lacks({ ...full, description: " " })).toEqual(["description"]);
    expect(lacks(without("input"))).toEqual(["input"]);
    expect(lacks(without("output"))).toEqual(["output"]);
    expect(lacks(without("method"))).toEqual(["kind"]);
    expect(lacks(without("permission"))).toEqual(["permission"]);
    expect(lacks({ ...full, permission: "anyone" } as unknown as Declared)).toEqual(["permission"]);
  });
});

describe("the ratchet of unregistered /api/v1 paths", () => {
  const found = unregistered(REGISTRY, SCANNED.map(read));

  it("holds every /api/v1 path in src/ui/ and web/src/api/routes.ts that no capability declares", () => {
    expect(ratchet(found, UNREGISTERED, CEILING).unlisted).toEqual([]);
  });

  it("does not grow past its ceiling, and holds none of the paths moved into the registry", () => {
    expect(UNREGISTERED.length).toBeLessThanOrEqual(CEILING);
    for (const path of [...MOVED_READS, ...MOVED_WRITES]) {
      expect(UNREGISTERED).not.toContain(path);
      expect(found).not.toContain(path);
    }
  });

  it("fails on a new hand-written path, and on a list grown past the ceiling; a declared path passes", () => {
    const route = 'const NEW_PATH = "/api/v1/fixture/new"; // a hand route; "/api/v1/in/comment" is not one';
    const page = "export const API = { thing: (id: string) => `/api/v1/things/${encodeURIComponent(id)}/parts?x=1` };";
    expect(apiPaths(route)).toEqual(["/api/v1/fixture/new"]);
    expect(apiPaths(page)).toEqual(["/api/v1/things/:param/parts"]);
    const hand = unregistered(REGISTRY, [...SCANNED.map(read), route, page]);
    expect(ratchet(hand, UNREGISTERED, CEILING).unlisted).toEqual(["/api/v1/fixture/new", "/api/v1/things/:param/parts"]);
    expect(ratchet(found, [...UNREGISTERED, "/api/v1/fixture/new"], CEILING).over).toBe(1);
    const fixture = buildRegistry([declare({ id: "fixture.new", area: "fixture", description: "New.", permission: "read", method: "GET", path: "/api/v1/fixture/new", input: object({}), output: object({}), run: () => ({}) })]);
    expect(unregistered(fixture, [route])).toEqual([]);
    expect(unregistered(fixture, ["const verb = (v: string) => `/api/v1/fixture/${v}`;"])).toEqual([]);
  });
});

describe("the schedules and items pages", () => {
  const calls = (file: string) => [...(code(read(file)).match(/import\s*\{([^}]*)\}\s*from\s*"\.\/generated\.js"/)?.[1] ?? "").matchAll(/\w+/g)].map((m) => m[0]);

  it("call the generated typed client: the schedule reads and writes and the items list", () => {
    expect(calls("web/src/api/schedules.ts")).toEqual(expect.arrayContaining([
      "schedulesList", "schedulesRuns", "schedulesSuggestions", "schedulesAdd", "schedulesEdit", "schedulesPause",
      "schedulesResume", "schedulesRun", "schedulesDelete", "schedulesDraft", "schedulesImprove",
    ]));
    expect(calls("web/src/api/items.ts")).toContain("itemsList");
  });

  it("hold no /api/v1/ path string outside comments", () => {
    for (const file of ["web/src/api/schedules.ts", "web/src/api/items.ts"]) expect(code(read(file)), file).not.toContain("/api/v1/");
  });

  it("leave no scheduleWrite route in routes.ts", () => {
    expect(code(read("web/src/api/routes.ts"))).not.toMatch(/\bscheduleWrite\b/);
  });
});

describe("the headless-first rule", () => {
  const RULE = "Headless first: a feature is declared as an API capability first, and the dashboard, chat and CLI call that API. Page-only or CLI-only behaviour and hand-written routes count as gaps.";

  it("is stated in prompts/triage.md, worded as the design topic file words it", () => {
    expect(read("prompts/triage.md")).toContain(RULE);
    expect(read("docs/design/09-api-registry.md")).toContain(RULE);
  });
});
