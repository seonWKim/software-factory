import { describe, expect, it } from "vitest";
import { UNKNOWN_FAILURE, type WhyInput, deadlocked, refsOf, whyWaiting } from "../../src/ui/why.js";
import { localDateTime, whyText } from "../../web/src/lib/format.js";

// The server sends a reason code with its values; the web app words it (en.ts, one text per reason code). `said`
// is the text a person reads for an input.
const said = (x: WhyInput) => whyText(whyWaiting(x));

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
/** The pause end or retry time as the viewer reads it: local, never UTC or ISO. */
const LOCAL = localDateTime(UNTIL);

describe("whyWaiting: every case", () => {
  const cases: [string, WhyInput, string, string, number[]][] = [
    ["closed", input({ item: { stage: "CLOSED", close_reason: "wont_do" } }), "Closed: wont do", "none", []],
    ["ready to merge", input({ item: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" } }), "Ready to merge: waiting for a person to merge the PR", "human", []],
    ["spec", input({ item: { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" } }), "Waiting for a person to approve the plan", "human", []],
    ["budget", input({ item: { blocked_on: "budget", blocked_reason: "budget_checkpoint" } }), "Waiting for a person to answer the budget check", "human", []],
    ["dependency closed", input({ item: { blocked_on: "human", blocked_reason: "dependency_closed:#41" } }), "#41 was closed without a merge: a person decides how this item goes on", "human", [41]],
    ["dependency cycle", input({ item: { blocked_on: "human", blocked_reason: "dependency_cycle: #5 → #6 → #5" } }), "Its dependencies form a cycle (#5 → #6 → #5): a person removes one link", "human", [5, 6]],
    ["max loops", input({ item: { blocked_on: "human", blocked_reason: "max_loops" } }), "Too many review loops: a person decides what happens next", "human", []],
    ["merge conflict", input({ item: { blocked_on: "human", blocked_reason: "merge_conflict_pending" } }), "A merge conflict needs a person", "human", []],
    ["failed run", input({ item: { blocked_on: "human", blocked_reason: "run_failed:implement:diff_too_large" } }), "Building failed. The change is larger than the diff budget allows. Decide what happens next", "human", []],
    ["failed triage", input({ item: { stage: "NEW", blocked_on: "human", blocked_reason: "run_failed:triage:exception" } }), "Triage failed. The worker hit an unexpected error. Decide what happens next", "human", []],
    ["failed run, unknown code", input({ item: { stage: "REVIEW", blocked_on: "human", blocked_reason: "run_failed:review:odd_code" } }), `Review failed. ${UNKNOWN_FAILURE} Decide what happens next`, "human", []],
    ["failed run of another kind", input({ item: { stage: "REVIEW", blocked_on: "human", blocked_reason: "run_failed:merge-check:exception" } }), "A step failed. The worker hit an unexpected error. Decide what happens next", "human", []],
    ["out of tries", input({ item: { stage: "REVIEW", blocked_on: "human", blocked_reason: "max_attempts" } }), "Review failed. It failed on every try it was allowed. Decide what happens next", "human", []],
    ["too many restarts", input({ item: { stage: "NEW", blocked_on: "human", blocked_reason: "max_restart" } }), "Triage failed. The factory restarted it too many times. Decide what happens next", "human", []],
    ["repeated failure, triage", input({ item: { stage: "NEW", blocked_on: "human", blocked_reason: "repeated_failure" } }), "Triage failed twice the same way. Decide what happens next", "human", []],
    ["repeated failure, building", input({ item: { stage: "RUNNING", blocked_on: "human", blocked_reason: "repeated_failure" } }), "Building failed twice the same way. Decide what happens next", "human", []],
    ["repeated failure in review", input({ item: { stage: "REVIEW", blocked_on: "human", blocked_reason: "repeated_failure" } }), "A step failed twice the same way. Decide what happens next", "human", []],
    ["agent asked", input({ item: { blocked_on: "human", blocked_reason: "agent_needs_human" } }), "The agent asked a question: a person answers it", "human", []],
    ["rule of two", input({ item: { blocked_on: "human", blocked_reason: "rule_of_two" } }), "Held by the Rule of Two: a person approves the run before it starts", "human", []],
    ["unknown hold code", input({ item: { blocked_on: "human", blocked_reason: "something_new" } }), "Waiting for a person to decide what happens next", "human", []],
    ["other human", input({ item: { blocked_on: "human", blocked_reason: "needs a decision on #7" } }), "Waiting for a person: needs a decision on #7", "human", [7]],
    ["human, no stored reason", input({ item: { stage: "REVIEW", blocked_on: "human", blocked_reason: null } }), "Waiting for a person: the item is in review; next, a person retries, resolves or rejects it", "human", []],
    ["deadlock", input({ run: running, decision: { run_id: "run_r", decision: "deadlock", holder_ref: "#92", holder_kind: "waiting", approved_by: null, holder_title: "Other item" } }), `Running at the same time as "Other item", which changes some of the same files. If they clash, you'll be asked when it merges.`, "factory", []],
    ["deadlock, holder without a title", input({ run: running, decision: { run_id: "run_r", decision: "deadlock", holder_ref: "#92", holder_kind: "pr", approved_by: null } }), "Running at the same time as another item, which changes some of the same files. If they clash, you'll be asked when it merges.", "factory", []],
    ["running", input({ run: running }), "Running implement", "factory", []],
    ["rate limit", input({ run: queued("triage"), pauses: { rate_limit: UNTIL } }), `Paused by a usage or rate limit until ${LOCAL}`, "factory", []],
    ["model stall", input({ run: queued("review"), pauses: { model_stall: UNTIL } }), "Paused: the model is not answering; runs start again once a probe answers", "factory", []],
    // The missing model credential's pause stops agent runs only: a queued update run still says it is queued.
    ["no model credential", input({ run: queued("triage"), pauses: { model_credential: "9999-12-31T23:59:59.999Z" } }), "Waiting for a model credential", "human", []],
    ["no model credential, not an agent run", input({ run: queued("update", null), pauses: { model_credential: "9999-12-31T23:59:59.999Z" } }), "Queued update", "factory", []],
    ["forge auth", input({ run: queued("implement"), pauses: { forge_auth: UNTIL } }), `Paused: the forge refused the factory's credentials, until ${LOCAL}`, "human", []],
    ["preflight access", input({ run: queued("update"), pauses: { preflight_access: UNTIL } }), `Paused: a push or PR access check failed, until ${LOCAL}`, "human", []],
    ["dependency, two", input({ run: queued(), item: { blocked_on: "dependency", blocked_reason: "waiting for #12 and #13 to merge" } }), "Waiting for #12 and #13 to merge", "other_item", [12, 13]],
    ["dependency, other repo", input({ item: { blocked_on: "dependency", blocked_reason: "waiting for o/other#4 to merge" } }), "Waiting for o/other#4 to merge", "other_item", []],
    ["dependency, no reason", input({ item: { blocked_on: "dependency" } }), "Waiting for another issue to merge", "other_item", []],
    ["phase hold", input({ item: { blocked_on: "upstream", blocked_reason: "phase_hold" }, phases: { waiting_on: 1, waiting_on_number: 191 } }), "Waiting for the previous phase #191 to merge", "other_item", [191]],
    ["phases open", input({ item: { blocked_on: "upstream", blocked_reason: "phases_open" }, phases: { waiting_on: 4, waiting_on_number: null } }), "Waiting for its 4 open phases to merge", "other_item", []],
    ["one phase open", input({ item: { blocked_on: "upstream", blocked_reason: "phases_open" }, phases: { waiting_on: 1, waiting_on_number: 8 } }), "Waiting for its phase #8 to merge", "other_item", [8]],
    ["held by running", input({ run: queued(), decision: held("running") }), "Held behind #92, which is running", "other_item", [92]],
    ["held by PR", input({ run: queued(), decision: held("pr") }), "Held behind #92, which has an open PR", "other_item", [92]],
    ["held by queued", input({ run: queued(), decision: held("waiting") }), "Held behind #92, which is queued ahead of it", "other_item", [92]],
    ["retry backoff", input({ run: queued(), not_before: UNTIL }), `Retry waits until ${LOCAL}`, "factory", []],
    ["queued", input({ run: queued() }), "Queued at position 3", "factory", []],
    ["queued, no position", input({ run: queued("triage", null) }), "Queued triage", "factory", []],
    ["idle", input(), "Nothing moves it: no run is queued", "human", []],
  ];
  it.each(cases)("%s", (_name, x, text, next_actor, refs) => {
    const w = whyWaiting(x);
    expect({ text: whyText(w), next_actor: w.next_actor, refs: w.refs }).toEqual({ text, next_actor, refs });
  });

  it("a retry wait or claim pause sends its end as an ISO field; the text never says UTC", () => {
    for (const x of [input({ run: queued(), not_before: UNTIL }), input({ run: queued(), pauses: { rate_limit: UNTIL } }), input({ run: queued(), pauses: { forge_auth: UNTIL } }), input({ run: queued(), pauses: { preflight_access: UNTIL } })]) {
      const w = whyWaiting(x);
      expect(w.params.until).toBe(UNTIL);
      expect(whyText(w)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|UTC/);
    }
  });

  it("a person's block with no stored reason names the item's state and the next step, never \"no reason\"", () => {
    for (const stage of ["NEW", "READY", "RUNNING", "REVIEW"] as const) {
      const w = whyWaiting(input({ item: { stage, blocked_on: "human", blocked_reason: null } }));
      expect(whyText(w)).toMatch(/^Waiting for a person: the item is .+; next, /);
      expect(whyText(w)).not.toMatch(/no reason/i);
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
    expect(said(input({ run: queued(), item: dep }))).toBe("Waiting for #12 to merge");
  });
});

describe("whyWaiting: a recurring-failure hold names its last failed run", () => {
  const hold = { blocked_on: "human" as const, blocked_reason: "recurring_failure" };
  const failure = (error_code: string, detail: string, infra = false) =>
    ({ outcome: { status: "failed" as const, error_code, detail, infra }, code: error_code, detail });

  it("an agent_stalled run: the model stalled and a retry is enough", () => {
    const w = whyWaiting(input({ item: hold, failure: failure("agent_stalled", "no model output for 5 minutes", true) }));
    expect(w).toMatchObject({ code: "human", next_actor: "human" });
    expect(whyText(w)).toMatch(/model stalled/);
    expect(whyText(w)).toMatch(/a plain retry is likely enough/);
    expect(whyText(w)).toContain("The model printed nothing for the stall timeout");
    expect(whyText(w)).toContain("no model output for 5 minutes");
    expect(whyText(w)).not.toContain("recurring_failure");
  });

  it("a rate limit or an infra failure: a retry is enough too", () => {
    for (const f of [failure("rate_limited", "429"), failure("lease_lost", "lost", true)]) {
      expect(said(input({ item: hold, failure: f }))).toMatch(/a plain retry is likely enough/);
    }
  });

  it("a task failure: named in plain words, and something must change before a retry", () => {
    const w = whyWaiting(input({ item: hold, failure: failure("tests_failed", "2 tests failed") }));
    expect(whyText(w)).toContain("The checks or tests failed");
    expect(whyText(w)).toMatch(/a plain retry will likely fail again/);
    expect(whyText(w)).toMatch(/change .* first/);
    expect(whyText(w)).not.toMatch(/likely enough/);
  });

  it("a code with no description reads as a generic sentence, never as the code", () => {
    const text = said(input({ item: hold, failure: failure("odd_code", "") }));
    expect(text).toContain(UNKNOWN_FAILURE.replace(/\.$/, ""));
    expect(text).not.toContain("odd_code");
  });

  it("no failed run: still a sentence, never empty or a raw code, naming no failure", () => {
    for (const x of [input({ item: hold, failure: null }), input({ item: hold })]) {
      const w = whyWaiting(x);
      expect(whyText(w)).toMatch(/no failed run/);
      expect(whyText(w)).not.toContain("recurring_failure");
      expect(whyText(w)).not.toMatch(/likely (enough|fail)/);
    }
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

describe("the deadlock sentence", () => {
  it("names no number and none of the internal words", () => {
    const w = whyWaiting(input({ run: { id: "run_r", kind: "implement", status: "running", position: null }, decision: { run_id: "run_r", decision: "deadlock", holder_ref: "#92", holder_kind: "waiting", approved_by: null, holder_title: "Other item" } }));
    expect(w.code).toBe("deadlock");
    expect(whyText(w)).not.toMatch(/#\d|deadlock|claim|overlap/i);
  });
});

describe("a held item names its holder", () => {
  const local = { run_id: "run_q", decision: "held" as const, holder_ref: "local-716e2b9f", holder_kind: "pr" as const, approved_by: null };

  it("by its title, with the holder's item id for the link; never the raw local id", () => {
    const w = whyWaiting(input({ run: queued(), decision: { ...local, holder_title: "Add the merge queue", holder_work_item_id: "wi_holder" } }));
    expect(w).toMatchObject({ code: "held", reason_code: "held_pr", holder_id: "wi_holder" });
    expect(whyText(w)).toBe("Held behind Add the merge queue, which has an open PR");
    expect(whyText(w)).not.toContain("local-716e");
  });

  it("as another item when it has no title and no issue number", () => {
    const w = whyWaiting(input({ run: queued(), decision: local }));
    expect(whyText(w)).toBe("Held behind another item, which has an open PR");
    expect(w.holder_id).toBeNull();
  });
});

describe("the reason texts live in en.ts", () => {
  it("a spec at its revision limit waits for approval, and max_loops has one text", () => {
    expect(said(input({ item: { stage: "READY", blocked_on: "human", blocked_reason: "max_revisions" } }))).toMatch(/revision limit: a person approves/);
    expect(whyWaiting(input({ item: { stage: "REVIEW", blocked_on: "human", blocked_reason: "max_loops" } })).reason_code).toBe("max_loops");
  });

  it("no English reason text is written in src/ui", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../../src/ui/", import.meta.url);
    const texts = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
    for (const phrase of ["review found bugs too many times", "Too many review loops", "Held behind"]) expect(texts).not.toContain(phrase);
  });
});
