import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261122T1201-controller-filed-pattern-evidence.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver, tableColumns } from "../src/state/index.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

// Rejected filings (design 07-self-improvement, issue #775): the nullable `evidence` on controller_filed_patterns.
// Additive, no backfill, rerun-safe; the claim writes it and the row mapping reads it.

const ID = "20261122T1201-controller-filed-pattern-evidence";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

async function withReport() {
  const { store } = await newStore();
  const { item } = await store.createWorkItem(issue(1), system);
  const { run } = await store.enqueueRun({ work_item_id: item.id, kind: "improve", idempotency_key: "k" });
  const { report } = await store.recordImproveReport({
    run_id: run.id, project: PROJECT_KEY, window_start: "2026-03-04T00:00:00.000Z" as never, window_end: "2026-03-05T00:00:00.000Z" as never, groups: [], patterns: [],
  });
  return { store, report };
}

describe("20261122T1201-controller-filed-pattern-evidence on an existing SQLite database", () => {
  it("adds the nullable column, backfills nothing, keeps the rows and is safe to rerun", async () => {
    const { store, report } = await withReport();
    const db = store.db;
    await db.run("ALTER TABLE controller_filed_patterns DROP COLUMN evidence");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    await db.run(
      "INSERT INTO controller_filed_patterns (id, project_key, pattern_key, error_code, detail, report_id, filed_ref, created_at) VALUES ('fp_old', ?, 'old', 'hotspot', 'a.ts', ?, NULL, '2026-03-01T00:00:00.000Z')",
      [PROJECT_KEY, report.id],
    );
    expect(await tableColumns(mdb(db), "controller_filed_patterns")).not.toContain("evidence");
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive" });
    await migration.up(mdb(db));
    expect(await db.all("SELECT id, evidence FROM controller_filed_patterns")).toEqual([{ id: "fp_old", evidence: null }]);
    // A row filed before the change keeps null.
    expect((await store.getFiledPattern(PROJECT_KEY, "old"))!.evidence).toBeNull();
  });

  it("a claim stores its evidence; a claim without one stores null; a replace writes the new evidence", async () => {
    const { store, report } = await withReport();
    const input = { project: PROJECT_KEY, pattern_key: "a", error_code: "hotspot", detail: "a.ts", report_id: report.id };
    expect((await store.takeFiledPattern({ ...input, evidence: 4 })).row.evidence).toBe(4);
    expect((await store.takeFiledPattern({ ...input, pattern_key: "b" })).row.evidence).toBeNull();
    const { item } = await store.createWorkItem(issue(2), system);
    const { run } = await store.enqueueRun({ work_item_id: item.id, kind: "improve", idempotency_key: "k2" });
    const { report: next } = await store.recordImproveReport({ run_id: run.id, project: PROJECT_KEY, window_start: report.window_start, window_end: report.window_end, groups: [], patterns: [] });
    expect((await store.takeFiledPattern({ ...input, report_id: next.id, evidence: 8 }, { replace: report.id })).row).toMatchObject({ report_id: next.id, evidence: 8 });
  });
});
