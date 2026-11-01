// The Health panel and GET /api/health: one implementation (doctorChecks) behind doctor and the page,
// a read-only MySQL probe, a 60-second limit with one shared in-flight run, and egress-scanned messages.

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Loaded, Plugins, loadConfig } from "../src/compose.js";
import type { FactoryStore, SchemaVersion } from "../src/interfaces/factory-store.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import { type Secret, secretName } from "../src/interfaces/secret-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { REGISTRY, type Registry, withPlugin } from "../src/plugins.js";
import { type Check, checkLine, checkStatus, checksExitCode, doctor, doctorChecks } from "../src/setup.js";
import { HEALTH_MIN_INTERVAL_MS, HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, type UiResponse, respond } from "../src/ui/server.js";
import { BACKENDS } from "./helpers/store.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const MYSQL = { type: "mysql", host: "db.invalid", port: 3306, database: "sf", user: "factory" };

afterEach(() => {  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The page's whole request handling without a socket (respond() is what startUi runs per request). */
async function get(d: UiDeps, path: string): Promise<UiResponse> {
  return respond(d, { method: "GET", url: path, host: "127.0.0.1:4310" });
}

function section(body: string, id: string): string {
  const start = body.indexOf(`<section id="${id}">`);
  if (start < 0) throw new Error(`no section ${id}`);
  return body.slice(start, body.indexOf("</section>", start));
}

/** A store for the health path: only schemaVersion and close work; anything else (migrate, any write) throws. */
function probeOnlyStore(version: SchemaVersion | Error, calls: string[]): FactoryStore {
  return new Proxy({} as FactoryStore, {
    get(_t, prop) {
      if (prop === "then") return undefined; // not a thenable
      const name = String(prop);
      return async () => {
        calls.push(name);
        if (name === "close") return;
        if (name === "schemaVersion") {
          if (version instanceof Error) throw version;
          return version;
        }
        throw new Error(`store.${name} called on the health path`);
      };
    },
  });
}

function secret(value: string): Secret {
  return { name: secretName("GITHUB_TOKEN"), reveal: () => value, toString: () => "[secret]", toJSON: () => "[secret]" };
}

/** GitHub over a stubbed fetch: the repo (push allowed, no expiry header) and which labels exist. */
function stubGitHub(labels: Set<string>): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url).pathname;
    const label = path.split("/labels/")[1];
    if (label === undefined) return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 });
    return labels.has(decodeURIComponent(label)) ? new Response("{}", { status: 200 }) : new Response("Not Found", { status: 404 });
  });
}

interface Setup {
  loaded: Loaded;
  storeCalls: string[];
  mysqlPassword: string;
}

/**
 * A throwaway repo root with a MySQL store block, the "mysql" store plugin replaced by `probeOnlyStore`,
 * a fake GitHub login over a stubbed fetch, and a real env-file secret file holding `fileExtra`.
 */
async function setupDoctor(opts: { version?: SchemaVersion | Error; fileExtra?: string; mysqlPassword?: string; labels?: string[] } = {}): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), "sf-health-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  const plugins = { ...(REAL.plugins as Record<string, unknown>), github_auth: "fake-gh", updater: "none" };
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...REAL, store: MYSQL, plugins, state_dir: "state", worktrees_dir: "wt" }));

  const mysqlPassword = opts.mysqlPassword ?? `pw-${randomBytes(8).toString("hex")}`;
  const secretsDir = mkdtempSync(join(tmpdir(), "sf-health-secrets-"));
  const file = join(secretsDir, ".env");
  writeFileSync(file, `CLAUDE_CODE_OAUTH_TOKEN=oauth-${randomBytes(8).toString("hex")}\nMYSQL_PASSWORD=${mysqlPassword}\n${opts.fileExtra ?? ""}`, { mode: 0o600 });
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", file);
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  // `claude --version` finds nothing: a deterministic FAIL, and no process is started.
  vi.stubEnv("PATH", mkdtempSync(join(tmpdir(), "sf-empty-path-")));

  const storeCalls: string[] = [];
  let registry: Registry = withPlugin(REGISTRY, "store", "mysql", () => probeOnlyStore(opts.version ?? { applied: 8, latest: 8 }, storeCalls), [
    { name: secretName("MYSQL_PASSWORD"), purpose: "test" },
  ]);
  const creds: GitHubCredentials = { token: async () => secret("tok"), grant: () => null };
  registry = withPlugin(registry, "github_auth", "fake-gh", () => creds);
  stubGitHub(new Set(opts.labels ?? ["factory", "sf: triaging"]));
  return { loaded: await loadConfig(dir, { registry }), storeCalls, mysqlPassword };
}

