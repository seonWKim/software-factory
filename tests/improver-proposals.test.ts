import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dailyImproveKey, patternKey, systemSource } from "../src/core/improver.js";
import {
  IMPROVER_DEFAULTS, PROPOSAL_CAP, PROPOSAL_FILE, type GoldenEvidence, type ProposeDeps, applyEdits, fileProposals, improverConfig, proposalMarker,
  proposeChanges, proposesIn,
} from "../src/core/proposals.js";
import type { FailureGroup, ImproveReport, RunId, WorkItemId, WorkerId } from "../src/core/types.js";
import { checkConfigKeys } from "../src/config-keys.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { EgressChannel, EgressScanner, ScanResult } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { IssueInput } from "../src/interfaces/source-adapter.js";
import type { LLMProvider, LLMRequest } from "../src/interfaces/llm-provider.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { PROJECT, cleanScanner, config, prompts, silent } from "./helpers/fakes/config.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { REPO } from "./architecture/lib.js";
import { reviewReplay } from "../src/golden-replay.js";

// Entity proposals of the improve run (design 07-self-improvement, issue #496): a recurring failure group gets one
// drafted change to prompts/review.md, replayed through the golden cases before and after, stored for a verdict.
// Nothing changes before the verdict; promote files one work item with the diff as an unverified draft.

const EDIT = { why: "The reviewer missed the failing tests.", edits: [{ find: "REVIEW", replace: "REVIEW\nFLAG EVERYTHING" }] };

