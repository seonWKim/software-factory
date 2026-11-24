// Dismissing an alarm (design 05-alarms, 2026-11-24): the store records the time and the actor ID on the alert's
// pattern (migration 20261123T1201-state-alert-dismissals); openAlarms hides the alarm; its pattern counts only runs
// that finished after the dismissal, and a new alert of it is stored at once. `factory alarm dismiss <id>` and POST
// /api/v1/alarms/dismiss both pass the owner check of POST /api/v1/pauses/resume. Holds are not lifted.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCommands } from "../src/cli/index.js";
import { ALERT_DEDUPE_MS, alarmStep, detectAlarms } from "../src/core/alarms.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { ALARM_DEFAULTS, STALL_DEFAULTS } from "../src/core/config.js";
import type { CliEnvironment } from "../src/core/local-cli.js";
import type { LogFields, Logger } from "../src/core/log.js";
import { patternKey } from "../src/core/improver.js";
import { RECURRING_FAILURE, type RunKind, type RunOutcome, type UserId, type WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { Alert, FactoryStore } from "../src/interfaces/factory-store.js";
import type { Loaded } from "../src/load-config.js";
import { REGISTRY } from "../src/plugins.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import migration from "../src/state/migrations/20261123T1201-state-alert-dismissals.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver } from "../src/state/index.js";
import { openAlarms } from "../src/ui/alarms.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type PauseDeps, type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { systemActions } from "../src/ui/system-actions.js";
import { cleanScanner, config, silent } from "./helpers/fakes/config.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

const MIN = 60_000;
const OWNER = "local:me@example.com" as UserId;
const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, model: null };
const boom = (): RunOutcome => ({ status: "failed", error_code: "checks_failed", detail: "npm test exited 1: boom", infra: false, usage: USAGE });
const KEY = `repeated_error:${patternKey({ error_code: "checks_failed", detail: "npm test exited #: boom" })}`;

class MemLog implements Logger {
  lines: { msg: string; fields?: LogFields | undefined }[] = [];
  info(msg: string, fields?: LogFields) { this.lines.push({ msg, fields }); }
  warn(msg: string, fields?: LogFields) { this.lines.push({ msg, fields }); }
  error(msg: string, fields?: LogFields) { this.lines.push({ msg, fields }); }
}

let next = 1;
/** Fails `n` runs of the boom pattern, each on a new item, one minute apart. */
async function burst(store: FactoryStore, clock: FakeClock, n: number) {
  const items = [];
  for (let i = 0; i < n; i++) {
    clock.advance(MIN);
    const k = next++;
    const kind: RunKind = "implement";
    const { item } = await store.createWorkItem(issue(1000 + k), system);
    await store.enqueueRun({ work_item_id: item.id, kind, idempotency_key: `d${k}` });
    const run = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: [kind], lease_ms: 60_000 }))!;
    await store.completeRun(run.id, run.lease!.token, boom());
    items.push(item.id);
  }
  return items;
}

const controller = (store: FactoryStore, clock: FakeClock) =>
  new ControllerRole({ store, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, source: new FakeSource() });
const alertsOf = async (store: FactoryStore, key: string) => (await store.listAlerts({ limit: 50 })).filter((a) => a.pattern_key === key);

/** A store with one repeated-error alarm raised by the controller's alarm step (it holds its three items). */
async function raised() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const c = controller(store, clock);
  const items = await burst(store, clock, 3);
  await c.tickAlarms();
  const [alert] = await alertsOf(store, KEY);
  expect(alert).toBeDefined();
  return { store, clock, c, items, alert: alert! };
}

