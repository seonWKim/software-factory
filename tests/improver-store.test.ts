import { describe, expect, it } from "vitest";
import type { RunId, Timestamp, WorkItemId, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { BACKENDS, OTHER_PROJECT_KEY, PROJECT_KEY, issue, system } from "./helpers/store.js";

/** Item `n` of `project` with one triage run, failed at the clock's now. */
async function finished(store: FactoryStore, n: number, project = PROJECT_KEY) {
  await store.createWorkItem({ ...issue(n), project }, system, { enqueue: { kind: "triage", idempotency_key: `k:${n}` } });
  const run = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["triage"], lease_ms: 60_000 }))!;
  await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: "e", detail: "d", infra: false });
  return (await store.getRun(run.id))!;
}

for (const backend of BACKENDS) {
  describe(`improve store (${backend.name})`, () => {
    it("enqueueRun queues on an existing item once per key, with no state change", async () => {
      const { store } = await backend.make();
      const { item } = await store.createWorkItem(issue(1), system);
      const first = await store.enqueueRun({ work_item_id: item.id, kind: "improve", idempotency_key: "improve:x", input: { improve: { start: "a" as Timestamp, end: "b" as Timestamp } } });
      const again = await store.enqueueRun({ work_item_id: item.id, kind: "improve", idempotency_key: "improve:x" });
      expect(first.created).toBe(true);
      expect(again).toEqual({ run: first.run, created: false });
      expect(first.run).toMatchObject({ kind: "improve", status: "queued", input: { improve: { start: "a", end: "b" } } });
      expect((await store.getWorkItem(item.id))!.version).toBe(item.version);
      expect((await store.listRuns(item.id)).map((r) => r.id)).toEqual([first.run.id]);
    });

    it("an improve run is claimed through the common claim path", async () => {
      const { store } = await backend.make();
      const { item } = await store.createWorkItem(issue(1), system);
      const { run } = await store.enqueueRun({ work_item_id: item.id, kind: "improve", idempotency_key: "improve:y" });
      const claimed = await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["triage", "improve"], lease_ms: 60_000 });
      expect(claimed).toMatchObject({ id: run.id, status: "running", attempt: 1 });
    });

    it("listRunsFinishedBetween: start inclusive, end exclusive, only the project's items, oldest first", async () => {
      const { store, clock } = await backend.make();
      const start = clock.now().toISOString() as Timestamp;
      clock.advance(-1);
      const early = await finished(store, 1);
      clock.advance(1);
      const atStart = await finished(store, 2);
      clock.advance(1_000);
      const mid = await finished(store, 3);
      const other = await finished(store, 4, OTHER_PROJECT_KEY);
      clock.advance(1_000);
      const end = clock.now().toISOString() as Timestamp;
      const atEnd = await finished(store, 5);
      const ids = (await store.listRunsFinishedBetween(PROJECT_KEY, start, end)).map((r) => r.id);
      expect(ids).toEqual([atStart.id, mid.id]);
      for (const out of [early, atEnd, other]) expect(ids).not.toContain(out.id);
    });

    it("a report is stored once per run and read back as written", async () => {
      const { store } = await backend.make();
      const { item } = await store.createWorkItem(issue(1), system);
      const { run } = await store.enqueueRun({ work_item_id: item.id, kind: "improve", idempotency_key: "improve:z" });
      const group = { error_code: "e", detail: "d", run_ids: ["run_1", "run_2"] as RunId[], work_item_ids: [item.id as WorkItemId] };
      const body = {
        run_id: run.id, project: PROJECT_KEY, window_start: "2026-01-01T00:00:00.000Z" as Timestamp, window_end: "2026-01-02T00:00:00.000Z" as Timestamp,
        groups: [group], singles: [{ ...group, run_ids: ["run_3"] as RunId[] }],
      };
      const first = await store.recordImproveReport(body);
      const again = await store.recordImproveReport({ ...body, groups: [] });
      expect(first.created).toBe(true);
      expect(again).toEqual({ report: first.report, created: false });
      expect(await store.getImproveReport(run.id)).toEqual(first.report);
      expect(await store.getImproveReport("run_none" as RunId)).toBeNull();
      expect((await store.listImproveReports(PROJECT_KEY, 10)).map((r) => r.run_id)).toContain(run.id);
      expect(await store.listImproveReports(OTHER_PROJECT_KEY, 10)).toEqual([]);
    });

    it("the report and filed-pattern tables exist; nothing writes a filed pattern", async () => {
      const { store } = await backend.make();
      const tables = await store.listTables();
      expect(tables.find((t) => t.name === "improve_reports")).toBeDefined();
      expect(tables.find((t) => t.name === "filed_patterns")?.rows).toBe(0);
    });
  });
}