/** The fake LLM: answers every call with `answer`, counting the calls. */
function fakeLlm(answer: unknown = EDIT): LLMProvider & { calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  return {
    calls,
    complete: async (req) => {
      calls.push(req);
      return { text: JSON.stringify(answer), parsed: answer, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
    },
  };
}

const evidence = (flag: boolean): GoldenEvidence => ({
  cases: [{ id: "1", expect: "should_flag", verdict: flag ? "bug" : "pass" }, { id: "2", expect: "should_pass", verdict: flag ? "bug" : "pass" }],
  catch_rate: flag ? 1 : 0, false_alarm_rate: flag ? 1 : 0,
});

/** A scanner that flags any text holding `word` on `channel`, recording what it was asked. */
function flagging(word: string, channel: EgressChannel): EgressScanner & { calls: EgressChannel[] } {
  const calls: EgressChannel[] = [];
  return {
    calls,
    scan: async (ch, text): Promise<ScanResult> => {
      calls.push(ch);
      return ch === channel && text.includes(word) ? { clean: false, findings: [{ rule: "planted_rule", channel: ch }] } : { clean: true };
    },
  };
}

const group = (code: string, runs: number): FailureGroup => ({
  error_code: code, detail: `${code} detail`,
  run_ids: Array.from({ length: runs }, (_, i) => `run_${code}_${i}` as RunId), work_item_ids: Array.from({ length: runs }, (_, i) => `wi_${code}_${i}` as WorkItemId),
});
const report = (groups: FailureGroup[], id = "ir_1"): ImproveReport => ({
  id, run_id: "run_improve", project: PROJECT.key, window_start: "2026-03-03T00:00:00.000Z", window_end: "2026-03-04T00:00:00.000Z", groups, patterns: [], created_at: "2026-03-04T00:00:01.000Z",
}) as unknown as ImproveReport;

function deps(store: FactoryStore, over: Partial<ProposeDeps> = {}): ProposeDeps & { replays: string[] } {
  const replays: string[] = [];
  return {
    store, scanner: cleanScanner, llm: fakeLlm(), file_text: "REVIEW", config: IMPROVER_DEFAULTS, replays,
    replay: async (prompt) => {
      replays.push(prompt);
      return evidence(prompt.includes("FLAG EVERYTHING"));
    },
    ...over,
  };
}

describe("improve proposals: drafting", () => {
  it("a repeated failure of two runs gets one pending proposal with its diff, pattern key and before and after evidence", async () => {
    const { store } = await newStore(new FakeClock("2026-03-04T06:00:00.000Z"));
    const d = deps(store);
    const g = group("checks_failed", 2);
    const [p, ...rest] = await proposeChanges(d, report([g]));
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ state: "pending", pattern_key: patternKey(g), file: PROPOSAL_FILE, error_code: "checks_failed", run_count: 2, needs_human_merge: true });
    expect(p!.diff).toBe(["--- a/prompts/review.md", "+++ b/prompts/review.md", "@@ -1,1 +1,2 @@", "-REVIEW", "+REVIEW", "+FLAG EVERYTHING"].join("\n"));
    expect(p!.before).toEqual(evidence(false));
    expect(p!.after).toEqual(evidence(true));
    // Before replays the file as it is, after with the edit, in memory.
    expect(d.replays).toEqual(["REVIEW", "REVIEW\nFLAG EVERYTHING"]);
    expect(await store.getProposal(p!.id)).toEqual(p);
  });

  it("changes no repository file and creates no work item before a verdict", async () => {
    const { store } = await newStore(new FakeClock("2026-03-04T06:00:00.000Z"));
    const file = readFileSync(join(REPO, PROPOSAL_FILE), "utf8");
    const before = (await store.listTables()).find((t) => t.name === "controller_work_items")!.rows;
    await proposeChanges(deps(store), report([group("checks_failed", 2)]));
    expect(readFileSync(join(REPO, PROPOSAL_FILE), "utf8")).toBe(file);
    expect((await store.listTables()).find((t) => t.name === "controller_work_items")!.rows).toBe(before);
    expect((await store.listProposals({ project: PROJECT.key })).map((p) => p.filed_ref)).toEqual([null]);
  });

  it("a group under distill.min_cases stays watching: recorded, no model call, no replay", async () => {
    const { store } = await newStore(new FakeClock());
    const llm = fakeLlm();
    const d = deps(store, { llm, config: { max_proposals: 1, min_cases: 3 } });
    const [p] = await proposeChanges(d, report([group("checks_failed", 2)]));
    expect(p).toMatchObject({ state: "watching", diff: null, before: null, after: null });
    expect(llm.calls).toEqual([]);
    expect(d.replays).toEqual([]);
  });

  it("past improver.max_proposals the rest are recorded skipped with proposal_cap, largest groups first", async () => {
    const { store } = await newStore(new FakeClock());
    const llm = fakeLlm();
    const d = deps(store, { llm, config: { max_proposals: 1, min_cases: 2 } });
    const out = await proposeChanges(d, report([group("a", 4), group("b", 3), group("c", 2)]));
    expect(out.map((p) => [p.error_code, p.state, p.reason])).toEqual([["a", "pending", null], ["b", "skipped", PROPOSAL_CAP], ["c", "skipped", PROPOSAL_CAP]]);
    expect(llm.calls).toHaveLength(1);
  });

  it("is safe to run twice: the stored rows are kept, no second model call or replay", async () => {
    const { store } = await newStore(new FakeClock());
    const llm = fakeLlm();
    const d = deps(store, { llm });
    const r = report([group("a", 2), group("b", 2)]);
    const first = await proposeChanges(d, r);
    const again = await proposeChanges(d, r);
    expect(again).toEqual(first);
    expect(llm.calls).toHaveLength(1);
    expect(d.replays).toHaveLength(2);
  });

  it("a pushback group gets no proposal: only repeated failures do", async () => {
    const { store } = await newStore(new FakeClock());
    expect(await proposeChanges(deps(store), report([group("pushback", 3)]))).toEqual([]);
  });

  it("a draft whose find text is not in the file is skipped with draft_failed, before any replay", async () => {
    const { store } = await newStore(new FakeClock());
    const d = deps(store, { llm: fakeLlm({ why: "x", edits: [{ find: "NOT THERE", replace: "y" }] }) });
    const [p] = await proposeChanges(d, report([group("a", 2)]));
    expect(p).toMatchObject({ state: "skipped", reason: "draft_failed", diff: null });
    expect(d.replays).toEqual([]);
  });

  it.each([["comment" as const], ["run_outcome" as const]])("a body or record the G5 scan flags on %s is stored withheld with its rules only", async (channel) => {
    const { store } = await newStore(new FakeClock());
    const scanner = flagging("FLAG EVERYTHING", channel);
    const [p] = await proposeChanges(deps(store, { scanner }), report([group("a", 2)]));
    expect(p).toMatchObject({ state: "withheld", rules: ["planted_rule"], diff: null, why: null, before: null, after: null });
    expect(scanner.calls).toEqual(["comment", "run_outcome"]);
  });
});

