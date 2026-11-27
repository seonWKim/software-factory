// Migrate now, Start and Restart now on the dashboard (design 08-self-update, 09-dashboard-app): POST /api/v1/migrate
// shows the dry run, then runs `npm run migrate`'s drain, apply, start-or-cancel sequence (withDrain); POST
// /api/v1/supervisor files start or restart. Each sits behind the write guards, the resume route's owner check and a
// confirm, and needs a live supervisor. No test calls GitHub or a model: the project-key step uses a fake resolver.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Loaded, loadConfig } from "../src/load-config.js";
import { buildUiParts } from "../src/compose.js";
import { OwnerAuth } from "../src/core/authorize.js";
import type { LogFields, Logger } from "../src/core/log.js";
import type { CliIdentity } from "../src/core/local-cli.js";
import type { ProjectRef } from "../src/core/project.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { PROJECT_TABLES, type ResolveRepo } from "../src/impl/store/project-keys.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { Clock } from "../src/interfaces/clock.js";
import { SUPERVISOR_REQUEST_FILE, SUPERVISOR_STATUS_FILE } from "../src/interfaces/updater.js";
import { HealthMonitor } from "../src/ui/health.js";
import { MIGRATE_PATH, SUPERVISOR_PATH, supervisorOffers, type UiMigrate } from "../src/ui/migrate-api.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type ServerDeps, type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { waitFor } from "./helpers/fakes/config.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const OWNER = "github:1" as UserId;
const STRANGER = "github:2" as UserId;
const SUPERVISOR = 99;
const CHILD = 7;
const KEY: ProjectRef = { key: PROJECT_KEY, label: "github.com/o/r" };

class MemLog implements Logger {
  lines: string[] = [];
  info(msg: string, _f?: LogFields) { this.lines.push(msg); }
  warn(msg: string, _f?: LogFields) { this.lines.push(msg); }
  error(msg: string, _f?: LogFields) { this.lines.push(msg); }
}

/** Real time, but a sleep only yields: withDrain's 1 s reread loop runs at once. */
const quickClock: Clock = { now: () => new Date(), sleep: () => new Promise((r) => setImmediate(r)) };

interface Setup {
  status?: Record<string, unknown> | null;
  alive?: number[];
  user?: UserId | null;
  topicTables?: () => Promise<void>;
}

async function setup(o: Setup = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sf-ui-migrate-"));
  const statusFile = join(dir, SUPERVISOR_STATUS_FILE);
  const requestFile = join(dir, SUPERVISOR_REQUEST_FILE);
  const writeStatus = (s: Record<string, unknown>) =>
    writeFileSync(statusFile, JSON.stringify({ state: "running", rev: "c1", target_rev: null, child_pid: CHILD, since: "x", supervisor_pid: SUPERVISOR, ...s }));
  if (o.status !== null) writeStatus(o.status ?? {});
  const alive = new Set(o.alive ?? [SUPERVISOR, CHILD]);
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  await store.claimOwner(OWNER);
  const auth = new OwnerAuth(store);
  const log = new MemLog();
  const pauses: UiPauses = {
    principal: async () => (o.user === undefined ? OWNER : o.user),
    authorize: (user_id) => auth.authorize({ user_id }, "approve_spec", { kind: "project", id: PROJECT_KEY }),
    csrfToken: newCsrfToken(),
    log,
  };
  const resolved: string[] = [];
  const resolveRepo = async (): Promise<ResolveRepo> => async (ownerName) => (resolved.push(ownerName), KEY);
  const migrate: UiMigrate = {
    stateDir: dir, clock: quickClock, runTimeoutMs: 60_000, log, running: null, pidAlive: (pid) => alive.has(pid),
    topicTables: o.topicTables ?? (async () => undefined), resolveRepo,
  };
  const d: ServerDeps = {
    store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses, migrate,
  };
  const request = () => (existsSync(requestFile) ? (JSON.parse(readFileSync(requestFile, "utf8")) as { action: string; at: string }) : null);
  return { dir, d, pauses, migrate, log, resolved, writeStatus, request, requestFile };
}

function post(p: UiPauses, url: string, body: unknown, over: Partial<UiRequest> = {}): UiRequest {
  return { method: "POST", url, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: p.csrfToken, body: JSON.stringify(body), ...over };
}

const parse = (r: { body: string }) => JSON.parse(r.body);