describe("migration 20261123T1201-state-alert-dismissals", () => {
  const ID = "20261123T1201-state-alert-dismissals";
  const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
  const columns = async (db: SqlDriver) => (await db.all("PRAGMA table_info(controller_alert_patterns)")).map((r) => String(r.name));

  it("adds nullable dismissed_at and dismissed_by, backfills nothing and is safe to rerun", async () => {
    const { store } = await newStore();
    await store.recordAlert({ pattern: "zero_tokens", pattern_key: "zero_tokens", error_code: "zero_tokens", count: 3, detail: null }, ALERT_DEDUPE_MS);
    const db = store.db;
    await db.run("ALTER TABLE controller_alert_patterns DROP COLUMN dismissed_at");
    await db.run("ALTER TABLE controller_alert_patterns DROP COLUMN dismissed_by");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive" });
    await migration.up(mdb(db));
    expect(await columns(db)).toEqual(expect.arrayContaining(["dismissed_at", "dismissed_by"]));
    expect(await db.all("SELECT pattern_key, dismissed_at, dismissed_by FROM controller_alert_patterns"))
      .toEqual([{ pattern_key: "zero_tokens", dismissed_at: null, dismissed_by: null }]);
  });
});

describe("dismissing an alarm", () => {
  it("records the time and the actor ID on the pattern, hides the alarm, and the overview's rows carry alert_id", async () => {
    const { store, clock, alert } = await raised();
    const before = await systemActions({ store, factory: null, deps: {}, now: clock.now(), dashboardRev: null });
    expect(before.filter((a) => a.code === "alarm")).toContainEqual(expect.objectContaining({ alert_id: alert.id, pattern: "repeated_error" }));
    clock.advance(MIN);
    const r = await store.dismissAlert(alert.id, OWNER);
    expect(r).toEqual({ pattern_key: KEY, dismissed: true, dismissed_at: clock.now().toISOString() });
    expect(await store.db.all("SELECT dismissed_at, dismissed_by FROM controller_alert_patterns WHERE pattern_key = ?", [KEY]))
      .toEqual([{ dismissed_at: clock.now().toISOString(), dismissed_by: OWNER }]);
    expect((await openAlarms(store, clock.now())).map((a) => a.id)).not.toContain(alert.id);
    const after = await systemActions({ store, factory: null, deps: {}, now: clock.now(), dashboardRev: null });
    expect(after.filter((a) => a.code === "alarm").map((a) => a.alert_id)).not.toContain(alert.id);
  });

  it("does not lift the holds of the alarm's items", async () => {
    const { store, clock, items, alert } = await raised();
    for (const id of items) expect(await store.getWorkItem(id)).toMatchObject({ blocked_on: "human", blocked_reason: RECURRING_FAILURE });
    clock.advance(MIN);
    await store.dismissAlert(alert.id, OWNER);
    for (const id of items) expect(await store.getWorkItem(id)).toMatchObject({ blocked_on: "human", blocked_reason: RECURRING_FAILURE });
  });

  it("counts only runs that finished after the dismissal; enough of them store a new alert at once, inside the dedupe window", async () => {
    const { store, clock, c, alert } = await raised();
    clock.advance(MIN);
    await store.dismissAlert(alert.id, OWNER);
    // Two new failures with three older ones in the window: the older ones no longer count.
    await burst(store, clock, 2);
    await c.tickAlarms();
    expect((await alertsOf(store, KEY)).map((a) => a.id)).toEqual([alert.id]);
    expect(await openAlarms(store, clock.now())).not.toContainEqual(expect.objectContaining({ pattern_key: KEY }));
    // A third: the alarm is back, well before the six-hour window ends.
    await burst(store, clock, 1);
    await c.tickAlarms();
    const [back] = await alertsOf(store, KEY);
    expect(back).toMatchObject({ count: 3 });
    expect(back!.id).not.toBe(alert.id);
    expect(Date.parse(back!.created_at) - Date.parse(alert.created_at)).toBeLessThan(ALERT_DEDUPE_MS);
    expect((await openAlarms(store, clock.now())).map((a) => a.id)).toContain(back!.id);
  });

  it("the re-raise counts only runs after the dismissal of the re-raised alarm", async () => {
    const { store, clock, c } = await raised();
    const recurring = KEY.replace("repeated_error:", "recurring:");
    await burst(store, clock, 3);
    await c.tickAlarms();
    const [first] = await alertsOf(store, recurring);
    expect(first).toBeDefined();
    clock.advance(RERAISE_HOUR);
    await burst(store, clock, 2);
    await store.dismissAlert(first!.id, OWNER);
    await burst(store, clock, 2);
    await c.tickAlarms();
    expect(await alertsOf(store, recurring)).toHaveLength(1);
    await burst(store, clock, 1);
    await c.tickAlarms();
    expect((await alertsOf(store, recurring))[0]).toMatchObject({ count: 3 });
  });

  it("detectAlarms leaves out zero-token runs and restarts from before their pattern's dismissal", () => {
    const now = new Date("2026-01-01T02:00:00.000Z");
    const at = (m: number) => new Date(now.getTime() - m * MIN).toISOString();
    const run = (id: string, m: number) => ({ id, work_item_id: id, kind: "implement", status: "succeeded", finished_at: at(m), outcome: { status: "succeeded", summary: "", data: {} } }) as never;
    const s = { ...ALARM_DEFAULTS, alarm_repeat_count: 3, alarm_restart_count: 3 };
    const runs = [run("a", 3), run("b", 2), run("c", 1)];
    const restarts = [{ at: at(3), reason: "r1" }, { at: at(2), reason: "r2" }, { at: at(1), reason: "r3" }];
    expect(detectAlarms({ runs, restarts, now, settings: s }).map((f) => f.pattern)).toEqual(["zero_tokens", "child_restarts"]);
    const dismissed = new Map([["zero_tokens", Date.parse(at(2))], ["child_restarts", Date.parse(at(2))]]);
    expect(detectAlarms({ runs, restarts, now, settings: s, dismissed })).toEqual([]);
  });

  it("a dismissed spend threshold does not alert again in its period", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const deps = { store, scanner: cleanScanner, clock, log: silent, project: PROJECT_KEY };
    const settings = { ...ALARM_DEFAULTS, probe_interval_ms: STALL_DEFAULTS.probe_interval_ms, spend: { daily_usd: 0, weekly_usd: null } };
    const [spend] = (await alarmStep(deps, settings)).filter((a: Alert) => a.pattern === "spend_budget");
    expect(spend).toBeDefined();
    clock.advance(MIN);
    await store.dismissAlert(spend!.id, OWNER);
    clock.advance(MIN);
    expect((await alarmStep(deps, settings)).filter((a) => a.pattern_key === spend!.pattern_key)).toEqual([]);
  });
});

