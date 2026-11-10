import { describe, expect, it } from "vitest";
import type { RunOutcome, WipRef } from "../src/core/types.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import { STORE_BRANCH } from "../src/interfaces/tool-broker.js";
import { pipeline } from "./helpers/fakes.js";

// Design §5 Restarts, stopped runs keep their work: an implement run that stops mid-work (rate_limited,
// agent_stalled, agent_timed_out) keeps its commits on `<branch_prefix>wip/<item id>/<run id>`, and its retry runs
// the agent on that head (`continue`), resuming the stopped session with `--resume` when it is still on this host.

type Failed = Extract<RunOutcome, { status: "failed" }>;
type Harness = Awaited<ReturnType<typeof pipeline>>;
const WIP_HEAD = "wiphead1";

/**
 * The first implement call does some work (moves HEAD to WIP_HEAD with one commit) and stops with `stop`; later
 * calls finish. Every call records the HEAD it started on. The runner stores each session it is given, as the CLI
 * does, so `hasSession` can find it.
 */
async function harness(stop: Partial<AgentRunResult>, work = true) {
  let f: Harness | null = null;
  const startedOn: string[] = [];
  const stored = new Set<string>();
  f = await pipeline({
    implement: (spec: AgentRunSpec) => {
      startedOn.push(f!.sandbox.head.trim());
      if (spec.session) stored.add(spec.session.id);
      if (startedOn.length > 1) return { output: { summary: "the summary", next_steps: "the next steps" } };
      if (work) {
        f!.sandbox.head = `${WIP_HEAD}\n`;
        f!.sandbox.commits = ["c1"];
      }
      return { output: null, ...stop };
    },
  });
  if (!work) f.sandbox.commits = [];
  Object.assign(f.runner, {
    hasSession: async (id: string) => stored.has(id),
    removeSession: async (id: string) => void stored.delete(id),
  });
  return { f, startedOn, stored };
}

const RATE_LIMITED: Partial<AgentRunResult> = { status: "rate_limited", error: "rate_limited", reset_at: "2026-01-02T00:00:00.000Z" };
const implementSpecs = (f: Harness) => f.runner.specs.filter((s) => s.role === "implement");
const pushedBranches = (f: Harness) => f.broker.calls.filter((c) => c.name === "forge.push_branch").map((c) => (c.args as { branch: string }).branch);

/** Runs the item through its first implement run; returns the failed run and its wip ref. */
async function firstRun(f: Harness) {
  const it0 = await f.submit();
  await f.step();
  const [failed] = await f.runs(it0, "implement");
  return { it0, failed: failed!, outcome: failed!.outcome as Failed };
}

/** Lets the retry be claimed: past the rate-limit pause and its not_before, within the run's schedule_to_close. */
async function retry(f: Harness) {
  f.clock.set(new Date("2026-01-02T00:01:00.000Z"));
  await f.step();
}

describe("a run stopped mid-work keeps its commits", () => {
  it("a rate-limited implement run with commits pushes them to the wip branch and records the ref", async () => {
    const { f } = await harness(RATE_LIMITED);
    const { it0, failed, outcome } = await firstRun(f);
    expect(outcome).toMatchObject({ status: "failed", error_code: "rate_limited" });
    const wip = outcome.wip!;
    expect(wip).toMatchObject({ branch: `factory/wip/${it0.id}/${failed.id}`, head: WIP_HEAD, commits: 1, continue: true });
    // Only the wip branch: no PR branch push, no PR.
    expect(pushedBranches(f)).toEqual([wip.branch]);
    expect(f.broker.calls.some((c) => c.name === "forge.open_change")).toBe(false);
    const queued = (await f.runs(it0, "implement"))[1]!;
    expect(queued.input?.wip).toEqual(wip);
  });

  it("uncommitted changes become one WIP commit that the wip branch keeps", async () => {
    const { f } = await harness(RATE_LIMITED, false);
    f.sandbox.status = " M src/a.ts\0";
    f.sandbox.commitHead = "wipcommit";
    const call = f.runner.script.implement!;
    f.runner.script.implement = (spec) => {
      f.sandbox.commits = ["wipcommit"];
      return call(spec);
    };
    const { outcome } = await firstRun(f);
    expect(outcome.wip).toMatchObject({ head: "wipcommit", commits: 1 });
    expect(f.sandbox.gitCalls.some((c) => /commit --quiet --no-verify -m wip: stopped run/.test(c))).toBe(true);
  });

  it("a stalled implement run with commits keeps them on a wip branch the same way", async () => {
    const { f } = await harness({ status: "stalled", error: "no model output for stall_ms" });
    const { it0, failed, outcome } = await firstRun(f);
    expect(outcome).toMatchObject({ error_code: "agent_stalled", wip: { branch: `factory/wip/${it0.id}/${failed.id}`, head: WIP_HEAD, continue: true } });
    expect(pushedBranches(f)).toEqual([outcome.wip!.branch]);
  });

  it("a timed-out implement run with commits keeps them too", async () => {
    const { f } = await harness({ status: "timed_out" });
    const { outcome } = await firstRun(f);
    expect(outcome).toMatchObject({ error_code: "agent_timed_out", infra: true, wip: { head: WIP_HEAD, continue: true } });
  });

  it("a run with no commits and no changes retries fresh, with no wip in its input", async () => {
    const { f, startedOn } = await harness(RATE_LIMITED, false);
    const { it0, outcome } = await firstRun(f);
    expect(outcome).toMatchObject({ error_code: "rate_limited" });
    expect(outcome.wip).toBeUndefined();
    expect(pushedBranches(f)).toEqual([]);
    const queued = (await f.runs(it0, "implement"))[1]!;
    expect(queued.input?.wip).toBeUndefined();
    await retry(f);
    const [first, second] = implementSpecs(f);
    expect(second!.session).toMatchObject({ resume: false });
    expect(second!.session!.id).not.toBe(first!.session!.id);
    expect(startedOn).toEqual(["base", "base"]);
  });

  it("a failed wip store fails the run with its original code, no wip ref, and the retry starts fresh", async () => {
    const { f } = await harness(RATE_LIMITED);
    // A stopped run stores only its wip branch.
    f.broker.responses[STORE_BRANCH] = [{ ok: false, error_code: "push_failed", message: "rejected" }];
    const { it0, outcome } = await firstRun(f);
    expect(outcome).toMatchObject({ error_code: "rate_limited" });
    expect(outcome.wip).toBeUndefined();
    const queued = (await f.runs(it0, "implement"))[1]!;
    expect(queued.input?.wip).toBeUndefined();
    // Nothing is kept for a resume: the folder and the session went with the run.
    expect(f.sandbox.live.size).toBe(0);
    await retry(f);
    const [, second] = implementSpecs(f);
    expect(second!.session).toMatchObject({ resume: false });
  });
});

