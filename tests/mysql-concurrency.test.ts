import { describe, expect, it } from "vitest";
import type { WorkerId } from "../src/core/types.js";
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
