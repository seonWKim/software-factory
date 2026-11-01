import { describe, expect, it } from "vitest";
import type { Run, RunOutcome } from "../src/core/types.js";
import type { ToolResult } from "../src/interfaces/tool-broker.js";
import { pipeline } from "./helpers/fakes.js";

// Design §5 Restarts: a push or PR failure after a successful agent step leaves the run's commits on a wip branch
// on the forge, under the branch prefix. The retry checks that branch out and pushes it with no agent run.

type Harness = Awaited<ReturnType<typeof pipeline>>;
const HEAD = "headsha1";
const PUSH_FAILED: ToolResult = { ok: false, error_code: "push_failed", message: "! [remote rejected] (pre-receive hook declined)" };
type Failed = Extract<RunOutcome, { status: "failed" }>;

async function setup() {
  const f = await pipeline();
  f.sandbox.commits = ["c1", "c2"];
  f.sandbox.head = `${HEAD}\n`;
  /** The head the sandbox was on at each push, by branch. */
  const pushes: { branch: string; head: string }[] = [];
  const call = f.broker.call.bind(f.broker);
  f.broker.call = async (ctx, name, args) => {
    if (name === "github.push_branch") pushes.push({ branch: (args as { branch: string }).branch, head: f.sandbox.head.trim() });
    return call(ctx, name, args);
  };
  return { f, pushes };
}

/** Makes the wip branch the failed run pushed resolvable in the next sandbox, as the forge would after a fetch. */
function publishWip(f: Harness, run: Run): string {
  const wip = (run.outcome as Failed).wip!;
  f.sandbox.refs[`origin/${wip.branch}`] = wip.head;
  return wip.branch;
}