/** The supervisor's side of the handshake: reads and removes each request, answering a drain with migration_ready. */
async function supervisorAnswers(s: Awaited<ReturnType<typeof setup>>): Promise<string> {
  await waitFor(() => s.request()?.action === "drain", "drain request", 200, 20_000);
  rmSync(s.requestFile);
  s.writeStatus({ state: "migration_ready", child_pid: null, target_rev: "c2" });
  await waitFor(() => s.request() !== null, "start or cancel request", 200, 20_000);
  return s.request()!.action;
}

/** A database whose one work item still holds `o/r` as its project: the project-key step has a row to change. */
async function legacyDb(dir: string) {
  mkdirSync(join(dir, "db"));
  const driver = new SqliteDriver(join(dir, "db", "factory.db"));
  await driver.migrate();
  await new SqlFactoryStore(driver, new FakeClock()).createWorkItem({ ...issue(1), project: PROJECT_KEY }, system);
  for (const t of PROJECT_TABLES) await driver.run(`UPDATE ${t} SET project = ? WHERE project = ?`, ["o/r", PROJECT_KEY]);
  await driver.close();
}

describe("Migrate now (POST /api/v1/migrate)", { timeout: 30_000 }, () => {
  it("without the confirm shows the dry run (the pending steps and each change) and files nothing", async () => {
    const s = await setup({ status: { state: "migration_pending", target_rev: "c2" } });
    await legacyDb(s.dir);
    const r = await respond(s.d, post(s.pauses, MIGRATE_PATH, {}));
    expect(r.status).toBe(200);
    const { dry_run } = parse(r);
    expect(dry_run.ok).toBe(true);
    expect(dry_run.pending).toEqual(["project keys (1 row)"]);
    expect(dry_run.lines).toContain("-- project keys: 1 row would change");
    expect(dry_run.lines.some((l: string) => l.includes('"from":"o/r"') && l.includes(PROJECT_KEY))).toBe(true);
    expect(dry_run.lines.at(-1)).toBe("dry run: nothing was changed");
    expect(s.resolved).toEqual(["o/r"]);
    expect(s.request()).toBeNull();
  });

  it("with the confirm files a drain, waits for migration_ready, applies the steps and files start", async () => {
    const s = await setup({ status: { state: "migration_pending", target_rev: "c2" } });
    const r = await respond(s.d, post(s.pauses, MIGRATE_PATH, { confirm: true }));
    expect(r.status).toBe(202);
    const run = s.migrate.running; // reset to null once the sequence ends
    expect(await supervisorAnswers(s)).toBe("start");
    expect(await run).toBe(0);
    expect(existsSync(join(s.dir, "db", "factory.db"))).toBe(true);
    expect(s.log.lines).toContain("drained: no factory process runs; applying the steps");
  });

  it("a failed step files cancel, so the old revision starts again", async () => {
    const s = await setup({ status: { state: "migration_pending", target_rev: "c2" }, topicTables: async () => { throw new Error("disk full"); } });
    expect((await respond(s.d, post(s.pauses, MIGRATE_PATH, { confirm: true }))).status).toBe(202);
    const run = s.migrate.running;
    expect(await supervisorAnswers(s)).toBe("cancel");
    expect(await run).toBe(1);
    expect(s.log.lines).toContain("migrate now: the steps failed");
  });

  it("is refused in plain words, writing no file, when no supervisor is live", async () => {
    for (const s of [await setup({ status: null }), await setup({ alive: [CHILD] }), await setup({ status: { state: "stopped" } })]) {
      for (const body of [{}, { confirm: true }]) {
        const r = await respond(s.d, post(s.pauses, MIGRATE_PATH, body));
        expect(r.status).toBe(409);
        expect(parse(r).error).toMatch(/^No factory supervisor is running/);
        expect(parse(r).error).not.toContain("npm run");
      }
      const view = parse(await respond(s.d, { method: "GET", url: SUPERVISOR_PATH, host: HOST }));
      expect(view).toMatchObject({ live: false, migrate: { offered: false }, start: { offered: false }, restart: { offered: false } });
      expect(s.request()).toBeNull();
      expect(existsSync(join(s.dir, "db"))).toBe(false);
    }
  });

  it("is refused while a migration is under way", async () => {
    const s = await setup({ status: { state: "migration_draining", child_pid: null } });
    const r = await respond(s.d, post(s.pauses, MIGRATE_PATH, { confirm: true }));
    expect(r.status).toBe(409);
    expect(parse(r).error).toMatch(/migration is under way/);
    expect(s.request()).toBeNull();
  });
});