const RERAISE_HOUR = 60 * MIN;

describe("factory alarm dismiss", () => {
  afterEach(() => vi.restoreAllMocks());
  const FIXED: CliEnvironment = { gitEmail: "Me@Example.com", osUser: "os-login" };

  async function command(store: FactoryStore, ...args: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "sf-alarm-"));
    const loaded = {
      root: dir, stateDir: dir, file: {}, config: { repo: { owner: "o", name: "r" }, local_only: true }, registry: REGISTRY, plugins: { clock: "system" },
    } as unknown as Loaded;
    const kept = new Proxy(store, { get: (t, k) => (k === "close" ? async () => {} : Reflect.get(t, k, t)) });
    const out: string[] = [], logs: Record<string, unknown>[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void out.push(l));
    vi.spyOn(console, "error").mockImplementation((l: string) => void out.push(l));
    vi.spyOn(process.stderr, "write").mockImplementation((l: string | Uint8Array) => (logs.push(JSON.parse(String(l)) as Record<string, unknown>), true));
    const cmd = (await loadCommands()).get("alarm")!;
    const code = await cmd.run(args, { name: "alarm", usage: "", load: async () => loaded, environment: async () => FIXED, openStore: async () => kept });
    vi.restoreAllMocks();
    return { code, out, logs };
  }

  it("dismisses as the CLI identity's user ID (git user.email before the OS user); a second dismiss says so", async () => {
    const { store, alert } = await raised();
    const r = await command(store, "dismiss", alert.id);
    expect(r).toMatchObject({ code: 0, out: [`dismissed the alarm ${alert.id} (${KEY}) as ${OWNER}`] });
    expect(await store.listAlertDismissals(alert.created_at)).toEqual([expect.objectContaining({ pattern_key: KEY, dismissed_by: OWNER })]);
    expect((await command(store, "dismiss", alert.id)).out[0]).toContain("already dismissed");
    expect(await command(store, "dismiss", "al_nope")).toMatchObject({ code: 1, out: ["no alert al_nope"] });
  });

  it("refuses a bad argument and an identity the owner check refuses, writing nothing", async () => {
    const { store, alert } = await raised();
    await store.claimOwner("local:owner@example.com" as UserId);
    expect(await command(store, "dismiss")).toMatchObject({ code: 1, out: ["usage: factory alarm dismiss <alert id>"] });
    expect(await command(store, "dismiss", alert.id)).toMatchObject({ code: 1, out: ["not dismissed: not_owner"], logs: [] });
    expect(await store.listAlertDismissals(alert.created_at)).toEqual([]);
  });
});

