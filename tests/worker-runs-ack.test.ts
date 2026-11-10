import { describe, expect, it } from "vitest";
import type { SqlValue } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// Issue #461: listUnacknowledgedRuns walks worker_runs_ack (acknowledged_at, updated_at) instead of scanning every
// run. The query is the store's own, captured as it runs, so the plan checked is the one the store asks for.

describe("worker_runs_ack", () => {
  it("exists on a fresh SQLite database", async () => {
    const { store } = await newStore();
    const [row] = await store.db.all("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'worker_runs_ack'");
    expect(String(row?.sql)).toMatch(/ON worker_runs \(acknowledged_at, updated_at\)/);
  });

  it("is the plan for listUnacknowledgedRuns, which no longer scans all of worker_runs", async () => {
    const { store } = await newStore();
    const seen: { sql: string; params: readonly SqlValue[] }[] = [];
    const all = store.db.all.bind(store.db);
    store.db.all = (sql, params) => {
      seen.push({ sql, params: params ?? [] });
      return all(sql, params);
    };
    await store.listUnacknowledgedRuns(20);
    store.db.all = all;
    const query = seen.find((q) => /FROM worker_runs\b/.test(q.sql));
    expect(query).toBeDefined();
    const plan = (await store.db.all(`EXPLAIN QUERY PLAN ${query!.sql}`, query!.params)).map((r) => String(r.detail));
    expect(plan.some((d) => /worker_runs USING INDEX worker_runs_ack\b/.test(d))).toBe(true);
    expect(plan.filter((d) => /^SCAN worker_runs$/.test(d))).toEqual([]);
  });
});