async function uiFor(loaded: Loaded, clock = new FakeClock()) {
  const p = new Plugins(loaded);
  const scanner = await p.scanner(await p.secrets());
  const store = new SqlFactoryStore(new SqliteDriver(":memory:"), clock);
  await store.migrate();
  const d: UiDeps = { store, scanner, clock, lease_ms: 60_000, prUrl: () => "https://github.com/o/r/pull/1", health: new HealthMonitor(() => doctorChecks(loaded), clock) };
  return { port: d, clock };
}

describe("health: one implementation behind doctor and the page", () => {
  it("GET /api/health returns doctorChecks' checks, in order, with the same results and messages", async () => {
    const { loaded } = await setupDoctor();
    const expected = await doctorChecks(loaded);
    // The fixture covers all three results.
    expect(new Set(expected.map(checkStatus))).toEqual(new Set(["ok", "warn", "fail"]));

    const { port } = await uiFor(loaded);
    const res = await get(port, "/api/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    const report = JSON.parse(res.body) as { checked_at: string; checks: { status: string; msg: string }[] };
    expect(Number.isNaN(Date.parse(report.checked_at))).toBe(false);
    expect(report.checks).toEqual(expected.map((c) => ({ status: checkStatus(c), msg: c.msg })));
  });

  it("doctor prints one line per check in the same format, and exits 1 only on FAIL", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { loaded } = await setupDoctor();
    const checks = await doctorChecks(loaded);
    log.mockClear();
    const code = await doctor(loaded);
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(checks.map(checkLine));
    expect(code).toBe(1); // claude CLI not found

    expect(checkLine({ ok: true, msg: "a" })).toBe("ok    a");
    expect(checkLine({ ok: false, msg: "b", warn: true })).toBe("warn  b");
    expect(checkLine({ ok: false, msg: "c" })).toBe("FAIL  c");
    expect(checksExitCode([{ ok: true, msg: "a" }, { ok: false, msg: "b", warn: true }])).toBe(0);
    expect(checksExitCode([{ ok: true, msg: "a" }, { ok: false, msg: "c" }])).toBe(1);
    expect(checksExitCode([])).toBe(0);
  });

  it("the Health panel lists each check with ok, warn or FAIL, its message and the last-run time", async () => {
    const { loaded } = await setupDoctor();
    const { port, clock } = await uiFor(loaded);
    const panel = section((await get(port, "/")).body, "health");
    expect(panel).toContain("<h2>Health</h2>");
    expect(panel).toContain(`Last run ${clock.now().toISOString()}`);
    expect(panel).toContain('href="/?health=refresh#health"');
    expect(panel).toMatch(/<td><strong>FAIL<\/strong><\/td><td>claude CLI: not found<\/td>/);
    expect(panel).toMatch(/<td>warn<\/td><td>GitHub token never expires/);
    expect(panel).toMatch(/<td>ok<\/td><td>MySQL factory@db\.invalid:3306\/sf reachable, schema up to date<\/td>/);
    expect(panel).not.toMatch(/llm-check/);
  });

  it("a failing check shows as FAIL on the panel", async () => {
    const { loaded } = await setupDoctor({ version: new Error("connect ECONNREFUSED 10.0.0.1:3306"), labels: [] });
    const { port } = await uiFor(loaded);
    const panel = section((await get(port, "/")).body, "health");
    expect(panel).toMatch(/<td><strong>FAIL<\/strong><\/td><td>MySQL factory@db\.invalid:3306\/sf: connect ECONNREFUSED 10\.0\.0\.1:3306<\/td>/);
    expect(panel).toMatch(/<td><strong>FAIL<\/strong><\/td><td>label &quot;factory&quot; exists \(run: npm run setup\)<\/td>/);
  });

  it("opening the page or the API makes no model call", async () => {
    const { loaded } = await setupDoctor();
    let calls = 0;
    const registry = withPlugin(loaded.registry, "llm", "counting", () => {
      calls++;
      throw new Error("no model call on the health path");
    });
    const { port } = await uiFor({ ...loaded, registry, plugins: { ...loaded.plugins, llm: "counting" } });
    await get(port, "/");
    await get(port, "/api/health");
    expect(calls).toBe(0);
  });
});

