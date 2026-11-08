// The Settings page's API (design §8 and §9, issue #236): GET /api/v1/settings reads what `settings list` and
// `settings history` show; POST /api/v1/settings sets or resets through runSettings, so its checks and messages
// are the CLI's. The write route's guards (Host, Origin, Content-Type, CSRF token) refuse before any store write.
// Everything goes through respond(), the server's request handling without a socket, except one real-socket test.

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveProjectLabel } from "../src/core/project-labels.js";
import { PR_ONLY_DESCRIPTIONS, PR_ONLY_KEYS, SETTABLE_KEYS, SETTING_APPLIES, SETTING_DESCRIPTIONS, type SettingsBase } from "../src/core/settings.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { runSettings } from "../src/settings-cmd.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiSettings, newCsrfToken, storeProjectResolver } from "../src/ui/settings-api.js";
import { type UiDeps, type UiResponse, respond, startUi } from "../src/ui/server.js";
import { PROJECT } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const ACTOR = `local:${userInfo().username}`;
// Built here so no secret-shaped literal sits in the repository.
const SECRET = `ghp_${"Ab3".repeat(12)}`;

/** The file: workers 5 (max_workers 8), heartbeat 60 s, lease 300 s, max_attempts 3, and o/r's block with max_diff_files 10. */
const base: SettingsBase = {
  file: { workers: 5, heartbeat_ms: 60_000, lease_ms: 300_000, max_loops: 3 },
  layers: { defaults: { max_attempts: 3 }, projects: { "o/r": { max_diff_files: 10 } } },
  max_workers: 8,
};

async function setup(opts: { store?: FactoryStore; label?: boolean; resolveProject?: UiSettings["resolveProject"] } = {}) {
  const clock = new FakeClock();
  const store = opts.store ?? (await newStore(clock)).store;
  if (opts.label !== false) await saveProjectLabel(store, PROJECT);
  // A work item carries the project key, so the store-only resolver can find the configured repo's key.
  await store.createWorkItem(issue(1), system);
  const settings: UiSettings = {
    base,
    repo: { owner: "o", name: "r" },
    actor: ACTOR,
    resolveProject: opts.resolveProject ?? storeProjectResolver(store, { owner: "o", name: "r" }),
    csrfToken: newCsrfToken(),
  };
  const scanner = new PatternEgressScanner(async () => [SECRET]);
  const d: UiDeps = {
    store,
    scanner,
    clock,
    lease_ms: 300_000,
    health: new HealthMonitor(async () => [], clock),
    settings,
  };
  return { d, store, settings };
}

const cli = (s: UiSettings, store: FactoryStore) => ({ store, base: s.base, repo: s.repo, actor: "local:cli", resolveProject: async () => PROJECT });

async function cliList(s: UiSettings, store: FactoryStore): Promise<string[]> {
  return (await runSettings(cli(s, store), { action: "list" })).lines;
}

async function cliHistory(s: UiSettings, store: FactoryStore): Promise<string[]> {
  return (await runSettings(cli(s, store), { action: "history", limit: 50 })).lines;
}

function getSettings(d: UiDeps): Promise<UiResponse> {
  return respond(d, { method: "GET", url: "/api/v1/settings", host: HOST });
}

async function view(d: UiDeps) {
  const r = await getSettings(d);
  expect(r.status).toBe(200);
  return JSON.parse(r.body);
}

interface PostOpts {
  host?: string;
  origin?: string | null;
  contentType?: string | null;
  csrf?: string | null;
  path?: string;
}

