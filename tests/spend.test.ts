import { describe, expect, it } from "vitest";
import { SPEND_KINDS, readSpend, spendTotals } from "../src/core/spend.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

// Spend (design 06-spend) counts a routine's runs: `routine` is one of SPEND_KINDS, so a routine run's harness cost
// adds to the day's and the item's totals, and one with no cost is counted apart as unknown.

describe("spend counts routine runs", () => {
  it("SPEND_KINDS has routine, and a finished routine run adds its cost and tokens", async () => {
    expect(SPEND_KINDS).toContain("routine");
    const clock = new FakeClock("2026-11-23T09:00:00.000Z");
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem(issue(1), system);
    for (const [key, cost_usd] of [["r1", 0.25], ["r2", null]] as const) {
      await store.enqueueRun({ work_item_id: item.id, kind: "routine", idempotency_key: key, input: { routine: { instruction: "x", url: null } } });
      const run = (await store.claimRun({ worker_id: w1, kinds: ["routine"], lease_ms: 60_000 }))!;
      const usage = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd, model: null };
      await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { routine: { verdict: "pass", findings: [], summary: "s" }, usage } });
      clock.advance(60_000);
    }
    const runs = (await store.listRuns(item.id)).filter((r) => r.kind === "routine");
    expect(spendTotals(runs)).toMatchObject({ cost_usd: 0.25, runs: 2, unknown: 1 });
    const spend = await readSpend(store, "2026-11-23", "2026-11-23");
    expect(spend.items).toEqual([expect.objectContaining({ work_item_id: item.id, kinds: ["routine"], cost_usd: 0.25, runs: 2, unknown: 1 })]);
    expect(spend.days[0]).toMatchObject({ day: "2026-11-23", cost_usd: 0.25 });
  });
});
