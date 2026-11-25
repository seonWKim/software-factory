import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261125T1100-controller-schedule-missed.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// The missed-time setting (design 08-schedules): controller_schedules gets missed_rule (TEXT, NOT NULL, default
// catch_up); a row with skip_when_busy = 1 becomes skip, every other row and column keeps its data, and a rerun
// changes nothing.

const ID = "20261125T1100-controller-schedule-missed";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

/** A store whose controller_schedules is back as it was before this migration (no missed_rule). */
async function beforeMigration() {
  const { store } = await newStore();
  const db = store.db;
  await db.run("ALTER TABLE controller_schedules DROP COLUMN missed_rule");
  return { store, db };
}

async function seed(db: SqlDriver) {
  const insert = (id: string, skip: number | null) =>
    db.run(
      `INSERT INTO controller_schedules (id, title, cadence_kind, cadence_spec, zone, created_by, created_at, next_due_at, running_since, skip_when_busy, action_kind, action_settings, token_cap)
       VALUES (?, 'Nightly', 'daily', '02:00', 'UTC', 'local:owner', '2026-11-19T00:00:00.000Z', '2026-11-26T02:00:00.000Z', NULL, ?, 'build', '{}', 5000)`,
      [id, skip],
    );
  await insert("sch_on", 1);
  await insert("sch_off", 0);
  await insert("sch_unset", null);
}

describe(ID, () => {
  it("a fresh store has missed_rule TEXT NOT NULL defaulting to catch_up, and the migration recorded", async () => {
    const { store } = await newStore();
    const [col] = await store.db.all("SELECT type, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('controller_schedules') WHERE name = 'missed_rule'");
    expect(col).toEqual({ type: "TEXT", nn: 1, d: "'catch_up'" });
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive", tables: expect.arrayContaining(["controller_schedules"]) });
  });

  it("maps skip_when_busy = 1 to skip, keeps every other row and column, and a rerun changes nothing", async () => {
    const { db } = await beforeMigration();
    await seed(db);
    const before = await db.all("SELECT * FROM controller_schedules ORDER BY id");
    await migration.up(mdb(db));
    const after = await db.all("SELECT * FROM controller_schedules ORDER BY id");
    const rule: Record<string, string> = { sch_on: "skip", sch_off: "catch_up", sch_unset: "catch_up" };
    expect(after).toEqual(before.map((r) => ({ ...r, missed_rule: rule[String(r.id)] })));

    // An owner's change after the migration stays through a rerun.
    await db.run("UPDATE controller_schedules SET missed_rule = 'catch_up' WHERE id = 'sch_on'");
    const changed = await db.all("SELECT * FROM controller_schedules ORDER BY id");
    await migration.up(mdb(db));
    expect(await db.all("SELECT * FROM controller_schedules ORDER BY id")).toEqual(changed);
  });
});
