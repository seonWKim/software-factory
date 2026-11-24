import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261124T1100-controller-size-cap.migration.js";
import type { Actor, UserId } from "../src/core/types.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver, tableColumns } from "../src/state/index.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// The one-time size cap (design 04-split-specs, 2026-11-24): the nullable `size_cap` on controller_work_items. Additive,
// no backfill, rerun-safe; the row mapping reads and writes it.

const ID = "20261124T1100-controller-size-cap";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const CAP = { max_diff_lines: 1648, max_diff_files: 40 };
const SYSTEM: Actor = { kind: "system", id: "test" };
const intake = (n: number) => ({ source: { type: "github_issue" as const, id: `o/r#${n}`, link: "l" }, requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "x", resources: [] });

describe("20261124T1100-controller-size-cap on an existing SQLite database", () => {
  it("adds the nullable column, backfills nothing, keeps the rows and is safe to rerun", async () => {
    const { store } = await newStore();
    const db = store.db;
    const { item: old } = await store.createWorkItem(intake(1), SYSTEM);
    await db.run("ALTER TABLE controller_work_items DROP COLUMN size_cap");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    expect(await tableColumns(mdb(db), "controller_work_items")).not.toContain("size_cap");
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive" });
    await migration.up(mdb(db));
    expect(await db.all("SELECT id, size_cap FROM controller_work_items")).toEqual([{ id: old.id, size_cap: null }]);
    // An item from before the change keeps null: its project's caps apply.
    expect((await store.getWorkItem(old.id))!.size_cap).toBeNull();
  });

  it("a patch writes the cap as JSON and the item reads it back", async () => {
    const { store } = await newStore();
    const { item: it0 } = await store.createWorkItem(intake(2), SYSTEM);
    expect(it0.size_cap).toBeNull();
    const r = await store.transition({ id: it0.id, expected_version: it0.version, actor: SYSTEM, reason: "spec_approved", patch: { size_cap: CAP } });
    expect(r).toMatchObject({ ok: true });
    expect((await store.getWorkItem(it0.id))!.size_cap).toEqual(CAP);
    expect(await store.db.all("SELECT size_cap FROM controller_work_items WHERE id = ?", [it0.id])).toEqual([{ size_cap: JSON.stringify(CAP) }]);
  });
});
