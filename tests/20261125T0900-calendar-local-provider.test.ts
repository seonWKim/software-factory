import { describe, expect, it } from "vitest";
import migration from "../src/calendar/migrations/20261125T0900-calendar-local-provider.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver, tableColumns } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// A local event's copy in a connected calendar (design 02-tasks-calendar): the nullable `provider`, `provider_event_id`
// and `sync_error` on calendar_local_events, and `calendar_write_access` (whether each calendar takes writes). Additive,
// no backfill (no event has a copy yet), rerun-safe.

const ID = "20261125T0900-calendar-local-provider";
const COLUMNS = ["provider", "provider_event_id", "sync_error"];
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

describe("20261125T0900-calendar-local-provider on an existing SQLite database", () => {
  it("a fresh store has the columns and the migration recorded", async () => {
    const { store } = await newStore();
    expect(await tableColumns(mdb(store.db), "calendar_local_events")).toEqual(expect.arrayContaining(COLUMNS));
    expect(await tableColumns(mdb(store.db), "calendar_write_access")).toEqual(["source", "writable"]);
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
  });

  it("adds the three nullable columns, keeps every event, backfills nothing and is safe to rerun", async () => {
    const { store } = await newStore();
    const db = store.db;
    for (const c of COLUMNS) await db.run(`ALTER TABLE calendar_local_events DROP COLUMN ${c}`);
    await db.run("DROP TABLE calendar_write_access");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    await db.run(
      "INSERT INTO calendar_local_events (id, title, starts_at, ends_at, all_day, repeats, created_by, created_at, updated_at) VALUES ('le_existing1', 'Gym', '2026-11-20T07:00:00.000Z', '2026-11-20T08:00:00.000Z', 0, 'weekly', 'local:owner', '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z')",
    );
    expect(await tableColumns(mdb(db), "calendar_local_events")).not.toContain("provider");
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    const rows = "SELECT id, title, repeats, provider, provider_event_id, sync_error FROM calendar_local_events";
    const after = [{ id: "le_existing1", title: "Gym", repeats: "weekly", provider: null, provider_event_id: null, sync_error: null }];
    expect(await db.all(rows)).toEqual(after);
    expect(migration).toMatchObject({ change: "additive" });
    await db.run("INSERT INTO calendar_write_access (source, writable) VALUES ('a-calendar', 1)");
    await migration.up(mdb(db));
    expect(await db.all(rows)).toEqual(after);
    expect(await db.all("SELECT source, writable FROM calendar_write_access")).toEqual([{ source: "a-calendar", writable: 1 }]);
  });
});