describe("improve proposals: verdicts and filing", () => {
  async function pending() {
    const clock = new FakeClock("2026-03-04T06:00:00.000Z");
    const { store } = await newStore(clock);
    const [p] = await proposeChanges(deps(store), report([group("checks_failed", 2)]));
    const filed: IssueInput[] = [];
    const file = async (input: IssueInput) => {
      filed.push(input);
      return { type: "local" as const, id: `local-filed-${filed.length}`, link: "" };
    };
    return { clock, store, p: p!, filed, file };
  }

  it("promote is a conditional update: a second verdict changes nothing; promote files one item with the diff as an unverified draft", async () => {
    const { store, p, filed, file } = await pending();
    expect(await fileProposals({ store, file }, PROJECT.key)).toEqual([]);
    expect(await store.decideProposal(p.id, "promote", "local:owner" as never)).toBe(true);
    expect(await store.decideProposal(p.id, "promote", "local:owner" as never)).toBe(false);
    expect(await store.decideProposal(p.id, "reject", "local:owner" as never)).toBe(false);
    expect(await store.getProposal(p.id)).toMatchObject({ state: "promoted", decided_by: "local:owner" });

    const [one] = await fileProposals({ store, file }, PROJECT.key);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ project: PROJECT.key, requester_id: "system:improver", marker: proposalMarker(p.id) });
    expect(filed[0]!.body).toContain(p.diff!);
    expect(filed[0]!.body).toContain("unverified");
    expect(one!.filed_ref).toEqual({ type: "local", id: "local-filed-1", link: "" });
    // Filed once: a second tick, or a second replica, files nothing.
    expect(await fileProposals({ store, file }, PROJECT.key)).toEqual([]);
    expect(filed).toHaveLength(1);
  });

  it("reject and hold change only the proposal's state and file nothing; a held proposal may still be promoted", async () => {
    const { store, p, filed, file } = await pending();
    expect(await store.decideProposal(p.id, "hold", "local:owner" as never)).toBe(true);
    expect(await store.decideProposal(p.id, "hold", "local:owner" as never)).toBe(false);
    expect(await fileProposals({ store, file }, PROJECT.key)).toEqual([]);
    expect(await store.getProposal(p.id)).toMatchObject({ state: "held", diff: p.diff, before: p.before, after: p.after });
    expect(await store.decideProposal(p.id, "reject", "local:owner" as never)).toBe(true);
    expect(await store.decideProposal(p.id, "promote", "local:owner" as never)).toBe(false);
    expect(await fileProposals({ store, file }, PROJECT.key)).toEqual([]);
    expect(filed).toEqual([]);
  });

  it("a filing claimed by another caller is not filed again until its wait is over", async () => {
    const { clock, store, p, filed, file } = await pending();
    await store.decideProposal(p.id, "promote", "local:owner" as never);
    expect(await store.claimProposalFiling(p.id, 600_000)).toBe(true);
    expect(await fileProposals({ store, file }, PROJECT.key)).toEqual([]);
    clock.advance(600_001);
    expect(await fileProposals({ store, file }, PROJECT.key)).toHaveLength(1);
    expect(filed).toHaveLength(1);
  });

  it("with no source that can file, nothing is claimed", async () => {
    const { store, p } = await pending();
    await store.decideProposal(p.id, "promote", "local:owner" as never);
    expect(await fileProposals({ store, file: null }, PROJECT.key)).toEqual([]);
    expect(await store.claimProposalFiling(p.id, 600_000)).toBe(true);
  });
});