describe("wip branch on a failed push or PR", () => {
  it("a failed push leaves the commits on a wip branch under the prefix, and the run fails with the push's code", async () => {
    const { f, pushes } = await setup();
    f.broker.responses["github.push_branch"] = [PUSH_FAILED];
    const it0 = await f.submit();
    await f.step();
    const [run] = await f.runs(it0, "implement");
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: "push_failed" });
    const wip = (run!.outcome as Failed).wip!;
    expect(wip.branch).toBe(`factory/wip/${it0.id}/${run!.id}`);
    expect(wip.head).toBe(HEAD);
    expect(pushes).toEqual([
      { branch: `factory/${it0.id}`, head: HEAD },
      { branch: wip.branch, head: HEAD },
    ]);
    // The retry carries the wip branch in its input.
    const retry = (await f.runs(it0, "implement"))[1]!;
    expect(retry).toMatchObject({ status: "queued" });
    expect(retry.input?.wip).toEqual(wip);
  });

  it("the retry makes no runner call, pushes the same commit SHAs and opens the PR", async () => {
    const { f, pushes } = await setup();
    f.broker.responses["github.push_branch"] = [PUSH_FAILED];
    const it0 = await f.submit();
    await f.step();
    const [failed] = await f.runs(it0, "implement");
    publishWip(f, failed!);
    const handoffs = await f.store.listHandoffs(it0.id);
    expect(handoffs.map((h) => h.commit_sha)).toEqual(["c1", "c2"]);
    expect(f.agentCalls("implement")).toBe(1);

    f.sandbox.head = "somewhere-else\n"; // the fresh sandbox starts elsewhere; the resume checks out the wip head
    f.clock.advance(f.config.retry_base_ms);
    await f.step();
    expect(f.agentCalls("implement")).toBe(1);
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", pr_number: 42 });
    const retry = (await f.runs(it0, "implement"))[1]!;
    expect(retry.outcome).toMatchObject({ status: "succeeded", data: { pr_number: 42, commits: 2 } });
    expect(pushes.at(-1)).toEqual({ branch: `factory/${it0.id}`, head: HEAD });
    expect(f.sandbox.gitCalls).toContain(`-c core.hooksPath=/dev/null checkout --quiet -f -B factory/${it0.id} ${HEAD}`);
    // The PR body is the failed run's agent summary.
    const pr = f.broker.calls.filter((c) => c.name === "github.open_pr").at(-1)!;
    expect((pr.args as { body: string }).body).toContain("the summary");
    // No handoff rows for commits already recorded.
    expect((await f.store.listHandoffs(it0.id)).map((h) => h.commit_sha)).toEqual(["c1", "c2"]);
  });

  it("a failed PR after a pushed branch also resumes from the wip branch", async () => {
    const { f } = await setup();
    f.broker.responses["github.open_pr"] = [{ ok: false, error_code: "pr_failed", message: "422" }];
    const it0 = await f.submit();
    await f.step();
    const [failed] = await f.runs(it0, "implement");
    expect(failed!.outcome).toMatchObject({ error_code: "pr_failed", wip: { head: HEAD } });
    publishWip(f, failed!);
    f.clock.advance(f.config.retry_base_ms);
    await f.step();
    expect(f.agentCalls("implement")).toBe(1);
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", pr_number: 42 });
  });

  it("a PR call that throws is caught the same way: wip pushed, then the run fails", async () => {
    const { f } = await setup();
    const call = f.broker.call.bind(f.broker);
    let thrown = false;
    f.broker.call = async (ctx, name, args) => {
      if (name === "github.open_pr" && !thrown) {
        thrown = true;
        throw new Error("GitHub POST /repos/o/r/pulls → 500");
      }
      return call(ctx, name, args);
    };
    const it0 = await f.submit();
    await f.step();
    const [failed] = await f.runs(it0, "implement");
    expect(failed!.outcome).toMatchObject({ status: "failed", error_code: "exception", wip: { head: HEAD } });
  });

  it("if the wip push fails too, the run fails with its original code and the retry runs the agent again", async () => {
    const { f } = await setup();
    f.broker.responses["github.push_branch"] = [PUSH_FAILED, { ok: false, error_code: "push_failed", message: "wip rejected" }];
    const it0 = await f.submit();
    await f.step();
    const [failed] = await f.runs(it0, "implement");
    expect(failed!.outcome).toMatchObject({ status: "failed", error_code: "push_failed", detail: PUSH_FAILED.ok ? "" : PUSH_FAILED.message });
    expect((failed!.outcome as Failed).wip).toBeUndefined();
    const retry = (await f.runs(it0, "implement"))[1]!;
    expect(retry).toMatchObject({ status: "queued" });
    expect(retry.input?.wip).toBeUndefined();
    f.clock.advance(f.config.retry_base_ms);
    await f.step();
    expect(f.agentCalls("implement")).toBe(2);
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW" });
  });

  it("a resumed run that fails its push again keeps the same wip branch and pushes no new one", async () => {
    const { f, pushes } = await setup();
    f.broker.responses["github.push_branch"] = [PUSH_FAILED];
    const it0 = await f.submit();
    await f.step();
    const [first] = await f.runs(it0, "implement");
    const branch = publishWip(f, first!);
    f.broker.responses["github.push_branch"] = [PUSH_FAILED];
    f.clock.advance(f.config.retry_base_ms);
    const before = pushes.length;
    await f.step();
    const second = (await f.runs(it0, "implement"))[1]!;
    expect(second.outcome).toMatchObject({ status: "failed", error_code: "push_failed", wip: { branch, head: HEAD } });
    expect(pushes.slice(before).map((p) => p.branch)).toEqual([`factory/${it0.id}`]);
    expect((await f.runs(it0, "implement"))[2]!.input?.wip?.branch).toBe(branch);
    expect(f.agentCalls("implement")).toBe(1);
  });

  it("on a resumed run, a base merge conflict fails with merge_conflict and makes no agent call", async () => {
    const { f } = await setup();
    f.broker.responses["github.push_branch"] = [PUSH_FAILED];
    const it0 = await f.submit();
    await f.step();
    const [failed] = await f.runs(it0, "implement");
    publishWip(f, failed!);
    // The base moved and merging it conflicts (the fake's own merge rule does not see the hooks-off form).
    f.sandbox.ancestorExit = 1;
    f.sandbox.conflicts = ["src/a.ts"];
    const exec = f.sandbox.exec.bind(f.sandbox);
    f.sandbox.exec = async (h, cmd, o) => {
      const r = await exec(h, cmd, o);
      return cmd.slice(1).join(" ").startsWith("-c core.hooksPath=/dev/null merge --no-ff") ? { ...r, exit_code: 1 } : r;
    };
    f.clock.advance(f.config.retry_base_ms);
    const pushesBefore = f.broker.calls.filter((c) => c.name === "github.push_branch").length;
    await f.w1.tick();
    const retry = (await f.runs(it0, "implement"))[1]!;
    expect(retry.outcome).toMatchObject({ status: "failed", error_code: "merge_conflict" });
    expect(f.agentCalls("implement")).toBe(1);
    // Nothing pushed by the resumed run: not the PR branch, not a new wip branch.
    expect(f.broker.calls.filter((c) => c.name === "github.push_branch")).toHaveLength(pushesBefore);
    const comment = f.broker.calls.filter((c) => c.name === "github.comment").at(-1)!;
    expect((comment.args as { body: string }).body).toContain("resumed from its wip branch");
  });

  it("a wip branch that is gone or moved is not trusted: the retry runs the agent again", async () => {
    const { f } = await setup();
    f.broker.responses["github.push_branch"] = [PUSH_FAILED];
    const it0 = await f.submit();
    await f.step();
    const [failed] = await f.runs(it0, "implement");
    f.sandbox.refs[`origin/${(failed!.outcome as Failed).wip!.branch}`] = "someone-elses-sha";
    f.clock.advance(f.config.retry_base_ms);
    await f.step();
    expect(f.agentCalls("implement")).toBe(2);
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW" });
    expect(f.log.lines.some((l) => l.msg.includes("wip branch"))).toBe(true);
  });
});
