import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261121T1000-controller-done-checks.migration.js";
import type { Actor, UserId } from "../src/core/types.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver, tableColumns } from "../src/state/index.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// Done-when checks (design 04-triage, 2026-11-22): the nullable `done_checks` on controller_work_items. Additive, no
// backfill, rerun-safe; the row mapping reads and writes it.

const ID = "20261121T1000-controller-done-checks";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const CHECKS = [{ line: "CI runs the gate", command: "npm test" }];
const SYSTEM: Actor = { kind: "system", id: "test" };
const intake = (n: number) => ({ source: { type: "github_issue" as const, id: `o/r#${n}`, link: "l" }, requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "x", resources: [] });

describe("20261121T1000-controller-done-checks on an existing SQLite database", () => {
  it("adds the nullable column, backfills nothing, keeps the rows and is safe to rerun", async () => {
    const { store } = await newStore();
    const db = store.db;
    const { item: old } = await store.createWorkItem(intake(1), SYSTEM);
    await db.run("ALTER TABLE controller_work_items DROP COLUMN done_checks");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    expect(await tableColumns(mdb(db), "controller_work_items")).not.toContain("done_checks");
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive" });
    await migration.up(mdb(db));
    expect(await db.all("SELECT id, done_checks FROM controller_work_items")).toEqual([{ id: old.id, done_checks: null }]);
    // An item triaged before the change keeps null.
    expect((await store.getWorkItem(old.id))!.done_checks).toBeNull();
  });

  it("a patch writes the list as JSON and the item reads it back", async () => {
    const { store } = await newStore();
    const { item: it0 } = await store.createWorkItem(intake(2), SYSTEM);
    expect(it0.done_checks).toBeNull();
    const r = await store.transition({ id: it0.id, expected_version: it0.version, actor: SYSTEM, reason: "triaged", patch: { done_checks: CHECKS } });
    expect(r).toMatchObject({ ok: true });
    expect((await store.getWorkItem(it0.id))!.done_checks).toEqual(CHECKS);
    expect(await store.db.all("SELECT done_checks FROM controller_work_items WHERE id = ?", [it0.id])).toEqual([{ done_checks: JSON.stringify(CHECKS) }]);
  });
});
