import { describe, expect, it } from "vitest";
import type { Run, WorkerId } from "../src/core/types.js";
import { SystemClock } from "../src/impl/clock/system-clock.js";
import { MYSQL_URL, issue, newMysqlDatabase, system } from "./helpers/store.js";

// Several stores, each with its own connection pool: the shape of N workers on N hosts sharing one database.

const WORKERS = 4;
const RUNS = 40;

describe.skipIf(!MYSQL_URL)("SqlFactoryStore on MySQL across workers", () => {
  it("every run is claimed exactly once", async () => {
    const { store, open } = await newMysqlDatabase(new SystemClock());
    for (let i = 0; i < RUNS; i++) {
      await store.createWorkItem(issue(i), system, { enqueue: { kind: "triage", idempotency_key: `k${i}` } });
    }

    const work = async (w: number) => {
      const s = open();
      const claimed: string[] = [];
      for (;;) {
        const run = await s.claimRun({ worker_id: `w${w}` as WorkerId, kinds: ["triage"], lease_ms: 60_000 });
        if (!run) return claimed;
        claimed.push(run.id);
        const done = await s.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "", data: {} });
        expect(done.ok).toBe(true);
      }
    };
    const all = (await Promise.all(Array.from({ length: WORKERS }, (_, w) => work(w)))).flat();
    expect(all).toHaveLength(RUNS);
    expect(new Set(all).size).toBe(RUNS);
    expect(await store.listUnacknowledgedRuns(RUNS + 1)).toHaveLength(RUNS);
  }, 30_000);

  it("several claimers at once never hand out two implement-type runs of one item", async () => {
    const { store, open } = await newMysqlDatabase(new SystemClock());
    // Overlapping paths on purpose: they no longer hold runs back; only a second run of the same item does.
    const shapes = [["src/"], ["src/core/a.ts"], ["src/core/"], ["docs/"], ["docs/x.md"], ["tests/a.ts"], ["src/impl/b.ts"]];
    const ITEMS = 21;
    for (let i = 0; i < ITEMS; i++) {
      const { item } = await store.createWorkItem(issue(i), system);
      const allowed_paths = shapes[i % shapes.length]!;
      await store.transition({
        id: item.id, expected_version: 1, patch: { allowed_paths }, actor: system, reason: "x",
        enqueue: { kind: "implement", idempotency_key: `k${i}` },
      });
      await store.transition({
        id: item.id, expected_version: 2, patch: {}, actor: system, reason: "x",
        enqueue: { kind: "update", idempotency_key: `u${i}` },
      });
    }

    // What this test believes is running: added after a claim commits, removed before its completion commits,
    // so it is always a subset of what the store has running.
    const running = new Map<string, Run>();
    const violations: string[] = [];
    let maxAtOnce = 0;
    const work = async (w: number) => {
      const s = open();
      let idle = 0;
      while (idle < 400) {
        const run = await s.claimRun({ worker_id: `w${w}` as WorkerId, kinds: ["implement", "update"], lease_ms: 60_000 });
        if (!run) {
          if (running.size === 0 && (await s.listRunsByStatus(["queued"], 1)).length === 0) return;
          idle++;
          await new Promise((r) => setTimeout(r, 5));
          continue;
        }
        idle = 0;
        for (const other of running.values()) {
          if (other.work_item_id === run.work_item_id) {
            violations.push(`${run.work_item_id} with ${other.work_item_id}`);
          }
        }
        running.set(run.id, run);
        maxAtOnce = Math.max(maxAtOnce, running.size);
        // Hold the run until another claimer has one too (or 200 ms pass), so "side by side" is observed
        // on a slow machine as well, not only when two claims happen to land within a couple of ms.
        for (let t = 0; t < 40 && running.size < 2; t++) await new Promise((r) => setTimeout(r, 5));
        maxAtOnce = Math.max(maxAtOnce, running.size);
        running.delete(run.id);
        const done = await s.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "", data: {} });
        expect(done.ok).toBe(true);
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, (_, w) => work(w)));
    expect(violations).toEqual([]);
    expect(await store.listUnacknowledgedRuns(2 * ITEMS + 1)).toHaveLength(2 * ITEMS);
    // Items with overlapping paths ran side by side.
    expect(maxAtOnce).toBeGreaterThan(1);
  }, 30_000);

  it("concurrent intake of the same issue creates one item and one run", async () => {
    const { open } = await newMysqlDatabase(new SystemClock());
    const enqueue = { kind: "triage" as const, idempotency_key: "o/r#1:triage" };
    const results = await Promise.all(
      Array.from({ length: WORKERS }, () => open().createWorkItem(issue(1), system, { enqueue })),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.item.id)).size).toBe(1);
    expect(await open().listRuns(results[0]!.item.id)).toHaveLength(1);
  }, 30_000);

  it("concurrent transitions on one version: exactly one wins", async () => {
    const { store, open } = await newMysqlDatabase(new SystemClock());
    const { item } = await store.createWorkItem(issue(1), system);
    const results = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        open().transition({ id: item.id, expected_version: 1, patch: { loop_count: i + 1 }, actor: system, reason: "race" }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "version_conflict")).toHaveLength(WORKERS - 1);
    expect(await store.listStateChanges(item.id)).toHaveLength(2);
  }, 30_000);
});
