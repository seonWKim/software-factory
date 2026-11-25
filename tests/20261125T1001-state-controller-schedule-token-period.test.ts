import { describe, expect, it } from "vitest";
import migration from "../src/state/migrations/20261125T1001-state-controller-schedule-token-period.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// The token cap's period (design 08-schedules): controller_schedules gets token_period, a nullable TEXT with no
// default. No row is backfilled: a stored schedule keeps null, which counts as lifetime. A rerun changes nothing.

const ID = "20261125T1001-state-controller-schedule-token-period";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

describe(ID, () => {
  it("a fresh store has token_period, nullable TEXT with no default, and the migration recorded", async () => {
    const { store } = await newStore();
    const [col] = await store.db.all("SELECT type, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('controller_schedules') WHERE name = 'token_period'");
    expect(col).toEqual({ type: "TEXT", nn: 0, d: null });
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive" });
  });

  it("adds the column with no backfill, keeps every row, and a rerun changes nothing", async () => {
    const { store } = await newStore();
    const db = store.db;
    await db.run("ALTER TABLE controller_schedules DROP COLUMN token_period");
    await db.run(
      `INSERT INTO controller_schedules (id, title, cadence_kind, cadence_spec, zone, created_by, created_at, next_due_at, action_kind, action_settings, token_cap)
       VALUES ('sch_daily', 'Nightly', 'daily', '02:00', 'UTC', 'local:owner', '2026-11-19T00:00:00.000Z', '2026-11-26T02:00:00.000Z', 'agent', '{}', 5000)`,
    );
    const before = await db.all("SELECT * FROM controller_schedules ORDER BY id");
    await migration.up(mdb(db));
    const after = await db.all("SELECT * FROM controller_schedules ORDER BY id");
    expect(after).toEqual(before.map((r) => ({ ...r, token_period: null })));

    await db.run("UPDATE controller_schedules SET token_period = 'day'");
    const changed = await db.all("SELECT * FROM controller_schedules ORDER BY id");
    await migration.up(mdb(db));
    expect(await db.all("SELECT * FROM controller_schedules ORDER BY id")).toEqual(changed);
  });
});
