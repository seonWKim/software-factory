import { describe, expect, it } from "vitest";
import stepOne from "../src/controller/migrations/20261124T1100-controller-routines-into-schedules.migration.js";
import migration from "../src/controller/migrations/20261125T1000-controller-schedules-trigger.migration.js";
import missed from "../src/controller/migrations/20261125T1100-controller-schedule-missed.migration.js";
import tokenPeriod from "../src/state/migrations/20261125T1001-state-controller-schedule-token-period.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// The schedules rebuild (design 08-schedules): controller_schedules gets a nullable trigger_kind and a nullable
// cadence, keeps every row and its due index, and keeps the old table as legacy_controller_schedules. In the same
// pass its Check a page rows are refreshed from the routine tables, trigger routines included. A rerun changes nothing.

const ID = "20261125T1000-controller-schedules-trigger";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

const ROUTINE_COLUMNS = "id, name, instruction, url, cadence_kind, cadence_spec, zone, trigger_kind, run_cap_usd, daily_cap_usd, cap_raise_usd, cap_raise_day, cap_hold_key, paused, created_by, created_at, next_due_at, last_run_at";
const SUGGESTION_COLUMNS = "id, routine_id, run_id, fingerprint, text, state, duplicates, last_run_id, snoozed_until, filed_ref, decided_by, decided_at, created_at";
const routine = (v: unknown[]) => [`INSERT INTO controller_routines (${ROUTINE_COLUMNS}) VALUES (${v.map(() => "?").join(", ")})`, v] as const;
const suggestion = (v: unknown[]) => [`INSERT INTO controller_routine_suggestions (${SUGGESTION_COLUMNS}) VALUES (${v.map(() => "?").join(", ")})`, v] as const;

/** A store whose controller_schedules is back as it was before this migration (NOT NULL cadence, no trigger_kind). */
async function beforeMigration() {
  const { store } = await newStore();
  const db = store.db;
  await db.run("DROP TABLE controller_schedules");
  await db.run("ALTER TABLE legacy_controller_schedules RENAME TO controller_schedules");
  await db.run("CREATE INDEX controller_schedules_due ON controller_schedules (next_due_at)");
  return { store, db };
}

/** A plain schedule, two routines (one scheduled, one trigger) with suggestions, and the step-1 copy. */
async function seed(db: SqlDriver) {
  await db.run(
    `INSERT INTO controller_schedules (id, title, cadence_kind, cadence_spec, zone, created_by, created_at, next_due_at, running_since, skip_when_busy, action_kind, action_settings, token_cap)
     VALUES ('sch_build', 'Nightly build', 'daily', '02:00', 'UTC', 'local:owner', '2026-11-19T00:00:00.000Z', '2026-11-26T02:00:00.000Z', NULL, 1, 'build', '{}', 5000)`,
  );
  for (const [sql, args] of [
    routine(["rt_docs", "Docs check", "Look for broken links", "https://example.test/docs", "daily", "09:00", "Asia/Seoul", null,
      0.5, 2, null, null, null, null, "local:owner", "2026-11-20T00:00:00.000Z", "2026-11-25T00:00:00.000Z", null]),
    routine(["rt_merge", "After merge", "Summarise the merge", null, null, null, "UTC", "merge",
      null, 1, null, null, null, null, "local:owner", "2026-11-21T00:00:00.000Z", null, null]),
    routine(["rt_gone", "Removed later", "Old", null, "interval", "60", "UTC", null,
      null, null, null, null, null, null, "local:owner", "2026-11-19T00:00:00.000Z", "2026-11-25T00:00:00.000Z", null]),
    suggestion(["rs_1", "rt_docs", "run_1", "fp_1", "Fix the link", "pending", 0, "run_1", null, null, null, null, "2026-11-22T00:00:00.000Z"]),
    suggestion(["rs_2", "rt_merge", "run_2", "fp_2", "Tag the release", "pending", 0, "run_2", null, null, null, null, "2026-11-22T00:00:00.000Z"]),
  ]) await db.run(sql, [...args] as never);
  await stepOne.up(mdb(db));
  // Routine writes after step 1, which its copies do not have yet.
  await db.run("UPDATE controller_routines SET name = 'Docs links', paused = 1, last_run_at = '2026-11-24T09:00:00.000Z', cap_raise_usd = 1, cap_raise_day = '2026-11-24', cap_hold_key = 'hold_1' WHERE id = 'rt_docs'");
  await db.run("UPDATE controller_routine_suggestions SET state = 'dismissed', decided_by = 'local:owner', decided_at = '2026-11-24T10:00:00.000Z' WHERE id = 'rs_1'");
  await db.run("DELETE FROM controller_routines WHERE id = 'rt_gone'");
}

