import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunId, Timestamp, WorkerId } from "../src/core/types.js";
import { INLINE_STEPS, STEPS_DIR, readSteps, splitSql } from "../src/impl/store/mysql/migrations.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { issue, newStore, system } from "./helpers/store.js";

/** The schema step that adds the improve tables (issue #306): SQLite migration 31, MySQL step 0031. */
const STEP = 31;
const TABLES = ["improve_reports", "filed_patterns"];

/** Column names per table of `CREATE TABLE` statements, in order. Keys and constraints are left out. */
function columnsOf(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\)/g)) {
    const cols = m[2]!.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^(UNIQUE|KEY|FOREIGN|PRIMARY KEY \()/.test(l));
    out.set(m[1]!, cols.map((l) => l.split(/\s+/)[0]!));
  }
  return out;
}

describe("improve tables: schema", () => {
  it("SQLite migration 31 creates the report and filed-pattern tables; a new store has both, the filed patterns empty", async () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(STEP);
    expect([...columnsOf(MIGRATIONS[STEP - 1]!).keys()]).toEqual(TABLES);
    const { store } = await newStore();
    const v = await store.schemaVersion();
    expect(v.applied).toBe(v.latest);
    expect(v.applied).toBeGreaterThanOrEqual(STEP);
    const tables = await store.listTables();
    for (const t of TABLES) expect(tables.find((x) => x.name === t), t).toBeDefined();
    expect(tables.find((x) => x.name === "filed_patterns")!.rows).toBe(0);
  });

  it("MySQL step 0031 creates the same tables with the same columns as SQLite migration 31", () => {
    const step = readSteps(STEPS_DIR, INLINE_STEPS).find((s) => s.number === STEP);
    expect(step?.file).toBe("0031-improve-reports.sql");
    const sql = readFileSync(join(STEPS_DIR, step!.file), "utf8");
    expect(splitSql(sql)).toHaveLength(TABLES.length);
    expect(columnsOf(sql)).toEqual(columnsOf(MIGRATIONS[STEP - 1]!));
  });
});

describe("improve: store methods", () => {
  it("enqueueRun queues a run with no transition; the same key again returns that run, created false", async () => {
    const { store } = await newStore();
    const { item } = await store.createWorkItem(issue(1), system);
    const first = await store.enqueueRun({ work_item_id: item.id, kind: "improve", idempotency_key: "k" });
    expect(first).toMatchObject({ created: true, run: { kind: "improve", status: "queued", idempotency_key: "k" } });
    const again = await store.enqueueRun({ work_item_id: item.id, kind: "improve", idempotency_key: "k" });
    expect(again).toEqual({ created: false, run: first.run });
    expect((await store.getWorkItem(item.id))!.version).toBe(item.version);
    expect((await store.listRuns(item.id)).map((r) => r.id)).toEqual([first.run.id]);
  });

  it("listRunsFinishedBetween returns runs finished in [start, end), oldest first", async () => {
    const { store, clock } = await newStore();
    const finish = async (n: number) => {
      await store.createWorkItem(issue(n), system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
      const run = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["triage"], lease_ms: 60_000 }))!;
      await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: "x", detail: "", infra: false });
      clock.advance(1_000);
      return run.id;
    };
    const start = clock.now().toISOString() as Timestamp;
    const a = await finish(1);
    const b = await finish(2);
    const end = clock.now().toISOString() as Timestamp;
    await finish(3);
    expect((await store.listRunsFinishedBetween(start, end)).map((r) => r.id)).toEqual([a, b]);
  });

  it("recordImproveReport stores one report per run; a second record keeps the first", async () => {
    const { store } = await newStore();
    const { item } = await store.createWorkItem(issue(1), system);
    const { run } = await store.enqueueRun({ work_item_id: item.id, kind: "improve", idempotency_key: "k" });
    const window = { window_start: "2026-01-01T00:00:00.000Z" as Timestamp, window_end: "2026-01-02T00:00:00.000Z" as Timestamp };
    const group = { error_code: "x", detail: "d", run_ids: ["r1" as RunId], work_item_ids: [item.id] };
    const first = await store.recordImproveReport({ run_id: run.id, project: item.project, ...window, groups: [], patterns: [group] });
    expect(first.created).toBe(true);
    const again = await store.recordImproveReport({ run_id: run.id, project: item.project, ...window, groups: [group], patterns: [] });
    expect(again).toEqual({ created: false, report: first.report });
    expect(await store.getImproveReport(run.id)).toEqual(first.report);
  });
});
