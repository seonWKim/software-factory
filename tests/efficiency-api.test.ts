// GET /api/v1/efficiency (design 06-efficiency) over a store fake that has only the read methods the route may use:
// the hourly, daily and weekly windows by merge time, the week-over-week change, the not-counted numbers, adopted
// and unfinished items left out, titles through the Withholder, and a 405 for a POST (read-only).

import { describe, expect, it } from "vitest";
import { type MergeEvaluation, type MergeWindow, noVerdicts } from "../src/core/merge-evaluation.js";
import type { Run, RunOutcome, StateChange, StateChangeId, Tier, Timestamp, WorkItem, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, respond } from "../src/ui/server.js";

const NOW = "2026-11-20T12:30:00.000Z"; // a Friday; its ISO week starts 2026-11-16
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const SECRET = `ghp_${"Ab3".repeat(12)}`;
const iso = (ms: number) => new Date(ms).toISOString() as Timestamp;
const ago = (ms: number) => Date.parse(NOW) - ms;
const ok = (tokens: number, cost: number | null): RunOutcome => ({
  status: "succeeded", summary: "ok", data: { tokens, usage: { input_tokens: tokens, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: cost, model: null } },
});

const evaluation = (id: WorkItemId, tier: Tier | null, merged: number, over: Partial<MergeEvaluation> = {}): MergeEvaluation => ({
  work_item_id: id, project: "p", merge_sha: `sha-${id}`, tier, merged_by: "system:merge", merged_at: iso(merged), token_cost: 0, title: null,
  reverted: 0, fixed_forward: 0, verdicts: noVerdicts(), explicit: noVerdicts(), critical: 0, ...over,
});

/** A store fake: items, runs and merge evaluations in memory, with only the read methods efficiency uses. Writes throw. */
function fakeStore() {
  const items = new Map<WorkItemId, WorkItem>();
  const runs: Run[] = [];
  const merges: MergeEvaluation[] = [];
  const changes: StateChange[] = [];
  let n = 0;
  const reads = {
    async listMergeEvaluations(w: MergeWindow) {
      const since = w !== null && typeof w === "object" ? iso(Date.parse(NOW) - w.within_ms) : w;
      return merges.filter((m) => since === null || m.merged_at >= since);
    },
    async getWorkItem(id: WorkItemId) { return items.get(id) ?? null; },
    async listRuns(id: WorkItemId) { return runs.filter((r) => r.work_item_id === id); },
    async listStateChanges(id: WorkItemId) { return changes.filter((c) => c.work_item_id === id); },
    async listWorkItemsWhere(f: { stage?: string; updated_since?: Timestamp }) {
      return [...items.values()].filter((i) => (!f.stage || i.stage === f.stage) && (!f.updated_since || i.updated_at >= f.updated_since));
    },
  };
  const store = new Proxy(reads, {
    get: (t, k) => (k in t ? t[k as keyof typeof t] : () => { throw new Error(`write or unexpected read: ${String(k)}`); }),
  }) as unknown as FactoryStore;
  return {
    store,
    /** A finished item created `took` before its merge `mergedAgo` ago, with runs of [hours, tokens, cost] each. */
    finished(title: string, mergedAgo: number, took: number, runSpecs: [number, number | null, number | null][], over: Partial<WorkItem> = {}) {
      const id = `wi_${++n}` as WorkItemId;
      const merged = ago(mergedAgo);
      items.set(id, { id, title, stage: "CLOSED", close_reason: "completed", origin: "factory", created_at: iso(merged - took), updated_at: iso(merged), ...over } as WorkItem);
      let t = merged - took;
      for (const [hours, tokens, cost] of runSpecs) {
        runs.push({ id: `r${++n}`, work_item_id: id, kind: "implement", outcome: tokens === null ? null : ok(tokens, cost), started_at: iso(t), finished_at: iso(t + hours * HOUR), session_tokens: null } as Run);
        t += hours * HOUR;
      }
      merges.push(evaluation(id, null, merged, { title }));
      return id;
    },
    /** A merge evaluation only (no item, so not a finished item), of `tier`, merged `mergedAgo` ago. */
    merged(tier: Tier | null, mergedAgo: number, over: Partial<MergeEvaluation> = {}) {
      merges.push(evaluation(`wi_${++n}` as WorkItemId, tier, ago(mergedAgo), over));
      merges.sort((a, b) => a.merged_at.localeCompare(b.merged_at));
    },
    /** An ask of `reason` on item `id`, `askedAgo` ago, answered `after` later by a state change of `answer` (null: unanswered). */
    asked(id: WorkItemId, reason: string, askedAgo: number, answer: { reason: string; after: number } | null) {
      const at = ago(askedAgo);
      const row = (version: number, ms: number, r: string, detail: StateChange["detail"]) =>
        ({ id: `sc_${++n}` as StateChangeId, work_item_id: id, version, at: iso(ms), actor: { kind: "system", id: "system:test" }, reason: r, changes: {}, detail }) as StateChange;
      const version = changes.filter((c) => c.work_item_id === id).length + 2;
      changes.push(row(version, at, reason, { ask_reason: reason, ask_tier: 2 }));
      if (answer) changes.push(row(version + 1, at + answer.after, answer.reason, null));
    },
    /** Marks the merge of item `id` reverted. */
    reverted(id: WorkItemId) {
      const i = merges.findIndex((m) => m.work_item_id === id);
      merges[i] = { ...merges[i]!, reverted: 1 };
    },
    closed(close_reason: WorkItem["close_reason"], closedAgo: number) {
      const id = `wi_${++n}` as WorkItemId;
      items.set(id, { id, title: "x", stage: "CLOSED", close_reason, origin: "factory", created_at: iso(ago(closedAgo + HOUR)), updated_at: iso(ago(closedAgo)) } as WorkItem);
    },
  };
}