describe("20261125T1000-controller-schedules-trigger", () => {
  it("a fresh store has the nullable cadence, trigger_kind, the due index on the new table, and the migration recorded", async () => {
    const { store } = await newStore();
    const info = await store.db.all("SELECT name, \"notnull\" AS nn FROM pragma_table_info('controller_schedules')");
    expect(info.map((r) => r.name)).toContain("trigger_kind");
    expect(info.filter((r) => ["cadence_kind", "cadence_spec", "trigger_kind"].includes(String(r.name))).map((r) => Number(r.nn))).toEqual([0, 0, 0]);
    expect(await store.db.all("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'controller_schedules_due'")).toEqual([{ tbl_name: "controller_schedules" }]);
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "breaking", tables: expect.arrayContaining(["controller_schedules", "controller_schedule_suggestions"]) });
    expect(await migration.verify!(mdb(store.db))).toEqual([]);
  });

  it("keeps every schedule row and the due index, and a rerun changes nothing", async () => {
    const { store, db } = await beforeMigration();
    await seed(db);
    const plain = await db.all("SELECT * FROM controller_schedules WHERE id = 'sch_build'");
    await migration.up(mdb(db));
    expect(await migration.verify!(mdb(db))).toEqual([]);

    expect(await db.all("SELECT * FROM controller_schedules WHERE id = 'sch_build'")).toEqual([{ ...plain[0], trigger_kind: null }]);
    expect(await db.all("SELECT * FROM legacy_controller_schedules ORDER BY id")).toEqual(expect.arrayContaining(plain));
    expect(await db.all("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'controller_schedules_due'")).toEqual([{ tbl_name: "controller_schedules" }]);
    // A trigger row with no cadence is now storable.
    expect(await db.all("SELECT id, cadence_kind, cadence_spec, trigger_kind FROM controller_schedules WHERE id = 'rt_merge'")).toEqual([
      { id: "rt_merge", cadence_kind: null, cadence_spec: null, trigger_kind: "merge" },
    ]);

    const schedules = await db.all("SELECT * FROM controller_schedules ORDER BY id");
    const suggestions = await db.all("SELECT * FROM controller_schedule_suggestions ORDER BY id");
    // A rerun after a routine-store write does not overwrite it from the routine tables.
    await store.editRoutine("rt_docs", { next_due_at: "2026-11-25T00:00:00.000Z" as never, last_run_at: "2026-11-24T09:00:00.000Z" as never }, { name: "Edited" });
    await migration.up(mdb(db));
    expect(await db.all("SELECT * FROM controller_schedules ORDER BY id")).toEqual(schedules.map((s) => (s.id === "rt_docs" ? { ...s, title: "Edited" } : s)));
    expect(await db.all("SELECT * FROM controller_schedule_suggestions ORDER BY id")).toEqual(suggestions);
    // The plain schedule is still listed; the routine rows are not (the store reads token_period and missed_rule, added after this migration).
    await tokenPeriod.up(mdb(db));
    await missed.up(mdb(db));
    expect((await store.listSchedules()).map((s) => s.id)).toEqual(["sch_build"]);
  });

  it("copies trigger routines and refreshes the step-1 copies, so the routine store reads what the routine tables held", async () => {
    const { store, db } = await beforeMigration();
    await seed(db);
    const routinesBefore = await db.all(`SELECT ${ROUTINE_COLUMNS} FROM controller_routines ORDER BY id`);
    const suggestionsBefore = await db.all(`SELECT ${SUGGESTION_COLUMNS} FROM controller_routine_suggestions ORDER BY id`);
    await migration.up(mdb(db));

    const copies = await db.all(`SELECT ${ROUTINE_COLUMNS.replace("name", "title AS name")} FROM controller_schedules WHERE action_kind = 'check_page' ORDER BY id`);
    expect(copies).toEqual(routinesBefore);
    expect(await db.all(`SELECT ${SUGGESTION_COLUMNS.replace("routine_id", "schedule_id AS routine_id")} FROM controller_schedule_suggestions ORDER BY id`)).toEqual(suggestionsBefore);

    expect((await store.listRoutines()).map((r) => [r.id, r.name, r.trigger, r.paused])).toEqual([
      ["rt_docs", "Docs links", null, true], ["rt_merge", "After merge", "merge", false],
    ]);
    expect(await store.getRoutine("rt_docs")).toMatchObject({ cap_raise: { usd: 1, day: "2026-11-24", hold_key: "hold_1" }, last_run_at: "2026-11-24T09:00:00.000Z" });
    expect(await store.getRoutine("rt_gone")).toBeNull();
    expect((await store.listRoutineSuggestions("rt_docs")).map((s) => [s.id, s.state])).toEqual([["rs_1", "dismissed"]]);
    expect((await store.listRoutineSuggestions("rt_merge")).map((s) => s.id)).toEqual(["rs_2"]);
  });
});
