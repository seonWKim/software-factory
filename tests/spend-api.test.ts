// GET /api/v1/spend?from=&to= (design 06-spend): cost, tokens and run count per UTC day and per work item, summed
// from the stored run outcomes; runs with no stored cost counted apart as unknown, never as 0; read-only (GET and
// HEAD answer, a POST gets 405); titles through the Withholder.

import { describe, expect, it } from "vitest";
import type { RunKind, RunOutcome, WorkItem, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, respond } from "../src/ui/server.js";
import { issue, newStore, system } from "./helpers/store.js";

const HOUR = 3_600_000;
const SECRET = `ghp_${"Ab3".repeat(12)}`;
const usage = (cost_usd: number | null, tokens: number) => ({
  input_tokens: tokens, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd, model: null,
});
const succeeded = (cost: number | null, tokens: number): RunOutcome => ({ status: "succeeded", summary: "ok", data: { tokens, usage: usage(cost, tokens) } });
const failed = (cost: number | null, tokens: number): RunOutcome => ({ status: "failed", error_code: "tests_failed", detail: "x", infra: false, usage: usage(cost, tokens) });

async function setup() {
  const { store, clock } = await newStore(); // 2026-01-01T00:00Z
  const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock) };
  return { d, store, clock };
}

let n = 0;
/** Finishes one run of `kind` on `item` (a new item when absent) with `outcome`, at the store clock's now. */
async function run(store: FactoryStore, outcome: RunOutcome, item?: WorkItem, kind: RunKind = "implement", title?: string): Promise<WorkItem> {
  const k = ++n;
  const it = item ?? (await store.createWorkItem({ ...issue(k), ...(title ? { title } : {}) }, system)).item;
  await store.enqueueRun({ work_item_id: it.id, kind, idempotency_key: `s${k}` });
  const r = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: [kind], lease_ms: 60_000 }))!;
  await store.completeRun(r.id, r.lease!.token, outcome);
  return it;
}

async function get(d: UiDeps, path: string, method = "GET") {
  const r = await respond(d, { method, url: path, host: "127.0.0.1:4310" });
  return { status: r.status, body: r.body ? (JSON.parse(r.body) as Record<string, any>) : null };
}

describe("GET /api/v1/spend", () => {
  it("totals by UTC day and by item equal the sum of the stored costs", async () => {
    const { d, store, clock } = await setup();
    clock.advance(10 * HOUR); // 2026-01-01
    const a = await run(store, succeeded(1.25, 1000));
    const b = await run(store, failed(0.5, 200), undefined, "triage");
    clock.advance(24 * HOUR); // 2026-01-02
    await run(store, succeeded(2, 3000), a, "review");
    await run(store, succeeded(0.25, 100), b);

    const body = (await get(d, "/api/v1/spend?from=2026-01-01&to=2026-01-02")).body!;
    expect(body.days.map((x: any) => [x.day, x.cost_usd, x.tokens, x.runs])).toEqual([
      ["2026-01-01", 1.75, 1200, 2],
      ["2026-01-02", 2.25, 3100, 2],
    ]);
    expect(body.total).toEqual({ cost_usd: 4, tokens: 4300, runs: 4, unknown: 0 });
    const byItem = Object.fromEntries(body.items.map((x: any) => [x.work_item_id, [x.cost_usd, x.tokens, x.runs, x.kinds]]));
    expect(byItem).toEqual({ [a.id]: [3.25, 4000, 2, ["implement", "review"]], [b.id]: [0.75, 300, 2, ["triage", "implement"]] });
    // Sorted by cost, highest first.
    expect(body.items.map((x: any) => x.work_item_id)).toEqual([a.id, b.id]);
  });

  it("counts runs with no stored cost apart as unknown, never adding them as 0", async () => {
    const { d, store, clock } = await setup();
    clock.advance(HOUR);
    const a = await run(store, succeeded(1.5, 100));
    await run(store, succeeded(null, 400), a);
    await run(store, { status: "succeeded", summary: "old row", data: { tokens: 50 } }, a);
    const body = (await get(d, "/api/v1/spend?from=2026-01-01&to=2026-01-01")).body!;
    expect(body.total).toEqual({ cost_usd: 1.5, tokens: 550, runs: 3, unknown: 2 });
    expect(body.days[0]).toMatchObject({ cost_usd: 1.5, unknown: 2 });
    expect(body.items[0]).toMatchObject({ work_item_id: a.id, cost_usd: 1.5, runs: 3, unknown: 2 });
  });

  it("lists every day of the range, zero where nothing ran, and leaves out runs outside it", async () => {
    const { d, store, clock } = await setup();
    clock.advance(HOUR);
    await run(store, succeeded(9, 9)); // 2026-01-01: before the range
    clock.advance(3 * 24 * HOUR); // 2026-01-04
    await run(store, succeeded(1, 1));
    const body = (await get(d, "/api/v1/spend?from=2026-01-02&to=2026-01-04")).body!;
    expect(body.days.map((x: any) => [x.day, x.cost_usd])).toEqual([["2026-01-02", 0], ["2026-01-03", 0], ["2026-01-04", 1]]);
    expect(body.total.cost_usd).toBe(1);
  });

  it("defaults to the last 30 UTC days and names today and the week's Monday", async () => {
    const { d, clock } = await setup();
    clock.advance(12 * 24 * HOUR); // Tuesday 2026-01-13
    const body = (await get(d, "/api/v1/spend")).body!;
    expect(body).toMatchObject({ from: "2025-12-15", to: "2026-01-13", today: "2026-01-13", week_start: "2026-01-12" });
    expect(body.days).toHaveLength(30);
  });

  it("answers 400 for a bad from or to", async () => {
    const { d } = await setup();
    for (const q of ["from=2026-1-1", "to=yesterday", "from=2026-02-30", "from=2026-01-05&to=2026-01-01", "from=2020-01-01&to=2026-01-01"]) {
      expect((await get(d, `/api/v1/spend?${q}`)).status, q).toBe(400);
    }
  });

  it("is read-only: GET and HEAD answer, a POST gets 405, and nothing is written", async () => {
    const { d, store, clock } = await setup();
    clock.advance(HOUR);
    await run(store, succeeded(1, 1));
    const before = JSON.stringify(await store.listRunsFinishedWithin(24 * HOUR));
    expect((await get(d, "/api/v1/spend")).status).toBe(200);
    expect((await respond(d, { method: "HEAD", url: "/api/v1/spend", host: "127.0.0.1:4310" })).status).toBe(200);
    expect((await respond(d, { method: "POST", url: "/api/v1/spend", host: "127.0.0.1:4310" })).status).toBe(405);
    expect(JSON.stringify(await store.listRunsFinishedWithin(24 * HOUR))).toBe(before);
  });

  it("passes item titles through the Withholder", async () => {
    const { d, store, clock } = await setup();
    clock.advance(HOUR);
    await run(store, succeeded(1, 1), undefined, "implement", `fix token ${SECRET}`);
    const text = JSON.stringify((await get(d, "/api/v1/spend")).body);
    expect(text).not.toContain(SECRET);
    expect(text).toMatch(/\[withheld: [^\]]+\]/);
  });
});
