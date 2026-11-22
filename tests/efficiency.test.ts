// The counting rules of efficiency (design 06-efficiency): every run of a finished item adds its tokens (retries
// too); cancelled, rejected and failed items are left out and counted apart; a run without stored usage leaves its
// item out of the token figures, counted apart, never added as 0; median and nearest-rank 90th percentile.

import { describe, expect, it } from "vitest";
import { type FinishedItem, change, itemFigures, median, ownerFigures, p90, runHasUsage, summarizeEfficiency } from "../src/core/efficiency.js";
import type { CloseReason, Run, RunKind, RunOutcome, StateChange, Timestamp, WorkItem, WorkItemId } from "../src/core/types.js";

const NOW = Date.parse("2026-11-20T12:30:00.000Z"); // a Friday; its ISO week starts 2026-11-16
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString() as Timestamp;

const usage = (tokens: number, cost_usd: number | null = null) => ({ input_tokens: tokens, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd, model: null });
const ok = (tokens: number, cost: number | null = null): RunOutcome => ({ status: "succeeded", summary: "ok", data: { tokens, usage: usage(tokens, cost) } });

function item(id: string, created: number, over: Partial<WorkItem> = {}): WorkItem {
  return { id: id as WorkItemId, title: `Item ${id}`, stage: "CLOSED", close_reason: "completed", origin: "factory", created_at: iso(created), updated_at: iso(created), ...over } as WorkItem;
}

let n = 0;
function run(itemId: string, start: number, end: number, outcome: RunOutcome | null, kind: RunKind = "implement"): Run {
  return { id: `r${++n}`, work_item_id: itemId as WorkItemId, kind, outcome, started_at: iso(start), finished_at: iso(end), session_tokens: null } as Run;
}

function finished(id: string, created: number, merged: number, runs: Run[]): FinishedItem {
  return { item: item(id, created), merged_at: iso(merged), runs };
}