describe("a factory running in place (none updater: a live child, no supervisor_pid)", () => {
  const CHECKOUT = "Running from your checkout. To update, stop `factory dev`, pull, and start it again.";
  const inPlace = () => setup({ status: { supervisor_pid: undefined }, alive: [CHILD] });

  it("gives the checkout reason for all three offers, not the start message", async () => {
    const s = await inPlace();
    const o = await supervisorOffers(s.migrate);
    expect(o).toMatchObject({ live: false, migrate: { offered: false, reason: CHECKOUT }, start: { offered: false, reason: CHECKOUT }, restart: { offered: false, reason: CHECKOUT } });
    expect(JSON.stringify(o)).not.toContain("No factory supervisor is running");
    expect(JSON.stringify(o)).not.toContain("Start the factory from a terminal");
    const view = parse(await respond(s.d, { method: "GET", url: SUPERVISOR_PATH, host: HOST }));
    expect(view.migrate.reason).toBe(CHECKOUT);
  });

  it("refuses the POSTs with the same reason and files nothing", async () => {
    const s = await inPlace();
    const calls = [
      post(s.pauses, MIGRATE_PATH, { confirm: true }),
      post(s.pauses, SUPERVISOR_PATH, { action: "start", confirm: true }),
      post(s.pauses, SUPERVISOR_PATH, { action: "restart", confirm: true }),
    ];
    for (const c of calls) {
      const r = await respond(s.d, c);
      expect(r.status).toBe(409);
      expect(parse(r).error).toBe(CHECKOUT);
    }
    expect(s.request()).toBeNull();
  });

  it("keeps the start message when no process runs", async () => {
    const s = await setup({ status: { supervisor_pid: undefined }, alive: [] });
    const o = await supervisorOffers(s.migrate);
    expect(o.start.reason).toMatch(/^No factory supervisor is running, so this page cannot reach it\. Start the factory from a terminal with factory dev\.$/);
  });
});

describe("Start and Restart now (POST /api/v1/supervisor)", () => {
  it("Start is offered only when a supervisor is live and no child claims; it files a start request", async () => {
    const s = await setup({ status: { state: "crashed", child_pid: null } });
    expect(parse(await respond(s.d, { method: "GET", url: SUPERVISOR_PATH, host: HOST }))).toMatchObject({
      live: true, csrf_token: s.pauses.csrfToken, start: { offered: true, reason: null }, restart: { offered: false, reason: "No factory process runs: use Start." },
    });
    const r = await respond(s.d, post(s.pauses, SUPERVISOR_PATH, { action: "start", confirm: true }));
    expect(r.status).toBe(202);
    expect(s.request()).toMatchObject({ action: "start" });
    expect(Number.isNaN(Date.parse(s.request()!.at))).toBe(false);
  });

  it("Start is refused, in plain words and writing nothing, while a child claims or no supervisor is live", async () => {
    const claims = await setup();
    const r = await respond(claims.d, post(claims.pauses, SUPERVISOR_PATH, { action: "start", confirm: true }));
    expect(r.status).toBe(409);
    expect(parse(r).error).toBe("A factory process already runs and claims work: use Restart now for a fresh one.");
    expect(claims.request()).toBeNull();
    const gone = await setup({ status: { state: "crashed", child_pid: null }, alive: [] });
    const g = await respond(gone.d, post(gone.pauses, SUPERVISOR_PATH, { action: "start", confirm: true }));
    expect(g.status).toBe(409);
    expect(parse(g).error).toMatch(/^No factory supervisor is running/);
    expect(gone.request()).toBeNull();
  });

  it("Restart now files a restart request with the same body shape as migrate's request", async () => {
    const s = await setup();
    expect(parse(await respond(s.d, { method: "GET", url: SUPERVISOR_PATH, host: HOST })).restart).toEqual({ offered: true, reason: null });
    const r = await respond(s.d, post(s.pauses, SUPERVISOR_PATH, { action: "restart", confirm: true }));
    expect(r.status).toBe(202);
    expect(Object.keys(s.request()!).sort()).toEqual(["action", "at"]);
    expect(s.request()!.action).toBe("restart");
  });

  it("Start and Restart now are refused while an update waits for its migration", async () => {
    const s = await setup({ status: { state: "migration_pending", target_rev: "c2" } });
    for (const action of ["start", "restart"]) {
      const r = await respond(s.d, post(s.pauses, SUPERVISOR_PATH, { action, confirm: true }));
      expect(r.status).toBe(409);
      expect(parse(r).error).toBe("An update waits for its migration: use Migrate now first.");
    }
    expect(s.request()).toBeNull();
  });
});

