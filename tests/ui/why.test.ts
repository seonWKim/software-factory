import { describe, expect, it } from "vitest";
import { type WhyInput, deadlocked, refsOf, whyWaiting } from "../../src/ui/why.js";

const queued = (kind: "implement" | "triage" | "review" | "update" = "implement", position: number | null = 3) =>
  ({ id: "run_q", kind, status: "queued" as const, position });
const running = { id: "run_r", kind: "implement" as const, status: "running" as const, position: null };

function input(p: Partial<Omit<WhyInput, "item">> & { item?: Partial<WhyInput["item"]> } = {}): WhyInput {
  return {
    run: null,
    decision: null,
    pauses: {},
    not_before: null,
    phases: { waiting_on: 0, waiting_on_number: null },
    ...p,
    item: { stage: "RUNNING", blocked_on: "none", blocked_reason: null, close_reason: null, ...p.item },
  };
}

const held = (holder_kind: "running" | "pr" | "waiting", run_id = "run_q") =>
  ({ run_id, decision: "held" as const, holder_ref: "#92", holder_kind, approved_by: null });
const UNTIL = "2026-11-07T12:30:00.000Z";

describe("whyWaiting: every case", () => {
  const cases: [string, WhyInput, string, string, number[]][] = [
    ["closed", input({ item: { stage: "CLOSED", close_reason: "wont_do" } }), "Closed: wont do", "none", []],
    ["ready to merge", input({ item: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" } }), "Ready to merge: waiting for a person to merge the PR", "human", []],
    ["spec", input({ item: { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" } }), "Waiting for a person to approve the spec", "human", []],
    ["budget", input({ item: { blocked_on: "budget", blocked_reason: "budget_checkpoint" } }), "Waiting for a person to answer the budget check", "human", []],
    ["dependency closed", input({ item: { blocked_on: "human", blocked_reason: "dependency_closed:#41" } }), "#41 was closed without a merge: a person decides how this item goes on", "human", [41]],
    ["dependency cycle", input({ item: { blocked_on: "human", blocked_reason: "dependency_cycle: #5 → #6 → #5" } }), "Its dependencies form a cycle (#5 → #6 → #5): a person removes one link", "human", [5, 6]],
    ["max loops", input({ item: { blocked_on: "human", blocked_reason: "max_loops" } }), "Too many review loops: a person decides what happens next", "human", []],
    ["merge conflict", input({ item: { blocked_on: "human", blocked_reason: "merge_conflict_pending" } }), "A merge conflict needs a person", "human", []],
    ["failed run", input({ item: { blocked_on: "human", blocked_reason: "run_failed:implement:diff_too_large" } }), "The run failed (run_failed:implement:diff_too_large): a person decides what happens next", "human", []],
    ["other human", input({ item: { blocked_on: "human", blocked_reason: "needs a decision on #7" } }), "Waiting for a person: needs a decision on #7", "human", [7]],
    ["human, no stored reason", input({ item: { stage: "REVIEW", blocked_on: "human", blocked_reason: null } }), "Waiting for a person: the item is in review; next, a person retries, resolves or rejects it", "human", []],
    ["deadlock", input({ run: running, decision: { run_id: "run_r", decision: "deadlock", holder_ref: "#92", holder_kind: "waiting", approved_by: null } }), "Started past a deadlock with #92: a person checks the overlap", "factory", [92]],
    ["running", input({ run: running }), "Running implement", "factory", []],
    ["rate limit", input({ run: queued("triage"), pauses: { rate_limit: UNTIL } }), "Paused by a usage or rate limit until 2026-11-07 12:30 UTC", "factory", []],
    ["model stall", input({ run: queued("review"), pauses: { model_stall: UNTIL } }), "Paused: the model is not answering; runs start again once a probe answers", "factory", []],
    ["forge auth", input({ run: queued("implement"), pauses: { forge_auth: UNTIL } }), "Paused: the forge refused the factory's credentials, until 2026-11-07 12:30 UTC", "human", []],
    ["preflight access", input({ run: queued("update"), pauses: { preflight_access: UNTIL } }), "Paused: a push or PR access check failed, until 2026-11-07 12:30 UTC", "human", []],
    ["dependency, two", input({ run: queued(), item: { blocked_on: "dependency", blocked_reason: "waiting for #12 and #13 to merge" } }), "Waiting for #12 and #13 to merge", "other_item", [12, 13]],
    ["dependency, other repo", input({ item: { blocked_on: "dependency", blocked_reason: "waiting for o/other#4 to merge" } }), "Waiting for o/other#4 to merge", "other_item", []],
    ["dependency, no reason", input({ item: { blocked_on: "dependency" } }), "Waiting for another issue to merge", "other_item", []],
    ["phase hold", input({ item: { blocked_on: "upstream", blocked_reason: "phase_hold" }, phases: { waiting_on: 1, waiting_on_number: 191 } }), "Waiting for the previous phase #191 to merge", "other_item", [191]],
    ["phases open", input({ item: { blocked_on: "upstream", blocked_reason: "phases_open" }, phases: { waiting_on: 4, waiting_on_number: null } }), "Waiting for its 4 open phases to merge", "other_item", []],
    ["one phase open", input({ item: { blocked_on: "upstream", blocked_reason: "phases_open" }, phases: { waiting_on: 1, waiting_on_number: 8 } }), "Waiting for its phase #8 to merge", "other_item", [8]],
    ["held by running", input({ run: queued(), decision: held("running") }), "Held behind #92, which is running", "other_item", [92]],
    ["held by PR", input({ run: queued(), decision: held("pr") }), "Held behind #92, which has an open PR", "other_item", [92]],
    ["held by queued", input({ run: queued(), decision: held("waiting") }), "Held behind #92, which is queued ahead of it", "other_item", [92]],
    ["retry backoff", input({ run: queued(), not_before: UNTIL }), "Retry waits until 2026-11-07 12:30 UTC", "factory", []],
    ["queued", input({ run: queued() }), "Queued at position 3", "factory", []],
    ["queued, no position", input({ run: queued("triage", null) }), "Queued triage", "factory", []],
    ["idle", input(), "Nothing moves it: no run is queued", "human", []],
  ];
  it.each(cases)("%s", (_name, x, text, next_actor, refs) => {
    expect(whyWaiting(x)).toMatchObject({ text, next_actor, refs });
  });

  it("a person's block with no stored reason names the item's state and the next step, never \"no reason\"", () => {
    for (const stage of ["NEW", "READY", "RUNNING", "REVIEW"] as const) {
      const w = whyWaiting(input({ item: { stage, blocked_on: "human", blocked_reason: null } }));
      expect(w.text).toMatch(/^Waiting for a person: the item is .+; next, /);
      expect(w.text).not.toMatch(/no reason/i);
    }
  });

  it("an approved hold, or a decision on an older run, is no hold", () => {
    expect(whyWaiting(input({ run: queued(), decision: { ...held("pr"), approved_by: "u1" } })).code).toBe("queued");
    expect(whyWaiting(input({ run: queued(), decision: held("pr", "run_old") })).code).toBe("queued");
  });

  it("forge and preflight pauses follow the claim rule: they stop implement-type runs only", () => {
    expect(whyWaiting(input({ run: queued("triage"), pauses: { forge_auth: UNTIL } })).code).toBe("queued");
    expect(whyWaiting(input({ run: queued("review"), pauses: { preflight_access: UNTIL } })).code).toBe("queued");
    expect(whyWaiting(input({ run: queued("update"), pauses: { forge_auth: UNTIL } })).code).toBe("paused");
  });
});

describe("whyWaiting: precedence", () => {
  const dep = { blocked_on: "dependency" as const, blocked_reason: "waiting for #12 to merge" };
  it("a pause beats a dependency", () => {
    expect(whyWaiting(input({ run: queued(), item: dep, pauses: { rate_limit: UNTIL } })).code).toBe("paused");
  });
  it("a dependency beats a phase hold", () => {
    expect(whyWaiting(input({ run: queued(), item: dep, phases: { waiting_on: 1, waiting_on_number: 9 } })).code).toBe("dependency");
  });
  it("a phase hold beats a coordination hold", () => {
    const x = input({ run: queued(), item: { blocked_on: "upstream", blocked_reason: "phase_hold" }, phases: { waiting_on: 1, waiting_on_number: 9 }, decision: held("pr") });
    expect(whyWaiting(x).code).toBe("phase");
  });
  it("a coordination hold beats the queue position (and a retry's not_before)", () => {
    expect(whyWaiting(input({ run: queued(), decision: held("pr"), not_before: UNTIL })).code).toBe("held");
  });
  it("a dependency beats queued", () => {
    expect(whyWaiting(input({ run: queued(), item: dep })).text).toBe("Waiting for #12 to merge");
  });
});

describe("refsOf and deadlocked", () => {
  it("reads same-repo numbers only", () => {
    expect(refsOf("#3, o/r#4 and #3 or #x")).toEqual([3]);
  });
  it("a deadlock counts only on the item's current run", () => {
    const d = { run_id: "run_r", decision: "deadlock" as const, holder_ref: "#1", holder_kind: "waiting" as const, approved_by: null };
    expect(deadlocked(d, { id: "run_r" })).toBe(true);
    expect(deadlocked(d, { id: "run_other" })).toBe(false);
    expect(deadlocked(d, null)).toBe(false);
  });
});