describe("health: the MySQL check is read-only", () => {
  it("reads the schema version and calls no migrate() or write on the store", async () => {
    const { loaded, storeCalls } = await setupDoctor();
    const { port } = await uiFor(loaded);
    const report = JSON.parse((await get(port, "/api/health")).body) as { checks: { status: string; msg: string }[] };
    expect(report.checks.find((c) => c.msg.startsWith("MySQL"))).toEqual({ status: "ok", msg: "MySQL factory@db.invalid:3306/sf reachable, schema up to date" });
    expect(storeCalls).toEqual(["schemaVersion", "close"]);
    expect(storeCalls).not.toContain("migrate");
  });

  it("a schema behind the code is a warning, not a FAIL, and is not migrated", async () => {
    const { loaded, storeCalls } = await setupDoctor({ version: { applied: 3, latest: 8 } });
    const c = (await doctorChecks(loaded)).find((x) => x.msg.startsWith("MySQL"))!;
    expect(checkStatus(c)).toBe("warn");
    expect(c.msg).toBe("MySQL factory@db.invalid:3306/sf reachable, schema at version 3 of 8 (the factory migrates it when it starts)");
    expect(storeCalls).toEqual(["schemaVersion", "close"]);
  });

  it("SqlFactoryStore.schemaVersion on an unmigrated SQLite file creates nothing", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sf-health-db-")), "f.db");
    const driver = new SqliteDriver(path);
    const store = new SqlFactoryStore(driver, new FakeClock());
    const v = await store.schemaVersion();
    expect(v.applied).toBe(0);
    expect(v.latest).toBeGreaterThan(0);
    expect(await driver.all("SELECT name FROM sqlite_master")).toEqual([]);
    await store.close();
  });

  for (const b of BACKENDS) {
    it(`${b.name}: schemaVersion after migrate() reports the latest version`, async () => {
      const { store } = await b.make();
      const v = await store.schemaVersion();
      expect(v.applied).toBe(v.latest);
      expect(v.latest).toBeGreaterThan(0);
    });
  }
});

