import { describe, expect, it } from "vitest";
import { RECURRING_FAILURE, type Run, type RunOutcome, type WorkItem } from "../../src/core/types.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import { heldFailureOf, needOf } from "../../src/ui/need.js";
import { whyWaiting } from "../../src/ui/why.js";
import { Withholder } from "../../src/ui/withhold.js";

// A held item (recurring_failure, design 05-alarms): the decision box and the explanation name the last failed
// run's failure in plain words and say whether a plain retry is likely enough.

const held = { id: "wi_1", stage: "RUNNING", blocked_on: "human", blocked_reason: RECURRING_FAILURE, close_reason: null, source: { type: "local", id: "l-1", link: "local:l-1" }, failure_comment_url: null } as unknown as WorkItem;

function run(id: string, at: string, outcome: RunOutcome | null): Run {
  return { id, status: outcome?.status ?? "queued", outcome, finished_at: outcome ? at : null, updated_at: at } as unknown as Run;
}
const failed = (error_code: string, detail: string, infra = false): RunOutcome => ({ status: "failed", error_code, detail, infra }) as RunOutcome;

const w = new Withholder(new PatternEgressScanner(async () => []));
const ctx = (runs: Run[]) => ({ store: { listRuns: async () => runs }, text: async (v: string, o?: { channel?: "run_outcome"; max?: number }) => (await w.plain(v, o)).text });

const stalled = [
  run("run_a", "2026-11-14T10:00:00.000Z", failed("tests_failed", "2 tests failed")),
  run("run_b", "2026-11-14T11:00:00.000Z", failed("agent_stalled", "no model output for 5 minutes", true)),
];

describe("a recurring-failure hold names its failure", () => {
  it("an agent_stalled run: the decision box says the model stalled and a retry is enough, not the raw code", async () => {
    const n = await needOf(ctx(stalled), held);
    expect(n.reason).toMatch(/model stalled/);
    expect(n.reason).toMatch(/plain retry is likely enough/);
    expect(n.reason).toContain("no model output for 5 minutes");
    expect(n.reason).not.toContain("recurring_failure");
    expect(n.command).toBe("/retry");
  });

  it("the decision box and the explanation give the same text", async () => {
    const c = ctx(stalled);
    const failure = await heldFailureOf(c, held);
    const x = { item: held, run: null, decision: null, pauses: {}, not_before: null, phases: { waiting_on: 0, waiting_on_number: null }, failure };
    expect(whyWaiting(x).text).toBe((await needOf(c, held)).reason);
  });

  it("a detail the scanner flags shows the withheld marker, not the text", async () => {
    const token = `ghp_${"b".repeat(36)}`;
    const c = ctx([run("run_s", "2026-11-14T10:00:00.000Z", failed("agent_stalled", `stalled after ${token}`, true))]);
    const n = await needOf(c, held);
    expect(n.reason).toContain("[withheld: github_token]");
    expect(n.reason).not.toContain(token);
    expect((await heldFailureOf(c, held))?.detail).toBe("[withheld: github_token]");
  });

  it("an item not held as a recurring failure reads no runs", async () => {
    let reads = 0;
    const c = { store: { listRuns: async () => (reads++, stalled) }, text: async (v: string) => v };
    expect(await heldFailureOf(c, { ...held, blocked_reason: "max_loops" })).toBeNull();
    expect(reads).toBe(0);
  });

  it("a held item with no failed run: a sentence that names no failure", async () => {
    const n = await needOf(ctx([run("run_q", "2026-11-14T10:00:00.000Z", null)]), held);
    expect(n.reason).toMatch(/no failed run/);
    expect(n.reason).not.toContain("recurring_failure");
    expect(n.command).toBe("/retry");
  });
});
