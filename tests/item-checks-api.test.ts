import { describe, expect, it } from "vitest";
import type { DoneCheck } from "../src/core/done-checks.js";
import type { RunOutcome, WorkItem } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiDeps } from "../src/ui/server.js";
import { newStore, w1 } from "./helpers/store.js";
import { LEASE, SECRET, enqueue, json, make, patch } from "./ui-api-fixtures.js";

// The item page's done-when checks (design 09-dashboard-item, RFC 0024 WP3 phase 3): GET /api/v1/items/:id returns
// `item.checks`, each done-when line with its check and the newest implement run's result; null for an item with no
// done_checks; a failed line carries that run's output tail; every text through the Withholder.

const CHECKS: DoneCheck[] = [
  { line: "The lint passes", command: "npm run lint" },
  { line: "The page test passes", test_file: "tests/ui-item-checks.test.tsx" },
  { line: "It reads well", manual: true, reason: "wording is a judgement" },
];

type Checks = { item: { checks: unknown } };

async function setup() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: LEASE, health: new HealthMonitor(async () => [], clock) };
  return { store, clock, d };
}

/** One implement run on the item, finished with `outcome`. */
async function implement(store: FactoryStore, clock: FakeClock, item: WorkItem, key: string, outcome: RunOutcome) {
  await enqueue(store, item, "implement", key);
  const r = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
  await store.completeRun(r.id, r.lease!.token, outcome);
  clock.advance(1_000);
}

const failed = (done: object[], tail: string): RunOutcome =>
  ({ status: "failed", error_code: "checks_failed", detail: "`npm run lint` failed", infra: false, output_tail: tail, done_checks: done }) as RunOutcome;

const path = (it: WorkItem) => `/api/v1/items/${encodeURIComponent(it.id)}`;

describe("item API: checks", () => {
  it("an item with no done_checks has checks null", async () => {
    const { store, d } = await setup();
    const it0 = await make(store, 1, "Old item");
    expect((await json<Checks>(d, path(it0))).item.checks).toBeNull();
  });

  it("before any run: command and test lines are not_run, a manual line is manual, each with its check", async () => {
    const { store, d } = await setup();
    const it0 = await make(store, 2, "Checked item");
    await patch(store, it0, { done_checks: CHECKS });
    expect((await json<Checks>(d, path(it0))).item.checks).toEqual([
      { line: "The lint passes", check: { kind: "command", text: "npm run lint" }, result: "not_run", output_tail: null },
      { line: "The page test passes", check: { kind: "test", text: "tests/ui-item-checks.test.tsx" }, result: "not_run", output_tail: null },
      { line: "It reads well", check: { kind: "manual", text: "wording is a judgement" }, result: "manual", output_tail: null },
    ]);
  });

  it("the newest implement run decides: a failed line carries its output tail, a pass line none", async () => {
    const { store, clock, d } = await setup();
    const it0 = await make(store, 3, "Checked item");
    await patch(store, it0, { done_checks: CHECKS });
    // An older run that passed everything, then a newer one where the lint failed and the test did not run.
    await implement(store, clock, it0, "i:1", { status: "succeeded", summary: "ok", data: { done_checks: [
      { line: "The lint passes", result: "pass", check: "npm run lint" }, { line: "The page test passes", result: "pass", check: "x" }, { line: "It reads well", result: "manual", check: "y" },
    ] } });
    await implement(store, clock, it0, "i:2", failed([
      { line: "The lint passes", result: "fail", check: "npm run lint" }, { line: "The page test passes", result: "not_run", check: "x" }, { line: "It reads well", result: "manual", check: "y" },
    ], "src/a.ts:3 error: unused"));
    // A newest run that stored no results (it failed before its checks) does not hide the one before it.
    await implement(store, clock, it0, "i:3", { status: "failed", error_code: "agent_error", detail: "x", infra: false });
    const rows = (await json<{ item: { checks: { result: string; output_tail: string | null }[] } }>(d, path(it0))).item.checks;
    expect(rows.map((r) => [r.result, r.output_tail])).toEqual([["fail", "src/a.ts:3 error: unused"], ["not_run", null], ["manual", null]]);
  });

  it("a run whose results are for other lines (the spec changed) leaves those lines not_run", async () => {
    const { store, clock, d } = await setup();
    const it0 = await make(store, 4, "Checked item");
    await patch(store, it0, { done_checks: CHECKS });
    await implement(store, clock, it0, "i:1", { status: "succeeded", summary: "ok", data: { done_checks: [{ line: "An older line", result: "pass", check: "npm run lint" }] } });
    const rows = (await json<{ item: { checks: { result: string }[] } }>(d, path(it0))).item.checks;
    expect(rows.map((r) => r.result)).toEqual(["not_run", "not_run", "manual"]);
  });

  it("a secret in a line, a check or the output tail is withheld", async () => {
    const { store, clock, d } = await setup();
    const it0 = await make(store, 5, "Leaky checks");
    await patch(store, it0, { done_checks: [{ line: `Uses ${SECRET}`, command: "npm run lint" }, { line: "Reads", manual: true, reason: `ask ${SECRET}` }] });
    await implement(store, clock, it0, "i:1", failed([{ line: `Uses ${SECRET}`, result: "fail", check: "npm run lint" }], `token ${SECRET} rejected`));
    const r = await json<{ item: { checks: { line: string; check: { text: string }; output_tail: string | null }[] } }>(d, path(it0));
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.item.checks[0]!.line).toMatch(/^\[withheld: /);
    expect(r.item.checks[0]!.output_tail).toMatch(/^\[withheld: /);
    expect(r.item.checks[1]!.check.text).toMatch(/^\[withheld: /);
  });
});