describe("health: messages pass through the Withholder", () => {
  it("canary: a secret value planted in the secret file is not in the API response or the page", async () => {
    const canary = `canary-${randomBytes(12).toString("hex")}`;
    const { loaded } = await setupDoctor({ fileExtra: `GITHUB_TOKEN=${canary}\n` });
    const { port } = await uiFor(loaded);
    for (const path of ["/api/health", "/", "/?health=refresh"]) {
      const body = (await get(port, path)).body;
      expect(body, path).not.toContain(canary);
    }
  });

  it("canary: a secret value in a check's error message is withheld from the API response and the page", async () => {
    const password = `pw-${randomBytes(12).toString("hex")}`;
    const { loaded } = await setupDoctor({
      mysqlPassword: password,
      version: new Error(`Access denied for user 'factory' using password ${password}`),
    });
    // The check itself carries the secret: only the Withholder keeps it off the page.
    expect((await doctorChecks(loaded)).some((c) => c.msg.includes(password))).toBe(true);

    const { port } = await uiFor(loaded);
    const api = await get(port, "/api/health");
    expect(api.body).not.toContain(password);
    const report = JSON.parse(api.body) as { checks: { status: string; msg: string }[] };
    expect(report.checks).toContainEqual({ status: "fail", msg: "[withheld: known_secret]" });
    const page = await get(port, "/");
    expect(page.body).not.toContain(password);
    expect(section(page.body, "health")).toMatch(/<td><strong>FAIL<\/strong><\/td><td><strong>\[withheld: known_secret\]<\/strong><\/td>/);
  });
});

describe("health: at most one run per 60 seconds per UI process", () => {
  /** A run function that counts calls and finishes when `release` is called. */
  function gated() {
    let n = 0;
    let release: () => void = () => undefined;
    const run = async (): Promise<Check[]> => {
      n++;
      await new Promise<void>((r) => (release = r));
      return [{ ok: true, msg: `run ${n}` }];
    };
    return { run, count: () => n, release: () => release() };
  }

  async function page(run: () => Promise<Check[]>) {
    const clock = new FakeClock();
    const store = new SqlFactoryStore(new SqliteDriver(":memory:"), clock);
    await store.migrate();
    const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 60_000, prUrl: () => "https://x/1", health: new HealthMonitor(run, clock) };
    return { port: d, clock };
  }

  it("page loads, the refresh link and the API share one run per 60 s", async () => {
    let n = 0;
    const { port, clock } = await page(async () => [{ ok: true, msg: `run ${++n}` }]);
    await get(port, "/");
    await get(port, "/?health=refresh");
    await get(port, "/api/health");
    await get(port, "/");
    expect(n).toBe(1);

    clock.advance(HEALTH_MIN_INTERVAL_MS - 1);
    const limited = section((await get(port, "/?health=refresh")).body, "health");
    expect(n).toBe(1); // refresh does not bypass the limit
    expect(limited).toContain("run 1");
    expect(limited).toContain("next run possible in 1s");

    clock.advance(1);
    const fresh = await get(port, "/?health=refresh");
    expect(n).toBe(2);
    expect(section(fresh.body, "health")).toContain("run 2");
    expect(section(fresh.body, "health")).toContain(`Last run ${clock.now().toISOString()}`);
    expect(JSON.parse((await get(port, "/api/health")).body).checks).toEqual([{ status: "ok", msg: "run 2" }]);
    expect(n).toBe(2);
  });

  it("requests that arrive during a run wait for it and start no other", async () => {
    const g = gated();
    const { port, clock } = await page(g.run);
    const pending = [get(port, "/"), get(port, "/api/health"), get(port, "/?health=refresh")];
    await vi.waitFor(() => expect(g.count()).toBe(1));
    clock.advance(2 * HEALTH_MIN_INTERVAL_MS); // even past the limit, a running check is shared
    pending.push(get(port, "/api/health"));
    await new Promise((r) => setTimeout(r, 20));
    expect(g.count()).toBe(1);
    g.release();
    const results = await Promise.all(pending);
    expect(g.count()).toBe(1);
    for (const r of results) expect(r.body).toContain("run 1");
  });

  it("a run that throws shows one FAIL and still counts toward the limit", async () => {
    let n = 0;
    const { port } = await page(async () => {
      n++;
      throw new Error("GitHub GET /labels → 500");
    });
    const report = JSON.parse((await get(port, "/api/health")).body) as { checks: unknown[] };
    expect(report.checks).toEqual([{ status: "fail", msg: "health checks could not finish: GitHub GET /labels → 500" }]);
    await get(port, "/");
    expect(n).toBe(1);
  });
});