function post(d: UiDeps, body: unknown, o: PostOpts = {}): Promise<UiResponse> {
  return respond(d, {
    method: "POST",
    url: o.path ?? "/api/v1/settings",
    host: o.host ?? HOST,
    origin: o.origin === null ? undefined : (o.origin ?? ORIGIN),
    contentType: o.contentType === null ? undefined : (o.contentType ?? "application/json"),
    csrfToken: o.csrf === null ? undefined : (o.csrf ?? d.settings!.csrfToken),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function nothingStored(store: FactoryStore) {
  expect(await store.listSettingOverrides()).toEqual([]);
  expect(await store.listSettingChanges(50)).toEqual([]);
}

describe("GET /api/v1/settings", () => {
  it("lists every settable key with its effective value, source, file value, project values and applies-at", async () => {
    const { d, store } = await setup();
    await store.setSettingOverride({ key: "max_loops", project: "", value: "4", actor: ACTOR });
    await store.setSettingOverride({ key: "max_attempts", project: PROJECT.key, value: "2", actor: ACTOR });
    const v = await view(d);
    expect(v.keys.map((k: { key: string }) => k.key)).toEqual([...SETTABLE_KEYS]);
    const row = (key: string) => v.keys.find((k: { key: string }) => k.key === key);
    expect(row("max_loops")).toMatchObject({ value: "4", source: "override", file_value: "3", applies_at: SETTING_APPLIES.max_loops, project_settable: false });
    for (const k of SETTABLE_KEYS) expect(row(k).description).toBe(SETTING_DESCRIPTIONS[k]);
    expect(row("workers")).toMatchObject({ value: "5", source: "file", file_value: "5", max: 8, capped_at: null });
    expect(row("tick_ms")).toMatchObject({ value: "2000", source: "default", file_value: null });
    expect(row("max_attempts")).toMatchObject({
      value: "3", source: "file", file_value: "3", project_settable: true,
      projects: [{ project: "github.com/o/r", value: "2", source: "override" }],
    });
    expect(row("max_diff_files")).toMatchObject({ projects: [{ project: "github.com/o/r", value: "10", source: "file" }] });
    expect(row("phases_auto_approve")).toMatchObject({ kind: "boolean", value: "false" });
    expect(row("models")).toMatchObject({ kind: "models" });
    expect(row("model_by")).toMatchObject({ kind: "model_by" });
    expect(v.repo).toBe("o/r");
    expect(v.project).toBe("github.com/o/r");
    // The project key is never shown.
    expect(JSON.stringify(v)).not.toContain(PROJECT.key);
  });

  it("lists the PR-only keys as 'changes by PR only'", async () => {
    const { d } = await setup();
    const v = await view(d);
    expect(v.pr_only).toEqual(PR_ONLY_KEYS.map((key) => ({ key, note: "changes by PR only", description: PR_ONLY_DESCRIPTIONS[key] })));
    for (const k of ["secrets", "egress", "broker"]) expect(v.pr_only.map((p: { key: string }) => p.key)).toContain(k);
    for (const k of PR_ONLY_KEYS) expect(v.keys.map((r: { key: string }) => r.key)).not.toContain(k);
  });

  it("returns the last 50 audit rows, the rows `settings history` shows", async () => {
    const { d, store, settings } = await setup();
    for (let i = 1; i <= 52; i++) await store.setSettingOverride({ key: "max_loops", project: "", value: String(i), actor: ACTOR });
    await store.setSettingOverride({ key: "max_attempts", project: PROJECT.key, value: "2", actor: ACTOR });
    const v = await view(d);
    expect(v.history).toHaveLength(50);
    const lines = await cliHistory(settings, store);
    expect(lines).toHaveLength(50);
    const asLines = v.history.map(
      (c: { at: string; actor: string; key: string; project: string | null; old_value: string | null; new_value: string | null }) =>
        `${c.at}  ${c.actor}  ${c.key}${c.project ? ` for ${c.project}` : ""}  ${c.new_value === null ? `reset (was ${c.old_value})` : `${c.old_value ?? "(no override)"} → ${c.new_value}`}`,
    );
    expect(asLines).toEqual(lines);
  });

  it("returns the per-process CSRF token, and is a 404 without settings wired", async () => {
    const { d, settings } = await setup();
    expect((await view(d)).csrf_token).toBe(settings.csrfToken);
    expect(settings.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newCsrfToken()).not.toBe(settings.csrfToken);
    const { settings: _, ...without } = d;
    expect((await getSettings(without)).status).toBe(404);
  });

  it("passes descriptions through the Withholder", async () => {
    const { d } = await setup();
    const scanned: UiDeps = { ...d, scanner: new PatternEgressScanner(async () => [SETTING_DESCRIPTIONS.tick_ms, PR_ONLY_DESCRIPTIONS.secrets]) };
    const v = await view(scanned);
    const tick = v.keys.find((k: { key: string }) => k.key === "tick_ms");
    expect(tick.description).not.toBe(SETTING_DESCRIPTIONS.tick_ms);
    expect(tick.description).toContain("[withheld:");
    expect(v.pr_only.find((p: { key: string }) => p.key === "secrets").description).toContain("[withheld:");
  });

  it("passes actor IDs and values through the Withholder", async () => {
    const { d, store } = await setup();
    await store.setSettingOverride({ key: "max_loops", project: "", value: "4", actor: `local:${SECRET}` });
    await store.setSettingOverride({ key: "run_timeout_ms", project: "", value: JSON.stringify(SECRET), actor: ACTOR });
    const r = await getSettings(d);
    expect(r.body).not.toContain(SECRET);
    expect(r.body).toContain("[withheld:");
  });
});

describe("POST /api/v1/settings", () => {
  it("set max_attempts writes one override and one audit row, and `settings list` shows the new value", async () => {
    const { d, store, settings } = await setup();
    const r = await post(d, { action: "set", key: "max_attempts", value: "2" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, lines: ["max_attempts = 2 (override; was 3, file)", `applies at ${SETTING_APPLIES.max_attempts}, with no restart`] });
    expect(await store.listSettingOverrides()).toEqual([expect.objectContaining({ key: "max_attempts", project: "", value: "2", set_by: ACTOR })]);
    expect(await store.listSettingChanges(50)).toEqual([expect.objectContaining({ key: "max_attempts", old_value: null, new_value: "2", actor: ACTOR })]);
    expect((await cliList(settings, store)).find((l) => l.startsWith("max_attempts"))).toMatch(/override\s+2$/);
  });

  it("stores the actor as local:<OS login>, never a display name", async () => {
    const { d, store } = await setup();
    await post(d, { action: "set", key: "max_loops", value: "4" });
    const [c] = await store.listSettingChanges(1);
    expect(c!.actor).toBe(`local:${userInfo().username}`);
    // buildUiParts takes the actor the ui command builds as the CLI identity (issue #318): cli_user, git user.email, the OS
    // login, or anonymous; an ID, never a display name (tests/local-cli.test.ts covers the order).
    const main = readFileSync(join(import.meta.dirname, "../src/cli/handlers/ui/ui.command.ts"), "utf8");
    expect(main).toContain("buildUiParts(loaded, { identity: cliIdentity(cliUserConfig(loaded.file), await cliEnvironment(loaded.root)) })");
  });

  it("refuses heartbeat_ms × 2 ≥ lease_ms with the CLI's message and stores nothing", async () => {
    const { d, store, settings } = await setup();
    const cliR = await runSettings({ ...cli(settings, store) }, { action: "set", key: "heartbeat_ms", value: "200000" });
    expect(cliR.ok).toBe(false);
    const r = await post(d, { action: "set", key: "heartbeat_ms", value: "200000" });
    expect(r.status).toBe(422);
    expect(JSON.parse(r.body)).toEqual({ error: cliR.lines[0] });
    expect(cliR.lines[0]).toContain("heartbeat_ms must be well under lease_ms");
    await nothingStored(store);
  });

  it("refuses a PR-only key and a guard with the CLI's message and stores nothing", async () => {
    const { d, store, settings } = await setup();
    for (const key of ["plugins", "secrets", "egress", "broker", "budgets"]) {
      const cliR = await runSettings(cli(settings, store), { action: "set", key, value: "{}" });
      const r = await post(d, { action: "set", key, value: "{}" });
      expect(r.status, key).toBe(422);
      expect(JSON.parse(r.body), key).toEqual({ error: cliR.lines[0] });
      const reset = await post(d, { action: "reset", key });
      expect(reset.status, key).toBe(422);
    }
    expect(JSON.parse((await post(d, { action: "set", key: "secrets", value: "{}" })).body).error).toContain("changes by PR only");
    await nothingStored(store);
  });

  it("refuses workers above max_workers with the CLI's message and stores nothing", async () => {
    const { d, store, settings } = await setup();
    const cliR = await runSettings(cli(settings, store), { action: "set", key: "workers", value: "9" });
    const r = await post(d, { action: "set", key: "workers", value: "9" });
    expect(r.status).toBe(422);
    expect(JSON.parse(r.body)).toEqual({ error: cliR.lines[0] });
    expect(cliR.lines[0]).toContain("max_workers (8)");
    await nothingStored(store);
    expect((await post(d, { action: "set", key: "workers", value: "8" })).status).toBe(200);
  });

  it("reset removes the override and `settings list` shows the file value again", async () => {
    const { d, store, settings } = await setup();
    await post(d, { action: "set", key: "max_loops", value: "7" });
    const r = await post(d, { action: "reset", key: "max_loops" });
    expect(r.status).toBe(200);
    expect(await store.listSettingOverrides()).toEqual([]);
    expect((await cliList(settings, store)).find((l) => l.startsWith("max_loops"))).toMatch(/file\s+3$/);
    expect((await view(d)).keys.find((k: { key: string }) => k.key === "max_loops")).toMatchObject({ value: "3", source: "file" });
  });

  it("reset with no override is refused with no audit row", async () => {
    const { d, store } = await setup();
    const r = await post(d, { action: "reset", key: "max_loops" });
    expect(r.status).toBe(422);
    expect(JSON.parse(r.body).error).toBe("refused: max_loops has no override; nothing to reset");
    await nothingStored(store);
  });

  it("a project set writes a project override `settings list` shows; a looser value is refused with the CLI's message", async () => {
    for (const [key, ok, loose] of [["max_attempts", "2", "4"], ["max_diff_lines", "100", "99999"], ["max_diff_files", "5", "41"]] as const) {
      const { d, store, settings } = await setup();
      const r = await post(d, { action: "set", key, value: ok, project: "o/r" });
      expect(r.status, key).toBe(200);
      expect(await store.listSettingOverrides()).toEqual([expect.objectContaining({ key, project: PROJECT.key, value: ok })]);
      const list = await cliList(settings, store);
      const at = list.indexOf("project github.com/o/r:");
      expect(at, key).toBeGreaterThanOrEqual(0);
      expect(list.slice(at).some((l) => l.trim().startsWith(key) && /override\s+/.test(l) && l.endsWith(ok)), key).toBe(true);
      const cliR = await runSettings(cli(settings, store), { action: "set", key, value: loose, project: "o/r" });
      expect(cliR.ok, key).toBe(false);
      const bad = await post(d, { action: "set", key, value: loose, project: "o/r" });
      expect(bad.status, key).toBe(422);
      expect(JSON.parse(bad.body), key).toEqual({ error: cliR.lines[0] });
      expect(await store.listSettingChanges(50), key).toHaveLength(1);
      // A project write for another repo, or a global key, is refused as the CLI refuses it.
      expect((await post(d, { action: "set", key, value: ok, project: "x/y" })).status).toBe(422);
      expect((await post(d, { action: "set", key: "max_loops", value: "2", project: "o/r" })).status).toBe(422);
    }
  });

  it("a project write with no stored label is refused, pointing to `factory settings`; no forge call is made", async () => {
    const { d, store } = await setup({ label: false });
    const r = await post(d, { action: "set", key: "max_attempts", value: "2", project: "o/r" });
    expect(r.status).toBe(422);
    expect(JSON.parse(r.body).error).toMatch(/no project label is stored for o\/r.*settings set <key> <value> --project o\/r on the command line/);
    await nothingStored(store);

    // A resolver that throws (as a forge lookup would without credentials) is refused the same way.
    let asked = 0;
    const t = await setup({
      resolveProject: async () => {
        asked++;
        throw new Error("no forge credential in the UI process");
      },
    });
    const r2 = await post(t.d, { action: "set", key: "max_attempts", value: "2", project: "o/r" });
    expect(r2.status).toBe(422);
    expect(JSON.parse(r2.body).error).toContain("on the command line");
    expect(asked).toBe(1);
    await nothingStored(t.store);
    // Global writes never ask the resolver.
    expect((await post(t.d, { action: "set", key: "max_loops", value: "2" })).status).toBe(200);
    expect(asked).toBe(1);

    // The UI process builds no forge client and reads no forge credential.
    const compose = readFileSync(join(import.meta.dirname, "../src/compose.ts"), "utf8");
    const body = compose.slice(compose.indexOf("export async function buildUiParts"), compose.indexOf("/** What `factory session` needs"));
    expect(body).toContain("storeProjectResolver(store");
    for (const forge of ["GitHubClient", "githubCredentials", "resolveProject(github", "repoLookup"]) expect(body).not.toContain(forge);
  });

  it("refuses a POST without the CSRF token, or with a wrong one, with 403 and stores nothing", async () => {
    const { d, store } = await setup();
    for (const csrf of [null, "", "nope", newCsrfToken()]) {
      const r = await post(d, { action: "set", key: "max_loops", value: "2" }, { csrf });
      expect(r.status, String(csrf)).toBe(403);
    }
    await nothingStored(store);
  });

  it("refuses a missing Origin or one that is not the Host's own http origin with 403 and stores nothing", async () => {
    const { d, store } = await setup();
    for (const origin of [null, "", "null", "http://evil.example", "https://127.0.0.1:4310", "http://127.0.0.1:4311", "http://localhost:4310", "http://127.0.0.1"]) {
      const r = await post(d, { action: "set", key: "max_loops", value: "2" }, { origin });
      expect(r.status, String(origin)).toBe(403);
    }
    await nothingStored(store);
    expect((await post(d, { action: "set", key: "max_loops", value: "2" }, { host: "localhost:4310", origin: "http://localhost:4310" })).status).toBe(200);
  });

  it("refuses a Host other than 127.0.0.1 or localhost through the existing Host guard", async () => {
    const { d, store } = await setup();
    for (const host of ["evil.example", "127.0.0.1.evil.example:4310", ""]) {
      const r = await post(d, { action: "set", key: "max_loops", value: "2" }, { host, origin: `http://${host}` });
      expect(r.status, host).toBe(403);
      expect(JSON.parse(r.body).error).toBe("Host must be 127.0.0.1 or localhost.");
    }
    await nothingStored(store);
  });

  it("refuses a Content-Type other than application/json and stores nothing", async () => {
    const { d, store } = await setup();
    for (const contentType of [null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const r = await post(d, { action: "set", key: "max_loops", value: "2" }, { contentType });
      expect(r.status, String(contentType)).toBe(415);
    }
    await nothingStored(store);
    expect((await post(d, { action: "set", key: "max_loops", value: "2" }, { contentType: "application/json; charset=utf-8" })).status).toBe(200);
  });

  it("refuses a body that is not a set or reset with 400 and stores nothing", async () => {
    const { d, store } = await setup();
    for (const body of ["not json", "[]", { action: "list" }, { action: "set", key: "max_loops" }, { action: "set", key: "max_loops", value: 2 }, { action: "set", key: "max_loops", value: "2", extra: 1 }]) {
      const r = await post(d, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    await nothingStored(store);
  });

  it("POST on other /api/v1 paths, /app and /classic, and POST without settings wired, still answer 405", async () => {
    const { d, store } = await setup();
    for (const path of ["/api/v1/overview", "/api/v1/settings/x", "/api/v1/settingsx", "/app/settings", "/classic", "/api/health"]) {
      const r = await post(d, { action: "set", key: "max_loops", value: "2" }, { path });
      expect(r.status, path).toBe(405);
    }
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const r = await respond(d, { method, url: "/api/v1/settings", host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: d.settings!.csrfToken, body: "{}" });
      expect(r.status, method).toBe(405);
    }
    const { settings: _, ...without } = d;
    expect((await post(without, { action: "set", key: "max_loops", value: "2" }, { csrf: "x" })).status).toBe(405);
    await nothingStored(store);
  });
});

describe("the mode and the auto-merge tier on the Settings page (design 09)", () => {
  it("GET shows the mode (manual by default, kind mode, per project) and the auto-merge tier (0 by default)", async () => {
    const { d, store } = await setup();
    let v = await view(d);
    const row = (key: string) => v.keys.find((k: { key: string }) => k.key === key);
    expect(row("mode")).toMatchObject({ kind: "mode", value: '"manual"', source: "default", project_settable: true, projects: [] });
    expect(row("auto_merge_max_tier")).toMatchObject({ kind: "number", value: "0", source: "default", project_settable: false });
    await store.setSettingOverride({ key: "mode", project: PROJECT.key, value: '"auto"', actor: ACTOR });
    v = await view(d);
    expect(row("mode").projects).toEqual([{ project: PROJECT.label, value: '"auto"', source: "override" }]);
  });

  it("a flip writes one audit row naming the actor; without approve_merge it is refused (422) and writes no row", async () => {
    const { d, store, settings } = await setup();
    settings.mayApproveMerge = async () => "the requester role cannot approve_merge";
    for (const body of [{ action: "set", key: "mode", value: '"auto"' }, { action: "set", key: "auto_merge_max_tier", value: "2" }]) {
      const r = await post(d, body);
      expect(r.status).toBe(422);
      expect(JSON.parse(r.body).error).toContain("approve_merge");
    }
    await nothingStored(store);

    settings.mayApproveMerge = async () => null;
    expect((await post(d, { action: "set", key: "mode", value: '"auto"' })).status).toBe(200);
    expect(await store.listSettingChanges(50)).toEqual([expect.objectContaining({ key: "mode", new_value: '"auto"', actor: ACTOR })]);
    expect((await post(d, { action: "set", key: "auto_merge_max_tier", value: "4" })).status).toBe(422);
  });
});

describe("the CSRF token stays in memory", () => {
  it("is not in the store or on disk after reads and writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-ui-settings-"));
    const store = new SqlFactoryStore(new SqliteDriver(join(dir, "factory.db")), new FakeClock());
    await store.migrate();
    const { d, settings } = await setup({ store });
    try {
      expect((await view(d)).csrf_token).toBe(settings.csrfToken);
      expect((await post(d, { action: "set", key: "max_loops", value: "2" })).status).toBe(200);
      expect((await post(d, { action: "reset", key: "max_loops" })).status).toBe(200);
      const stored = JSON.stringify([await store.listSettingOverrides(), await store.listSettingChanges(50)]);
      expect(stored).not.toContain(settings.csrfToken);
    } finally {
      await store.close();
    }
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f)).includes(settings.csrfToken), f).toBe(false);
  });

  it("the real server reads Origin, Content-Type, x-csrf-token and the body, and caps the body", async () => {
    const { d, store, settings } = await setup();
    const ui = await startUi(d, 0);
    try {
      const url = `http://127.0.0.1:${ui.port}/api/v1/settings`;
      const got = (await (await fetch(url)).json()) as { csrf_token: string };
      expect(got.csrf_token).toBe(settings.csrfToken);
      const headers = { "content-type": "application/json", origin: `http://127.0.0.1:${ui.port}`, "x-csrf-token": got.csrf_token };
      const ok = await fetch(url, { method: "POST", headers, body: JSON.stringify({ action: "set", key: "max_loops", value: "2" }) });
      expect(ok.status).toBe(200);
      const noToken = await fetch(url, { method: "POST", headers: { ...headers, "x-csrf-token": "" }, body: JSON.stringify({ action: "set", key: "max_loops", value: "5" }) });
      expect(noToken.status).toBe(403);
      const big = await fetch(url, { method: "POST", headers, body: JSON.stringify({ action: "set", key: "max_loops", value: "2".repeat(70_000) }) });
      expect(big.status).toBe(413);
      expect(await store.listSettingChanges(50)).toHaveLength(1);
    } finally {
      await ui.close();
    }
  });
});
