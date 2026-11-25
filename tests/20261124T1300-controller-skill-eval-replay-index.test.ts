import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261124T1300-controller-skill-eval-replay-index.migration.js";
import { type MigrationDb, MIGRATIONS_TABLE, type SqlDriver, tableColumns, tableExists } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// The replays table rebuilt with a replay number per replay (design 06-measurement, repeats): the key is run, case and
// replay number (none counts as 0), rows stored before it keep no number (no backfill), and a rerun changes nothing.

const ID = "20261124T1300-controller-skill-eval-replay-index";
const TABLE = "controller_skill_eval_replays";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const OLD = `CREATE TABLE ${TABLE} (
    run_id TEXT NOT NULL, case_id TEXT NOT NULL, verdict TEXT NOT NULL, detail TEXT NOT NULL, recorded_at TEXT NOT NULL,
    transcript TEXT, answer TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, wall_ms INTEGER,
    PRIMARY KEY (run_id, case_id))`;

/** A store whose replays table is back as it was before this migration, holding one old replay. */
async function beforeIt(): Promise<SqlDriver> {
  const { store } = await newStore();
  const db = store.db;
  await db.run(`DROP TABLE ${TABLE}`);
  await db.run(`DROP TABLE IF EXISTS legacy_${TABLE}`);
  await db.run(OLD);
  await db.run(`INSERT INTO ${TABLE} (run_id, case_id, verdict, detail, recorded_at, answer) VALUES ('r_old', 'c1', 'pass', '{}', 't', 'old answer')`);
  return db;
}

describe(ID, () => {
  it("is applied on a fresh store, breaking, and adds the replay column", async () => {
    const { store } = await newStore();
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "breaking", tables: [TABLE] });
    expect(await tableColumns(mdb(store.db), TABLE)).toContain("replay");
  });

  it("copies every old replay with no replay number, keeps the old table as legacy, and verifies clean", async () => {
    const db = await beforeIt();
    await migration.up(mdb(db));
    expect(await migration.verify!(mdb(db))).toEqual([]);
    expect(await db.all(`SELECT run_id, case_id, verdict, answer, replay FROM ${TABLE}`)).toEqual([{ run_id: "r_old", case_id: "c1", verdict: "pass", answer: "old answer", replay: null }]);
    expect(await tableExists(mdb(db), `legacy_${TABLE}`)).toBe(true);
  });

  it("keys a replay by run, case and replay number, none counting as 0", async () => {
    const db = await beforeIt();
    await migration.up(mdb(db));
    const put = (replay: number | null) => db.run(`INSERT OR IGNORE INTO ${TABLE} (run_id, case_id, verdict, detail, recorded_at, replay) VALUES ('r_old', 'c1', 'fail', '{}', 't', ?)`, [replay]);
    expect(await put(null)).toBe(0);
    expect(await put(1)).toBe(1);
    expect(await put(1)).toBe(0);
    expect(await put(2)).toBe(1);
  });

  it("is safe to run twice: a rerun finds the legacy table and changes nothing", async () => {
    const db = await beforeIt();
    await migration.up(mdb(db));
    await migration.up(mdb(db));
    expect(await db.all(`SELECT COUNT(*) AS n FROM ${TABLE}`)).toEqual([{ n: 1 }]);
    expect(await migration.verify!(mdb(db))).toEqual([]);
  });
});
