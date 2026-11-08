import { describe, expect, it } from "vitest";
import type { Run, RunOutcome } from "../src/core/types.js";
import { STORE_BRANCH, type ToolResult } from "../src/interfaces/tool-broker.js";
import { pipeline, runComments } from "./helpers/fakes.js";

// Design §5 Restarts: a failure of the run's last step (storing its branch, RFC 0015 M7) after a successful agent step
// leaves the run's commits on a wip branch, under the branch prefix. The retry checks that branch out and stores it
// with no agent run. A failed forge push or PR is outbound's, retried there (tests/outbound/run-push.test.ts).

type Harness = Awaited<ReturnType<typeof pipeline>>;
const HEAD = "headsha1";
const PUSH_FAILED: ToolResult = { ok: false, error_code: "push_failed", message: "! [remote rejected] (pre-receive hook declined)" };
type Failed = Extract<RunOutcome, { status: "failed" }>;

async function setup() {
  const f = await pipeline();
  f.sandbox.commits = ["c1", "c2"];
  f.sandbox.head = `${HEAD}\n`;
  /** The head the sandbox was on at each branch the broker wrote (the run's store, a wip push), by branch. */
  const pushes: { branch: string; head: string }[] = [];
  const call = f.broker.call.bind(f.broker);
  f.broker.call = async (ctx, name, args) => {
    if (name === "github.push_branch" || name === STORE_BRANCH) pushes.push({ branch: (args as { branch: string }).branch, head: f.sandbox.head.trim() });
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

describe("wip branch on a failed last step", () => {
  it("a failed branch store leaves the commits on a wip branch under the prefix, and the run fails with its code", async () => {
    const { f, pushes } = await setup();
    f.broker.responses[STORE_BRANCH] = [PUSH_FAILED];
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

  it("the retry makes no runner call, stores the same commit SHAs, and outbound opens the PR", async () => {
    const { f, pushes } = await setup();
    f.broker.responses[STORE_BRANCH] = [PUSH_FAILED];
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
    expect(retry.outcome).toMatchObject({ status: "succeeded", data: { pr_pending: true, commits: 2 } });
    expect(pushes.at(-1)).toEqual({ branch: `factory/${it0.id}`, head: HEAD });
    // A fresh index, the wip head checked out, then no untracked files left from the base the clone started on:
    // files the base added since the wip commit would make the sync's merge abort (git_failed on every retry).
    const checkout = f.sandbox.gitCalls.indexOf(`-c core.hooksPath=/dev/null checkout --quiet -f -B factory/${it0.id} ${HEAD}`);
    expect(checkout).toBeGreaterThan(0);
    expect(f.sandbox.gitCalls[checkout - 1]).toBe(`read-tree ${HEAD}`);
    expect(f.sandbox.gitCalls[checkout + 1]).toBe("-c core.hooksPath=/dev/null clean -ffdq");
    // The PR body is the failed run's agent summary.
    const pr = f.broker.calls.filter((c) => c.name === "github.open_pr").at(-1)!;
    expect((pr.args as { body: string }).body).toContain("the summary");
    // No handoff rows for commits already recorded.
    expect((await f.store.listHandoffs(it0.id)).map((h) => h.commit_sha)).toEqual(["c1", "c2"]);
  });

  it("if the wip push fails too, the run fails with its original code and the retry runs the agent again", async () => {
    const { f } = await setup();
    f.broker.responses[STORE_BRANCH] = [PUSH_FAILED];
    f.broker.responses["github.push_branch"] = [{ ok: false, error_code: "push_failed", message: "wip rejected" }];
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
    f.broker.responses[STORE_BRANCH] = [PUSH_FAILED];
    const it0 = await f.submit();
    await f.step();
    const [first] = await f.runs(it0, "implement");
    const branch = publishWip(f, first!);
    f.broker.responses[STORE_BRANCH] = [PUSH_FAILED];
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
    f.broker.responses[STORE_BRANCH] = [PUSH_FAILED];
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
    const storesBefore = f.broker.stores.length;
    await f.w1.tick();
    const retry = (await f.runs(it0, "implement"))[1]!;
    expect(retry.outcome).toMatchObject({ status: "failed", error_code: "merge_conflict" });
    expect(f.agentCalls("implement")).toBe(1);
    // Nothing pushed by the resumed run: not the PR branch, not a new wip branch.
    expect(f.broker.calls.filter((c) => c.name === "github.push_branch")).toHaveLength(pushesBefore);
    expect(f.broker.stores).toHaveLength(storesBefore);
    const comment = (await runComments(f.store, it0.id)).filter((c) => c.marker === `<!-- factory:merge-conflict:${retry.id} -->`);
    expect(comment.map((c) => c.body)).toEqual([expect.stringContaining("resumed from its wip branch")]);
  });

  it("a wip branch that is gone or moved is not trusted: the retry runs the agent again", async () => {
    const { f } = await setup();
    f.broker.responses[STORE_BRANCH] = [PUSH_FAILED];
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
