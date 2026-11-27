import { describe, expect, it } from "vitest";
import migration from "../src/state/migrations/20261126T1201-state-controller-activity.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// The Activity record (design 08-schedules-actions): a new controller_activity table, and controller_schedule_runs
// gains nullable reason and ref. No row is backfilled: a stored run keeps null in both. A rerun changes nothing.

const ID = "20261126T1201-state-controller-activity";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const RUN = `INSERT INTO controller_schedule_runs (schedule_id, occurrence_at, outcome, recorded_at) VALUES ('sch_1', '2026-11-25T09:00:00.000Z', 'fired', '2026-11-25T09:00:01.000Z')`;

describe(ID, () => {
  it("a fresh store has the table, the two run columns, and the migration recorded", async () => {
    const { store } = await newStore();
    const cols = (await store.db.all("SELECT name FROM pragma_table_info('controller_activity')")).map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(["seq", "actor_id", "kind", "subject", "outcome", "reason", "ref", "at"]));
    const runCols = (await store.db.all("SELECT name FROM pragma_table_info('controller_schedule_runs')")).map((r) => r.name);
    expect(runCols).toEqual(expect.arrayContaining(["reason", "ref"]));
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive" });
  });

  it("adds the columns with no backfill, keeps every row, and a rerun changes nothing", async () => {
    const { store } = await newStore();
    const db = store.db;
    await db.run("DROP TABLE controller_activity");
    await db.run("ALTER TABLE controller_schedule_runs DROP COLUMN reason");
    await db.run("ALTER TABLE controller_schedule_runs DROP COLUMN ref");
    await db.run(RUN);
    const before = await db.all("SELECT * FROM controller_schedule_runs");
    await migration.up(mdb(db));
    expect(await db.all("SELECT * FROM controller_schedule_runs")).toEqual(before.map((r) => ({ ...r, reason: null, ref: null })));
    expect(await db.all("SELECT * FROM controller_activity")).toEqual([]);

    await db.run("UPDATE controller_schedule_runs SET reason = 'due'");
    const changed = await db.all("SELECT * FROM controller_schedule_runs");
    await migration.up(mdb(db));
    expect(await db.all("SELECT * FROM controller_schedule_runs")).toEqual(changed);
  });
});