function deps(store: FactoryStore): UiDeps {
  const clock = new FakeClock(NOW);
  return { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock) };
}

async function get(d: UiDeps) {
  const r = await respond(d, { method: "GET", url: "/api/v1/efficiency", host: "127.0.0.1:4310" });
  return { status: r.status, body: JSON.parse(r.body!) as Record<string, any> };
}

describe("GET /api/v1/efficiency", () => {
  it("counts finished items by merge time in 24 hourly, 14 daily and 8 weekly bars with totals", async () => {
    const f = fakeStore();
    f.finished("A", HOUR / 4, DAY, [[1, 10, 1]]); // this hour
    f.finished("B", 3 * HOUR, DAY, [[1, 10, 1]]); // today
    f.finished("C", 2 * DAY, DAY, [[1, 10, 1]]); // this week, not the last 24 hours
    f.finished("D", 10 * DAY, DAY, [[1, 10, 1]]); // last week
    f.finished("E", 30 * DAY, DAY, [[1, 10, 1]]); // weeks ago, not in the 14 days
    f.finished("F", 20 * WEEK, DAY, [[1, 10, 1]]); // older than the 8 weeks
    const { status, body } = await get(deps(f.store));
    expect(status).toBe(200);
    expect(body.hours.bars).toHaveLength(24);
    expect(body.hours.bars.at(-1)).toEqual({ start: "2026-11-20T12:00:00.000Z", count: 1 });
    expect(body.hours.total).toBe(2);
    expect(body.days.bars).toHaveLength(14);
    expect(body.days.total).toBe(4);
    expect(body.weeks.bars).toHaveLength(8);
    expect(body.weeks.bars.at(-1).start).toBe("2026-11-16T00:00:00.000Z");
    expect(body.weeks.total).toBe(5);
    expect(body.week_figures.map((w: any) => w.finished)).toEqual(body.weeks.bars.map((b: any) => b.count));
  });

  it("gives each week's change from the week before, none when the week before had nothing", async () => {
    const f = fakeStore();
    // Last week: 2 items of 10 h total and 1000 tokens each. This week: 1 item of 8.2 h and 820 tokens.
    f.finished("L1", WEEK, 10 * HOUR, [[2, 1000, 1]]);
    f.finished("L2", WEEK + HOUR, 10 * HOUR, [[2, 1000, 2]]);
    f.finished("T1", HOUR, 8.2 * HOUR, [[2, 820, 3]]);
    const { body } = await get(deps(f.store));
    const [before, last, cur] = body.week_figures.slice(-3);
    expect(before.finished).toBe(0);
    expect(last.finished_change).toBeNull();
    expect(last.tokens.median_change).toBeNull();
    expect(cur.current).toBe(true);
    expect(cur.finished_change).toBe(-50);
    expect(cur.tokens).toMatchObject({ median: 820, median_change: -18, p90_change: -18 });
    expect(cur.total).toMatchObject({ median: 29_520_000, median_change: -18 }); // 8.2 hours
    expect(cur.agent).toMatchObject({ median: 2 * HOUR, median_change: 0 });
    expect(last.costliest.map((i: any) => i.title)).toEqual(["L2", "L1"]);
  });

  it("shows the not-counted numbers: runs without usage, items without timing, and the items left out", async () => {
    const f = fakeStore();
    f.finished("ok", HOUR, DAY, [[1, 100, 1]]);
    f.finished("no usage", HOUR, DAY, [[1, 100, 1], [1, null, null]]);
    f.closed("wont_do", DAY);
    f.closed("rejected", DAY);
    f.closed("failed", 2 * DAY);
    f.finished("adopted", HOUR, DAY, [[1, 100, 1]], { origin: "adopted" });
    const { body } = await get(deps(f.store));
    const cur = body.week_figures.at(-1);
    expect(cur.finished).toBe(2);
    expect(cur.tokens).toMatchObject({ median: 100, not_counted: 1 });
    expect(body.runs_without_usage).toBe(1);
    expect(body.left_out).toEqual({ total: 3, cancelled: 1, rejected: 1, failed: 1 });
  });

  it("lists the week's slowest and costliest items with their titles through the Withholder", async () => {
    const f = fakeStore();
    f.finished("Fast", HOUR, HOUR * 2, [[1, 10, 5]]);
    f.finished(`Slow ${SECRET}`, HOUR, DAY, [[1, 10, 1]]);
    const { body } = await get(deps(f.store));
    const cur = body.week_figures.at(-1);
    expect(cur.slowest.map((i: any) => i.title)).toEqual(["[withheld: github_token]", "Fast"]);
    expect(cur.costliest.map((i: any) => i.title)).toEqual(["Fast", "[withheld: github_token]"]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("gives each week's human touches per merged item, median hours waiting on the owner and revert rate; a week with no asks has no data", async () => {
    const f = fakeStore();
    const a = f.finished("A", HOUR, DAY, [[1, 10, 1]]);
    const b = f.finished("B", 2 * HOUR, DAY, [[1, 10, 1]]);
    f.asked(a, "spec_pending", DAY - HOUR, { reason: "spec_approved", after: 2 * HOUR });
    f.asked(a, "run_failed", 10 * HOUR, { reason: "retry_requested", after: 4 * HOUR });
    f.asked(b, "max_loops", 8 * HOUR, null);
    f.reverted(b);
    f.finished("L", WEEK, DAY, [[1, 10, 1]]); // last week: merged, no ask
    const { body } = await get(deps(f.store));
    const [last, cur] = body.week_figures.slice(-2);
    expect(cur.owner).toEqual({ merged: 2, asks: 3, touches_per_merged: 1.5, wait_hours_median: 3, revert_rate: 0.5, reverted_or_fixed: 1 });
    expect(last.owner).toMatchObject({ merged: 1, asks: 0, touches_per_merged: null, wait_hours_median: null, revert_rate: 0 });
  });

  it("carries the per-tier merge record and rule result, tiers 1 to 5 then untiered, the same as factory stats", async () => {
    const f = fakeStore();
    for (let i = 0; i < 50; i++) f.merged(2, 60 * DAY + i * HOUR); // old: in the rule's sample only
    f.merged(2, DAY, { fixed_forward: 1, explicit: { ...noVerdicts(), changes: 1, accept: 2 } });
    f.merged(4, DAY);
    f.merged(null, 2 * DAY, { critical: 1, explicit: { ...noVerdicts(), reject: 1 } });
    const { body } = await get(deps(f.store));
    expect(body.merges.map((r: any) => r.tier)).toEqual([1, 2, 3, 4, 5, null]);
    expect(body.merges[1]).toEqual({
      tier: 2, merged: 1, reverted_or_fixed: 1, not_accept: 1, sample: 50, sample_bad: 1, sample_critical: 0, rule: "met", qualifies: true,
    });
    expect(body.merges[3]).toMatchObject({ tier: 4, merged: 1, rule: "never", qualifies: false });
    expect(body.merges[5]).toMatchObject({ tier: null, merged: 1, not_accept: 1, sample_critical: 1, rule: "too_few", qualifies: false });
    expect(body.merges[0]).toMatchObject({ tier: 1, merged: 0, sample: 0, rule: "too_few", qualifies: false });
  });

  it("is read-only: a POST gets 405", async () => {
    const f = fakeStore();
    const d = deps(f.store);
    expect((await respond(d, { method: "POST", url: "/api/v1/efficiency", host: "127.0.0.1:4310" })).status).toBe(405);
  });
});
