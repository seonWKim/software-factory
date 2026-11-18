import { describe, expect, it } from "vitest";
import type { RunOutcome } from "../src/core/types.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import { pipeline } from "./helpers/fakes.js";

// Design §5 Restarts, the repair turn: an implement answer that fails the output schema gets one more turn in the
// same session, asking only for the answer. Still invalid: the run fails with invalid_output, its commits kept on
// the run's wip branch with `continue`, so the retry runs the agent on them.

type Failed = Extract<RunOutcome, { status: "failed" }>;
type Harness = Awaited<ReturnType<typeof pipeline>>;
const WIP_HEAD = "wiphead1";
const VALID = { summary: "the summary", next_steps: "the next steps" };

/**
 * Every implement call returns the next scripted answer (the last one repeats). The first call does the work: one
 * commit, HEAD on WIP_HEAD (none with `work` false). `sessions` false: a runner that keeps no session.
 */
async function harness(answers: Partial<AgentRunResult>[], o: { work?: boolean; sessions?: boolean } = {}) {
  let f: Harness | null = null;
  let calls = 0;
  const stored = new Set<string>();
  f = await pipeline({
    implement: (spec: AgentRunSpec) => {
      if (spec.session) stored.add(spec.session.id);
      if (calls === 0 && o.work !== false) {
        f!.sandbox.head = `${WIP_HEAD}\n`;
        f!.sandbox.commits = ["c1"];
      }
      return answers[Math.min(calls++, answers.length - 1)]!;
    },
  });
  if (o.work === false) f.sandbox.commits = [];
  if (o.sessions !== false) {
    Object.assign(f.runner, {
      hasSession: async (id: string) => stored.has(id),
      removeSession: async (id: string) => void stored.delete(id),
    });
  }
  return f;
}

const implementSpecs = (f: Harness) => f.runner.specs.filter((s) => s.role === "implement");
const pushedBranches = (f: Harness) => f.broker.calls.filter((c) => c.name === "forge.push_branch").map((c) => (c.args as { branch: string }).branch);

async function firstRun(f: Harness) {
  const it0 = await f.submit();
  await f.step();
  const [run] = await f.runs(it0, "implement");
  return { it0, run: run! };
}

describe("an invalid implement answer gets one repair turn", () => {
  it("a first answer without summary, then a valid repair answer: the run succeeds and pushes as usual", async () => {
    const f = await harness([{ output: { next_steps: "n" } }, { output: VALID }]);
    const { it0, run } = await firstRun(f);
    expect(run.outcome).toMatchObject({ status: "succeeded", data: { commits: 1 } });
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", change_ref: "42" });
    expect(pushedBranches(f)).toEqual([`factory/${it0.id}`]);
  });

  it("the repair turn resumes the first answer's session and asks only for the final answer", async () => {
    const f = await harness([{ output: { next_steps: "n" } }, { output: VALID }]);
    await firstRun(f);
    const [first, repair] = implementSpecs(f);
    expect(repair!.session).toEqual({ id: first!.session!.id, resume: true });
    expect(repair!.prompt).toContain("did not match the required format");
    expect(repair!.prompt).toContain("Do not change, commit or run anything more");
    expect(repair!.prompt).not.toContain("## Diff budget");
    expect(repair!.sandbox.id).toBe(first!.sandbox.id);
  });

  it("two invalid answers with commits: invalid_output, the commits on the run's wip branch with continue", async () => {
    const f = await harness([{ output: { next_steps: "n" } }]);
    const { it0, run } = await firstRun(f);
    const outcome = run.outcome as Failed;
    expect(outcome).toMatchObject({ status: "failed", error_code: "invalid_output" });
    expect(outcome.wip).toMatchObject({ branch: `factory/wip/${it0.id}/${run.id}`, head: WIP_HEAD, commits: 1, continue: true });
    expect(pushedBranches(f)).toEqual([outcome.wip!.branch]);
    expect(f.broker.calls.some((c) => c.name === "forge.open_change")).toBe(false);
    // The repair ran once: the first answer and one repair turn.
    expect(implementSpecs(f).map((s) => s.session?.resume)).toEqual([false, true]);
    // The retry carries the wip ref, so it runs the agent on those commits.
    const queued = (await f.runs(it0, "implement"))[1]!;
    expect(queued.input?.wip).toEqual(outcome.wip);
  });

  it("two invalid answers and no commits: invalid_output, nothing pushed or kept", async () => {
    const f = await harness([{ output: { next_steps: "n" } }], { work: false });
    const { it0, run } = await firstRun(f);
    const outcome = run.outcome as Failed;
    expect(outcome).toMatchObject({ status: "failed", error_code: "invalid_output" });
    expect(outcome.wip).toBeUndefined();
    expect(pushedBranches(f)).toEqual([]);
    expect((await f.runs(it0, "implement"))[1]?.input?.wip).toBeUndefined();
  });

  it("a runner that keeps no session: no repair turn, the commits go straight to the wip branch", async () => {
    const f = await harness([{ output: { next_steps: "n" } }, { output: VALID }], { sessions: false });
    const { run } = await firstRun(f);
    expect(implementSpecs(f).length).toBe(1);
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "invalid_output", wip: { head: WIP_HEAD, continue: true } });
  });

  it.each([
    ["a valid answer", { output: VALID }],
    ["a needs_human answer", { output: { needs_human: { reason: "r", question: "q" } } }],
    ["a spec_conflict answer", { output: { spec_conflict: "criterion 1 needs web/x.tsx" } }],
  ])("%s gets no repair turn", async (_, answer) => {
    const f = await harness([answer, { output: VALID }]);
    const { run } = await firstRun(f);
    // The first run's agent ran once: no second turn, no resumed session (a spec revision may start a later run).
    expect(implementSpecs(f).filter((s) => s.run_id === run.id).map((s) => s.session?.resume)).toEqual([false]);
  });
});
