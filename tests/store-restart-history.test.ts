import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RESTART_WINDOW_MS, detectAlarms } from "../src/core/alarms.js";
import { ALARM_DEFAULTS, type FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { INLINE_STEPS, STEPS_DIR, readSteps } from "../src/impl/store/mysql/migrations.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { ChildRestart } from "../src/interfaces/updater.js";
import dropRecordedAt from "../src/runtime/migrations/20261109T1401-runtime-drop-restart-recorded-at.migration.js";
import { tableColumns, type MigrationDb } from "../src/state/index.js";
import { cleanScanner, config, FakeAuth, silent } from "./helpers/fakes.js";
import { BACKENDS, issue, newStore, system } from "./helpers/store.js";

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
      const c = new ControllerRole({ store, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, restarts: async () => list });
      await c.tickAlarms();
      await c.tickAlarms();
      expect(await store.listChildRestartsWithin(RESTART_WINDOW_MS)).toEqual(list);
    });

    it("stores only restart_key, at and reason; the same restart written twice is one row", async () => {
      const { store, clock } = await b.make();
      const [r] = restarts(clock, 1);
      expect(await store.recordChildRestart(r!)).toEqual({ created: true });
      expect(await store.recordChildRestart(r!)).toEqual({ created: false });
      expect(await store.listChildRestartsWithin(RESTART_WINDOW_MS)).toEqual([r]);
      const db: MigrationDb = { dialect: store.db.dialect.name, all: (s, p) => store.db.all(s, p), run: (s, p) => store.db.run(s, p) };
      expect(await tableColumns(db, "runtime_child_restarts")).toEqual(["restart_key", "at", "reason"]);
    });

    it("a process with no restart list of its own alarms on the stored restarts", async () => {
      const { store, clock } = await b.make();
      for (const r of restarts(clock, 5)) await store.recordChildRestart(r);
      const cfg: FactoryConfig = { ...config };
      await new ControllerRole({ store, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner }).tickAlarms();
      expect(await store.listAlerts({ limit: 10 })).toMatchObject([{ pattern: "child_restarts", count: 5, detail: "r5" }]);
    });
  });
}

describe("migration: runtime_child_restarts drops recorded_at", () => {
  /** A database whose runtime_child_restarts still has recorded_at, with two restarts in it. */
  async function before(): Promise<MigrationDb> {
    const { store } = await newStore();
    const db: MigrationDb = { dialect: "sqlite", all: (s, p) => store.db.all(s, p), run: (s, p) => store.db.run(s, p) };
    await db.run("ALTER TABLE runtime_child_restarts ADD COLUMN recorded_at TEXT NOT NULL DEFAULT ''");
    await db.run("INSERT INTO runtime_child_restarts (restart_key, at, reason, recorded_at) VALUES ('k1', '2026-11-09T10:00:00.000Z', 'r1', 'x'), ('k2', '2026-11-09T10:05:00.000Z', 'r2', 'y')");
    return db;
  }

  it("is a breaking migration of runtime_child_restarts", () => {
    expect(dropRecordedAt).toMatchObject({ change: "breaking", tables: ["runtime_child_restarts"] });
  });

  it("drops the column, keeps every row's at and reason, and a rerun changes nothing", async () => {
    const db = await before();
    await dropRecordedAt.up(db);
    expect(await tableColumns(db, "runtime_child_restarts")).toEqual(["restart_key", "at", "reason"]);
    expect(await dropRecordedAt.verify!(db)).toEqual([]);
    expect(await db.all("SELECT restart_key, at, reason FROM runtime_child_restarts ORDER BY restart_key")).toEqual([
      { restart_key: "k1", at: "2026-11-09T10:00:00.000Z", reason: "r1" },
      { restart_key: "k2", at: "2026-11-09T10:05:00.000Z", reason: "r2" },
    ]);
    await dropRecordedAt.up(db);
    expect(await dropRecordedAt.verify!(db)).toEqual([]);
  });

  it("verify returns a problem when a row's at or reason changed", async () => {
    for (const change of ["UPDATE runtime_child_restarts SET reason = 'other' WHERE restart_key = 'k1'", "UPDATE runtime_child_restarts SET at = '2026-11-09T11:00:00.000Z' WHERE restart_key = 'k2'"]) {
      const db = await before();
      await dropRecordedAt.up(db);
      await db.run(change);
      expect(await dropRecordedAt.verify!(db)).toEqual([expect.stringContaining("differs over restart_key, at, reason")]);
    }
  });

  it("verify returns a problem while the column is still there", async () => {
    expect(await dropRecordedAt.verify!(await before())).toEqual([expect.stringContaining("recorded_at is still there")]);
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
