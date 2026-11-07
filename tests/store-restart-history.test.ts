import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RESTART_WINDOW_MS, detectAlarms } from "../src/core/alarms.js";
import { ALARM_DEFAULTS, type FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { INLINE_STEPS, STEPS_DIR, readSteps } from "../src/impl/store/mysql/migrations.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { ChildRestart } from "../src/interfaces/updater.js";
import { cleanScanner, config, FakeAuth, silent } from "./helpers/fakes.js";
import { BACKENDS, issue, system } from "./helpers/store.js";

// Restart history (design 05-restarts): one store row per child restart, written by one conditional insert, so
// the restart alarm's count and window survive a restart of the factory. Never pin a step as the newest.
const STEP = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS child_restarts")) + 1;
const STEP_FILE = `${String(STEP).padStart(4, "0")}-child-restarts.sql`;
const MIN = 60_000;

/** `n` restarts `gap_ms` apart, ending at `clock`'s now, with reasons r1, r2, … */
function restarts(clock: FakeClock, n: number, gap_ms = 5 * MIN): ChildRestart[] {
  const now = clock.now().getTime();
  return Array.from({ length: n }, (_, i) => ({ at: new Date(now - (n - 1 - i) * gap_ms).toISOString(), reason: `r${i + 1}` }));
}

const restartAlarm = (list: readonly ChildRestart[], now: Date) =>
  detectAlarms({ runs: [], restarts: list, now, settings: ALARM_DEFAULTS }).find((f) => f.pattern === "child_restarts");

describe("restart history: the alarm's count and window survive a reopened store (SQLite file)", () => {
  it("reads the same restarts, count and window after the store is closed and opened again", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sf-restarts-")), "factory.db");
    const clock = new FakeClock();
    const list = restarts(clock, 5);
    const before = new SqlFactoryStore(new SqliteDriver(path), clock);
    await before.migrate();
    for (const r of list) await before.recordChildRestart(r);
    const stored = await before.listChildRestartsWithin(RESTART_WINDOW_MS);
    expect(restartAlarm(stored, clock.now())).toMatchObject({ count: 5, detail: "r5" });
    await before.close();

    const after = new SqlFactoryStore(new SqliteDriver(path), clock);
    await after.migrate();
    try {
      const reopened = await after.listChildRestartsWithin(RESTART_WINDOW_MS);
      expect(reopened).toEqual(stored);
      expect(reopened).toEqual(list);
      expect(restartAlarm(reopened, clock.now())).toEqual(restartAlarm(stored, clock.now()));
      // The window moves with the store's clock: past it, the oldest restart drops out and the alarm with it.
      clock.advance(RESTART_WINDOW_MS - 20 * MIN + 1);
      expect((await after.listChildRestartsWithin(RESTART_WINDOW_MS)).map((r) => r.reason)).toEqual(["r2", "r3", "r4", "r5"]);
    } finally {
      await after.close();
    }
  });
});

for (const b of BACKENDS) {
  describe(`${b.name}: restart history in the alarm step`, () => {
    it("the controller stores this host's restarts once per restart, however often it reads the same list", async () => {
      const { store, clock } = await b.make();
      const list = restarts(clock, 3);
      const c = new Controller({ store, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, restarts: async () => list });
      await c.tickAlarms();
      await c.tickAlarms();
      expect(await store.listChildRestartsWithin(RESTART_WINDOW_MS)).toEqual(list);
    });

    it("a process with no restart list of its own alarms on the stored restarts", async () => {
      const { store, clock } = await b.make();
      for (const r of restarts(clock, 5)) await store.recordChildRestart(r);
      const cfg: FactoryConfig = { ...config };
      await new Controller({ store, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner }).tickAlarms();
      expect(await store.listAlerts({ limit: 10 })).toMatchObject([{ pattern: "child_restarts", count: 5, detail: "r5" }]);
    });
  });
}

describe("SQLite migration: restart history", () => {
  it("adds an empty child_restarts table to an existing database and leaves its items and alerts as they were", async () => {
    expect(STEP).toBeGreaterThan(0);
    const path = join(mkdtempSync(join(tmpdir(), "sf-mig-restarts-")), "factory.db");
    const clock = new FakeClock();
    const seed = new SqlFactoryStore(new SqliteDriver(path), clock);
    await seed.migrate();
    const { item } = await seed.createWorkItem(issue(1), system);
    const { alert } = (await seed.recordAlert({ pattern: "child_restarts", pattern_key: "child_restarts", error_code: "child_restarts", count: 5, detail: "r5" }, 1)) as { alert: unknown };
    await seed.close();
    // Back to the state before the migration.
    const raw = new DatabaseSync(path);
    raw.exec(`DROP TABLE child_restarts; DELETE FROM schema_migrations WHERE version >= ${STEP};`);
    const dump = (db: DatabaseSync) => ({
      items: db.prepare("SELECT * FROM work_items").all().map((r) => ({ ...r })),
      alerts: db.prepare("SELECT * FROM alerts").all().map((r) => ({ ...r })),
    });
    const old = dump(raw);
    raw.close();

    const store = new SqlFactoryStore(new SqliteDriver(path), clock);
    await store.migrate();
    try {
      expect(await store.listChildRestartsWithin(RESTART_WINDOW_MS)).toEqual([]);
      expect(await store.getWorkItem(item.id)).toEqual(item);
      expect(await store.listAlerts({ limit: 10 })).toEqual([alert]);
    } finally {
      await store.close();
    }
    const again = new DatabaseSync(path);
    expect(dump(again)).toEqual(old);
    expect(again.prepare("SELECT COUNT(*) AS n FROM child_restarts").get()).toEqual({ n: 0 });
    again.close();
  });
});

describe("MySQL step: restart history (child-restarts)", () => {
  it("has the SQLite migration's number and creates the same table and index", () => {
    expect(readSteps(STEPS_DIR, INLINE_STEPS).find((s) => s.name === "child-restarts")).toMatchObject({
      number: STEP, from: STEP - 1, kind: "sql", file: STEP_FILE,
    });
    const sql = readFileSync(join(STEPS_DIR, STEP_FILE), "utf8");
    for (const c of ["CREATE TABLE IF NOT EXISTS child_restarts", "restart_key", "reason", "recorded_at", "KEY child_restarts_at (at)"]) expect(sql).toContain(c);
    for (const c of ["CREATE TABLE IF NOT EXISTS child_restarts", "restart_key", "reason", "recorded_at", "child_restarts_at ON child_restarts (at)"]) {
      expect(MIGRATIONS[STEP - 1]).toContain(c);
    }
  });
});
