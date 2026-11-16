import { describe, expect, it } from "vitest";
import { RECURRING_FAILURE, type Run, type RunOutcome, type WorkItem } from "../../src/core/types.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import { heldFailureOf, needOf } from "../../src/ui/need.js";
import { whyWaiting } from "../../src/ui/why.js";
import { Withholder } from "../../src/ui/withhold.js";
import { whyText } from "../../web/src/lib/format.js";

// A held item (recurring_failure, design 05-alarms): the decision box and the explanation name the last failed
// run's failure in plain words and say whether a plain retry is likely enough. The need leaves the words to the
// why (`from_why`), so both show the same en.ts text.

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

/** What the decision box shows for a held item: the why's text, as the app words it. */
async function shown(c: ReturnType<typeof ctx>): Promise<string> {
  const failure = await heldFailureOf(c, held);
  return whyText(whyWaiting({ item: held, run: null, decision: null, pauses: {}, not_before: null, phases: { waiting_on: 0, waiting_on_number: null }, failure }));
}

describe("a recurring-failure hold names its failure", () => {
  it("an agent_stalled run: the decision box says the model stalled and a retry is enough, not the raw code", async () => {
    const n = await needOf(ctx(stalled), held);
    expect(n.from_why).toBe(true);
    const text = await shown(ctx(stalled));
    expect(text).toMatch(/model stalled/);
    expect(text).toMatch(/plain retry is likely enough/);
    expect(text).toContain("no model output for 5 minutes");
    expect(text).not.toContain("recurring_failure");
    expect(n.command).toBe("/retry");
  });

  it("a detail the scanner flags shows the withheld marker, not the text", async () => {
    const token = `ghp_${"b".repeat(36)}`;
    const c = ctx([run("run_s", "2026-11-14T10:00:00.000Z", failed("agent_stalled", `stalled after ${token}`, true))]);
    const text = await shown(c);
    expect(text).toContain("[withheld: github_token]");
    expect(text).not.toContain(token);
    expect((await heldFailureOf(c, held))?.detail).toBe("[withheld: github_token]");
  });

  it("an item not held as a recurring failure reads no runs", async () => {
    let reads = 0;
    const c = { store: { listRuns: async () => (reads++, stalled) }, text: async (v: string) => v };
    expect(await heldFailureOf(c, { ...held, blocked_reason: "max_loops" })).toBeNull();
    expect(reads).toBe(0);
  });

  it("a held item with no failed run: a sentence that names no failure", async () => {
    const c = ctx([run("run_q", "2026-11-14T10:00:00.000Z", null)]);
    const n = await needOf(c, held);
    expect(await shown(c)).toMatch(/no failed run/);
    expect(await shown(c)).not.toContain("recurring_failure");
    expect(n.command).toBe("/retry");
  });

  it("max_loops leaves its words to the why, so Tasks and Work say the same", async () => {
    const loops = { ...held, stage: "REVIEW", blocked_reason: "max_loops" } as WorkItem;
    const n = await needOf(ctx([]), loops);
    expect(n.from_why).toBe(true);
    const x = { item: loops, run: null, decision: null, pauses: {}, not_before: null, phases: { waiting_on: 0, waiting_on_number: null } };
    expect(whyText(whyWaiting(x))).toBe("Too many review loops: a person decides what happens next");
  });
});