describe("improve proposals: settings", () => {
  it("improver.max_proposals, improver.schedule and distill.min_cases default to 1, off and 2", () => {
    expect(improverConfig({})).toEqual({ max_proposals: 1, schedule: "off", min_cases: 2 });
    expect(improverConfig({ improver: { max_proposals: 3, schedule: "every_run" }, distill: { min_cases: 4 } })).toEqual({ max_proposals: 3, schedule: "every_run", min_cases: 4 });
  });

  it("a bad value or an unknown key fails the load naming it", () => {
    expect(() => improverConfig({ improver: { max_proposals: 0 } })).toThrow(/improver.max_proposals/);
    expect(() => improverConfig({ improver: { schedule: "hourly" } })).toThrow(/improver.schedule/);
    expect(() => improverConfig({ distill: { min_cases: "2" } })).toThrow(/distill.min_cases/);
    expect(() => checkConfigKeys({ improver: { max_proposal: 1 } })).toThrow(/unknown config key "max_proposal" at improver.max_proposal/);
    expect(() => checkConfigKeys({ distill: { min_case: 1 } })).toThrow(/unknown config key "min_case" at distill.min_case/);
  });

  it("schedule daily proposes only in the day's run, every_run in any, off in none", () => {
    const daily = { idempotency_key: dailyImproveKey(PROJECT.key, "2026-03-04") };
    const manual = { idempotency_key: `improve:${PROJECT.key}:manual:2026-03-04T00:00:00.000Z` };
    expect([proposesIn("daily", daily), proposesIn("daily", manual)]).toEqual([true, false]);
    expect([proposesIn("every_run", manual), proposesIn("off", daily)]).toEqual([true, false]);
  });

  it("applyEdits refuses a find text that occurs twice", () => {
    expect(applyEdits(PROPOSAL_FILE, "a\na\n", [{ find: "a", replace: "b" }])).toBeNull();
  });
});

describe("improve proposals: the daily improve run", () => {
  it("drafts with the fake LLM and replays the review cases through the fake runner before and after; nothing is filed", async () => {
    const clock = new FakeClock("2026-03-04T01:00:00.000Z");
    const { store } = await newStore(clock);
    for (const n of [1, 2]) {
      await store.createWorkItem(issue(n), system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
      const run = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: ["triage"], lease_ms: 60_000 }))!;
      await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: "checks_failed", detail: "npm test exited 1", infra: false });
      clock.advance(60_000);
    }
    clock.set("2026-03-05T00:00:01.000Z");
    const llm = fakeLlm();
    const c = new ControllerRole({ store, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, llm });
    await c.tickImprove();
    // The review answer follows the system prompt: the proposed prompt flags every case.
    const runner = new FakeRunner({
      review: (spec: AgentRunSpec) => ({ output: { verdict: spec.system_prompt.includes("FLAG EVERYTHING") ? "bug" : "pass", tier: 2, findings: [], summary: "s" } }),
    });
    const sandbox = new FakeSandbox();
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox, runner, broker: new FakeBroker(), storage: new MemoryStorage(), llm, reviewReplay: reviewReplay({ sandbox, runner, scanner: cleanScanner, clock }),
      clock, config: { ...config, improver: { ...IMPROVER_DEFAULTS, schedule: "daily" } }, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
    });
    const items = (await store.listTables()).find((t) => t.name === "controller_work_items")!.rows;
    expect(await worker.tick()).toBe(true);

    const system_item = (await store.getWorkItemBySource("local", systemSource(PROJECT.key).id))!;
    const [run] = (await store.listRuns(system_item.id)).filter((r) => r.kind === "improve");
    const [p, ...rest] = await store.listProposals({ project: PROJECT.key });
    expect(rest).toEqual([]);
    expect(run!.outcome).toMatchObject({ status: "succeeded", data: { proposals: [p!.id] } });
    expect(p).toMatchObject({ state: "pending", run_count: 2, after: { catch_rate: 1 } });
    expect(p!.before!.cases.length).toBeGreaterThan(0);
    expect(p!.before!.cases.every((x) => x.verdict === "pass")).toBe(true);
    expect(p!.after!.cases.every((x) => x.verdict === "bug")).toBe(true);
    expect(runner.specs.filter((s) => s.system_prompt === prompts.review)).toHaveLength(p!.before!.cases.length);
    expect(llm.calls.map((r) => r.output_schema)).toContainEqual(expect.objectContaining({ required: ["why", "edits"] }));
    expect((await store.listTables()).find((t) => t.name === "controller_work_items")!.rows).toBe(items);
  });
});
