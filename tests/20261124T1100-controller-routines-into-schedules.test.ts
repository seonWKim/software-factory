import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261124T1100-controller-routines-into-schedules.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver, tableColumns } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// Routines copied into Check a page schedules (design 08-schedules): nine nullable columns on controller_schedules,
// the controller_schedule_suggestions table, and an INSERT OR IGNORE copy of each routine with a cadence (same ID,
// action_kind 'check_page') and of its suggestions (same IDs). The routine tables stay; a rerun changes nothing.

const ID = "20261124T1100-controller-routines-into-schedules";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const NEW_COLUMNS = ["instruction", "url", "paused", "run_cap_usd", "daily_cap_usd", "cap_raise_usd", "cap_raise_day", "cap_hold_key", "last_run_at"];

const ROUTINE_COLUMNS = "id, name, instruction, url, cadence_kind, cadence_spec, zone, trigger_kind, run_cap_usd, daily_cap_usd, cap_raise_usd, cap_raise_day, cap_hold_key, paused, created_by, created_at, next_due_at, last_run_at";
const SUGGESTION_COLUMNS = "id, routine_id, run_id, fingerprint, text, state, duplicates, last_run_id, snoozed_until, filed_ref, decided_by, decided_at, created_at";

async function seedRoutines(db: SqlDriver) {
  await db.run(`INSERT INTO controller_routines (${ROUTINE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    "rt_docs", "Docs check", "Look for broken links", "https://example.test/docs", "daily", "09:00", "Asia/Seoul", null,
    0.5, 2, 1, "2026-11-24", "hold_1", 1, "local:owner", "2026-11-20T00:00:00.000Z", "2026-11-25T00:00:00.000Z", "2026-11-24T00:00:00.000Z",
  ]);
  await db.run(`INSERT INTO controller_routines (${ROUTINE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    "rt_merge", "After merge", "Summarise the merge", null, null, null, "UTC", "merge",
    null, null, null, null, null, null, "local:owner", "2026-11-21T00:00:00.000Z", null, null,
  ]);
  await db.run(`INSERT INTO controller_routine_suggestions (${SUGGESTION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    "rs_1", "rt_docs", "run_1", "fp_1", "Fix the link on /setup", "snoozed", 2, "run_3", "2026-11-30T00:00:00.000Z", null, "local:owner", "2026-11-24T01:00:00.000Z", "2026-11-22T00:00:00.000Z",
  ]);
  await db.run(`INSERT INTO controller_routine_suggestions (${SUGGESTION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    "rs_2", "rt_merge", "run_2", "fp_2", "Tag the release", "pending", 0, "run_2", null, null, null, null, "2026-11-22T00:00:00.000Z",
  ]);
}

describe("20261124T1100-controller-routines-into-schedules on an existing SQLite database", () => {
  it("a fresh store has the nullable columns, the suggestions table and the routine tables, and the migration recorded", async () => {
    const { store } = await newStore();
    const db = mdb(store.db);
    expect(await tableColumns(db, "controller_schedules")).toEqual(expect.arrayContaining(NEW_COLUMNS));
    expect(await tableColumns(db, "controller_schedule_suggestions")).toEqual(expect.arrayContaining(["id", "schedule_id", "run_id", "fingerprint", "state", "duplicates"]));
    expect(await tableColumns(db, "controller_schedule_suggestions")).not.toContain("routine_id");
    expect(await tableColumns(db, "controller_routines")).toContain("cadence_kind");
    expect(await tableColumns(db, "controller_routine_suggestions")).toContain("routine_id");
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive" });
  });

  it("copies each routine with a cadence and its suggestions with the same IDs; a second run changes nothing", async () => {
    const { store } = await newStore();
    const db = store.db;
    await seedRoutines(db);
    await migration.up(mdb(db));

    const schedules = await db.all("SELECT * FROM controller_schedules ORDER BY id");
    expect(schedules).toEqual([{
      id: "rt_docs", title: "Docs check", cadence_kind: "daily", cadence_spec: "09:00", zone: "Asia/Seoul", created_by: "local:owner",
      created_at: "2026-11-20T00:00:00.000Z", next_due_at: "2026-11-25T00:00:00.000Z", running_since: null, skip_when_busy: null,
      action_kind: "check_page", action_settings: null, token_cap: null,
      instruction: "Look for broken links", url: "https://example.test/docs", paused: 1, run_cap_usd: 0.5, daily_cap_usd: 2,
      cap_raise_usd: 1, cap_raise_day: "2026-11-24", cap_hold_key: "hold_1", last_run_at: "2026-11-24T00:00:00.000Z", trigger_kind: null,
      missed_rule: "catch_up",
    }]);
    const suggestions = await db.all("SELECT * FROM controller_schedule_suggestions ORDER BY id");
    expect(suggestions).toEqual([{
      id: "rs_1", schedule_id: "rt_docs", run_id: "run_1", fingerprint: "fp_1", text: "Fix the link on /setup", state: "snoozed", duplicates: 2,
      last_run_id: "run_3", snoozed_until: "2026-11-30T00:00:00.000Z", filed_ref: null, decided_by: "local:owner", decided_at: "2026-11-24T01:00:00.000Z",
      created_at: "2026-11-22T00:00:00.000Z",
    }]);

    // The routine tables are kept as they were, trigger routine included.
    expect((await db.all("SELECT id FROM controller_routines ORDER BY id")).map((r) => r.id)).toEqual(["rt_docs", "rt_merge"]);
    expect((await db.all("SELECT id FROM controller_routine_suggestions ORDER BY id")).map((r) => r.id)).toEqual(["rs_1", "rs_2"]);

    await migration.up(mdb(db));
    expect(await db.all("SELECT * FROM controller_schedules ORDER BY id")).toEqual(schedules);
    expect(await db.all("SELECT * FROM controller_schedule_suggestions ORDER BY id")).toEqual(suggestions);

    // The copies are hidden from the schedule list until a later phase gives them a page and API view.
    expect((await store.listSchedules()).map((s) => s.id)).not.toContain("rt_docs");
  });

  it("a rerun after a routine edit does not overwrite the copy", async () => {
    const { store } = await newStore();
    const db = store.db;
    await seedRoutines(db);
    await migration.up(mdb(db));
    await db.run("UPDATE controller_routines SET name = 'Renamed' WHERE id = 'rt_docs'");
    await migration.up(mdb(db));
    expect(await db.all("SELECT title FROM controller_schedules WHERE id = 'rt_docs'")).toEqual([{ title: "Docs check" }]);
  });
});