describe("the guards of Migrate now, Start and Restart now", () => {
  it("a POST without the confirm writes nothing (Start and Restart now answer 400; Migrate now only shows its dry run)", async () => {
    const s = await setup({ status: { state: "crashed", child_pid: null } });
    for (const action of ["start", "restart"]) {
      for (const body of [{ action }, { action, confirm: "yes" }, { action, confirm: false }]) {
        const r = await respond(s.d, post(s.pauses, SUPERVISOR_PATH, body));
        expect(r.status).toBe(400);
        expect(parse(r).error).toMatch(/asks for a confirm first; nothing was filed/);
      }
    }
    expect((await respond(s.d, post(s.pauses, MIGRATE_PATH, { confirm: "yes" }))).status).toBe(200);
    expect(s.request()).toBeNull();
    expect(s.migrate.running).toBeNull();
  });

  it("refuses a request without the CSRF token, a foreign Origin or another Content-Type before anything is read", async () => {
    const s = await setup({ status: { state: "crashed", child_pid: null } });
    for (const url of [MIGRATE_PATH, SUPERVISOR_PATH]) {
      const body = { action: "start", confirm: true };
      const noToken = await respond(s.d, post(s.pauses, url, body, { csrfToken: undefined }));
      expect(noToken.status).toBe(403);
      expect(parse(noToken).code).toBe("stale_csrf");
      expect((await respond(s.d, post(s.pauses, url, body, { origin: "http://evil.example" }))).status).toBe(403);
      expect((await respond(s.d, post(s.pauses, url, body, { contentType: "text/plain" }))).status).toBe(415);
      expect((await respond(s.d, post(s.pauses, url, body, { host: "evil.example" }))).status).toBe(403);
    }
    expect(s.request()).toBeNull();
    expect(s.migrate.running).toBeNull();
  });

  it("checks the owner as the resume route does: a stranger or no factory user is refused", async () => {
    for (const user of [STRANGER, null]) {
      const s = await setup({ status: { state: "crashed", child_pid: null }, user });
      for (const [url, body] of [[MIGRATE_PATH, { confirm: true }], [SUPERVISOR_PATH, { action: "start", confirm: true }]] as const) {
        expect((await respond(s.d, post(s.pauses, url, body))).status).toBe(403);
      }
      expect(s.request()).toBeNull();
      expect(s.migrate.running).toBeNull();
    }
  });

  it("without Migrate now's parts the routes are not wired: POST is a 405 and GET a 404", async () => {
    const s = await setup();
    const { migrate: _m, ...unwired } = s.d;
    expect((await respond(unwired, post(s.pauses, SUPERVISOR_PATH, { action: "restart", confirm: true }))).status).toBe(405);
    expect((await respond(unwired, post(s.pauses, MIGRATE_PATH, { confirm: true }))).status).toBe(405);
    expect((await respond(unwired, { method: "GET", url: SUPERVISOR_PATH, host: HOST })).status).toBe(404);
    expect(s.request()).toBeNull();
  });
});

describe("ui wiring: buildUiParts supplies Migrate now's parts and the ui command passes them", () => {
  const REPO_ROOT = join(import.meta.dirname, "..");
  const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
  const ME: CliIdentity = { user: "local:me@example.com" as UserId, from: "git user.email" };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function loaded(): Promise<Loaded> {
    const dir = mkdtempSync(join(tmpdir(), "sf-ui-migrate-wiring-"));
    mkdirSync(join(dir, "prompts"));
    for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
    writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...REAL, store: { type: "sqlite" } }));
    mkdirSync(join(dir, "secrets"));
    writeFileSync(join(dir, "secrets", ".env"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
    return loadConfig(dir);
  }

  it("the parts carry the state dir, clock, run_timeout_ms and the migrate steps, and the ui command hands them to startUi", async () => {
    const l = await loaded();
    const parts = await buildUiParts(l, { identity: ME });
    try {
      expect(parts.migrate).toMatchObject({ stateDir: l.stateDir, runTimeoutMs: l.config.run_timeout_ms, running: null });
      expect(parts.migrate.clock).toBe(parts.clock);
      expect(typeof parts.migrate.topicTables).toBe("function");
      expect(typeof parts.migrate.resolveRepo).toBe("function");
    } finally {
      await parts.close();
    }
    const command = readFileSync(join(REPO_ROOT, "src/cli/handlers/ui/ui.command.ts"), "utf8");
    expect(command.slice(command.indexOf("startUi("))).toContain("migrate: parts.migrate,");
  });
});