describe("POST /api/v1/alarms/dismiss", () => {
  const HOST = "127.0.0.1:4310";
  const ADMIN = "github:1" as UserId;

  async function page(user: UserId) {
    const { store, clock, alert } = await raised();
    await store.claimOwner(ADMIN);
    const auth = new OwnerAuth(store);
    const log = new MemLog();
    const pauses: UiPauses = {
      principal: async () => user,
      authorize: (user_id) => auth.authorize({ user_id }, "approve_spec", { kind: "project", id: PROJECT_KEY }),
      csrfToken: newCsrfToken(),
      log,
    };
    const d: PauseDeps = {
      store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses,
    };
    const post = (body: unknown): UiRequest => ({
      method: "POST", url: "/api/v1/alarms/dismiss", host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: pauses.csrfToken, body: JSON.stringify(body),
    });
    return { d, store, clock, log, post, alert };
  }

  it("dismisses as the owner: the pattern keeps the page user's ID, one log line, and the alarm leaves the overview", async () => {
    const p = await page(ADMIN);
    const r = await respond(p.d, p.post({ alert_id: p.alert.id }));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ alert_id: p.alert.id, pattern_key: KEY, dismissed: true, dismissed_at: p.clock.now().toISOString() });
    expect(await p.store.listAlertDismissals(p.alert.created_at)).toEqual([{ pattern_key: KEY, dismissed_at: p.clock.now().toISOString(), dismissed_by: ADMIN }]);
    expect(p.log.lines).toEqual([{ msg: "alarm dismissed", fields: { alert_id: p.alert.id, actor: ADMIN, dismissed: true } }]);
    const overview = JSON.parse((await respond(p.d, { method: "GET", url: "/api/v1/overview", host: HOST })).body) as { system_actions: { alert_id?: string }[] };
    expect(overview.system_actions.map((a) => a.alert_id)).not.toContain(p.alert.id);
  });

  it("a page user the owner check refuses gets 403 and nothing is written", async () => {
    const p = await page("github:2" as UserId);
    const r = await respond(p.d, p.post({ alert_id: p.alert.id }));
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toContain("approve_spec");
    expect(await p.store.listAlertDismissals(p.alert.created_at)).toEqual([]);
    expect(p.log.lines).toEqual([]);
  });

  it("passes the request guards first: a stale CSRF token, a foreign origin or a non-JSON body is refused before the store", async () => {
    const p = await page(ADMIN);
    expect((await respond(p.d, { ...p.post({ alert_id: p.alert.id }), csrfToken: "stale" })).status).toBe(403);
    expect((await respond(p.d, { ...p.post({ alert_id: p.alert.id }), origin: "http://evil.example" })).status).toBe(403);
    expect((await respond(p.d, { ...p.post({ alert_id: p.alert.id }), contentType: "text/plain" })).status).toBe(415);
    expect((await respond(p.d, p.post({}))).status).toBe(400);
    expect((await respond(p.d, p.post({ alert_id: "al_nope" }))).status).toBe(404);
    expect(await p.store.listAlertDismissals(p.alert.created_at)).toEqual([]);
  });
});