describe("the retry continues the agent on the wip head", () => {
  it("on the same host it resumes the stopped session with --resume in the kept folder", async () => {
    const { f, startedOn, stored } = await harness(RATE_LIMITED);
    const { it0, outcome } = await firstRun(f);
    await retry(f);

    const [first, second] = implementSpecs(f);
    expect(second!.session).toEqual({ id: first!.session!.id, resume: true });
    expect(second!.sandbox.id).toBe(first!.sandbox.id);
    expect(startedOn).toEqual(["base", WIP_HEAD]);
    expect(second!.prompt).toContain("same session and folder");
    // The run went on to its PR; its commits start at the run's start, so they include the earlier ones.
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", pr_number: 42 });
    const retried = (await f.runs(it0, "implement"))[1]!;
    expect(retried.outcome).toMatchObject({ status: "succeeded", data: { commits: 1 } });
    expect((await f.store.listHandoffs(it0.id)).map((h) => h.commit_sha)).toEqual(["c1"]);
    expect(pushedBranches(f)).toEqual([outcome.wip!.branch, `factory/${it0.id}`]);
    // The run ended: its folder and session are gone.
    expect(f.sandbox.live.has(first!.sandbox.id)).toBe(false);
    expect(stored.has(first!.session!.id)).toBe(false);
  });

  it("on another host it starts a new session on the wip head in a new folder", async () => {
    const { f, startedOn } = await harness(RATE_LIMITED);
    const { it0, outcome } = await firstRun(f);
    const wip = outcome.wip as WipRef;
    f.sandbox.refs[`origin/${wip.branch}`] = wip.head;
    f.sandbox.head = "base\n"; // a new clone starts on the base
    f.w1.tick = async () => false; // only w2, another host, claims
    await retry(f);

    const [first, second] = implementSpecs(f);
    expect(second!.session!.resume).toBe(false);
    expect(second!.session!.id).not.toBe(first!.session!.id);
    expect(second!.sandbox.id).not.toBe(first!.sandbox.id);
    // The wip head is checked out before the agent runs: it does not start from the base.
    expect(startedOn).toEqual(["base", WIP_HEAD]);
    expect(f.sandbox.gitCalls).toContain(`-c core.hooksPath=/dev/null checkout --quiet -f -B factory/${it0.id} ${WIP_HEAD}`);
    expect(second!.prompt).toContain(`new session from the wip head \`${WIP_HEAD.slice(0, 8)}\``);
    expect(second!.prompt).toContain("## Diff budget");
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", pr_number: 42 });
  });

  it("on the same host with the session gone it drops the kept folder and starts a new session on the wip head", async () => {
    const { f, startedOn, stored } = await harness(RATE_LIMITED);
    const { outcome } = await firstRun(f);
    const wip = outcome.wip as WipRef;
    f.sandbox.refs[`origin/${wip.branch}`] = wip.head;
    stored.clear();
    f.sandbox.head = "base\n";
    await retry(f);

    const [first, second] = implementSpecs(f);
    expect(f.sandbox.destroyedIds).toContain(first!.sandbox.id);
    expect(second!.sandbox.id).not.toBe(first!.sandbox.id);
    expect(second!.session!.resume).toBe(false);
    expect(startedOn).toEqual(["base", WIP_HEAD]);
  });

  it("a wip branch that is gone on another host is not trusted: the agent starts from the branch as it is", async () => {
    const { f, startedOn } = await harness(RATE_LIMITED);
    await firstRun(f);
    f.sandbox.head = "base\n";
    f.w1.tick = async () => false;
    await retry(f);
    expect(startedOn).toEqual(["base", "base"]);
    expect(implementSpecs(f)).toHaveLength(2);
  });
});