describe("efficiency counting rules", () => {
  it("adds the tokens of every run of an item: a retry adds its tokens", () => {
    const t0 = NOW - 5 * HOUR;
    const f = itemFigures(finished("a", t0, NOW - HOUR, [run("a", t0, t0 + HOUR, ok(1000, 1)), run("a", t0 + 2 * HOUR, t0 + 3 * HOUR, ok(500, 0.5)), run("a", t0 + 3 * HOUR, t0 + 3.5 * HOUR, ok(200), "review")]));
    expect(f.tokens).toBe(1700);
    expect(f.cost_usd).toBe(1.5);
    expect(f.total_ms).toBe(4 * HOUR);
    expect(f.agent_ms).toBe(2.5 * HOUR);
    expect(f.waiting_ms).toBe(1.5 * HOUR);
  });

  it("leaves a cancelled (won't do) item out of the finished figures and counts it apart", () => {
    const done = finished("a", NOW - 3 * HOUR, NOW - HOUR, [run("a", NOW - 3 * HOUR, NOW - 2 * HOUR, ok(100))]);
    const closed = (id: string, close_reason: CloseReason) => item(id, NOW - 10 * HOUR, { close_reason, updated_at: iso(NOW - 2 * HOUR) });
    const e = summarizeEfficiency([done], [closed("b", "wont_do"), closed("c", "duplicate"), closed("d", "rejected"), closed("e", "failed"), closed("f", "completed")], NOW);
    const week = e.week_figures.at(-1)!;
    expect(week.finished).toBe(1);
    expect(e.weeks.total).toBe(1);
    expect(e.left_out).toEqual({ total: 4, cancelled: 2, rejected: 1, failed: 1 });
  });

  it("counts a run without usage apart: the item is not in the token figures, and its tokens are not 0", () => {
    const t0 = NOW - 10 * HOUR;
    const bare = run("b", t0, t0 + HOUR, { status: "failed", error_code: "x", detail: "x", infra: true });
    expect(runHasUsage(bare)).toBe(false);
    expect(runHasUsage(run("b", t0, t0, null))).toBe(false);
    const a = finished("a", t0, NOW - HOUR, [run("a", t0, t0 + HOUR, ok(1000))]);
    const b = finished("b", t0, NOW - HOUR, [run("b", t0, t0 + HOUR, ok(9000)), bare]);
    expect(itemFigures(b).tokens).toBeNull();
    expect(itemFigures(b).runs_without_usage).toBe(1);
    const e = summarizeEfficiency([a, b], [], NOW);
    const week = e.week_figures.at(-1)!;
    expect(week.tokens).toMatchObject({ median: 1000, p90: 1000, not_counted: 1 });
    expect(e.runs_without_usage).toBe(1);
  });

  it("leaves an item with a run missing a start or finish out of the time figures, counted apart", () => {
    const t0 = NOW - 10 * HOUR;
    const untimed = { ...run("b", t0, t0 + HOUR, ok(10)), started_at: null };
    const e = summarizeEfficiency([finished("a", t0, NOW - HOUR, [run("a", t0, t0 + HOUR, ok(10))]), finished("b", t0, NOW - HOUR, [untimed])], [], NOW);
    const week = e.week_figures.at(-1)!;
    expect(week.agent).toMatchObject({ median: HOUR, not_counted: 1 });
    expect(week.total.not_counted).toBe(1);
  });

  it("median, nearest-rank 90th percentile, and the change from the week before", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
    expect(p90([5])).toBe(5);
    expect(p90([])).toBeNull();
    expect(change(82, 100)).toBe(-18);
    expect(change(105, 100)).toBe(5);
    expect(change(5, 0)).toBeNull();
    expect(change(5, null)).toBeNull();
  });

  it("counts by merge time in hourly, daily and weekly bars ending now; a week with nothing shows no data", () => {
    const e = summarizeEfficiency([finished("a", NOW - 50 * HOUR, NOW - 30 * 60_000, []), finished("b", NOW - 50 * HOUR, NOW - 26 * HOUR, [])], [], NOW);
    expect(e.hours.bars[e.hours.bars.length - 1]).toEqual({ start: "2026-11-20T12:00:00.000Z", count: 1 });
    expect(e.hours.total).toBe(1);
    expect(e.days.bars.at(-1)!.start).toBe("2026-11-20T00:00:00.000Z");
    expect(e.days.total).toBe(2);
    expect(e.weeks.bars.at(-1)!.start).toBe("2026-11-16T00:00:00.000Z");
    expect(e.week_figures.at(-1)).toMatchObject({ start: "2026-11-16", current: true, finished: 2 });
    const empty = e.week_figures.at(-2)!;
    expect(empty).toMatchObject({ current: false, finished: 0 });
    expect(empty.tokens.median).toBeNull();
    expect(empty.total.p90).toBeNull();
  });

  it("owner figures: asks per merged item, the median wait in hours and the revert rate; no asks give no data, never 0", () => {
    const sc = (version: number, at: number, reason: string, detail: StateChange["detail"] = null) =>
      ({ work_item_id: "a" as WorkItemId, version, at: iso(at), reason, changes: {}, detail }) as StateChange;
    const asked = [sc(2, NOW - 5 * HOUR, "spec_pending", { ask_reason: "spec_pending", ask_tier: 1 }), sc(3, NOW - 4 * HOUR, "spec_approved")];
    expect(ownerFigures([{ changes: asked, reverted_or_fixed: false }, { changes: [], reverted_or_fixed: true }])).toEqual({
      merged: 2, asks: 1, touches_per_merged: 0.5, wait_hours_median: 1, revert_rate: 0.5, reverted_or_fixed: 1,
    });
    expect(ownerFigures([{ changes: [sc(2, NOW, "triaged")], reverted_or_fixed: false }])).toMatchObject({ asks: 0, touches_per_merged: null, wait_hours_median: null, revert_rate: 0 });
    expect(ownerFigures([])).toMatchObject({ touches_per_merged: null, wait_hours_median: null, revert_rate: null });
    const e = summarizeEfficiency([{ ...finished("a", NOW - 10 * HOUR, NOW - HOUR, []), changes: asked }], [], NOW);
    expect(e.week_figures.at(-1)!.owner).toMatchObject({ merged: 1, asks: 1, touches_per_merged: 1, wait_hours_median: 1 });
    expect(e.week_figures.at(-2)!.owner).toMatchObject({ merged: 0, touches_per_merged: null, wait_hours_median: null, revert_rate: null });
  });
});
