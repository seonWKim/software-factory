import { describe, expect, it } from "vitest";
import { DIFF_CHECK_MS } from "../src/worker/index.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { Run } from "../src/core/types.js";
import { alice, pipeline, waitFor } from "./helpers/fakes.js";

// Design §5 Restarts: four implement failures are never retried automatically, since the same spec fails the
// same way. Each blocks the item on a human with run_failed:implement:<code> and one comment; /retry runs it again.

type Harness = Awaited<ReturnType<typeof pipeline>>;

/**
 * The canary, which fails a run when a transcript holds it (a token-shaped string alone only keeps the transcript
 * out of storage). Built here so this file holds no literal the scanner flags.
 */
const TOKEN = ["sf", "canary", "abcdef123456"].join("-");

/** Nothing reaches the forge: no push at all. */
const nothingPushed = (f: Harness) => expect(f.broker.calls.some((x) => x.name === "forge.push_branch")).toBe(false);

const CASES: {
  code: string;
  setup: (f: Harness) => void;
  implement?: (spec: AgentRunSpec, f: Harness) => Partial<AgentRunResult> | Promise<Partial<AgentRunResult>>;
  pushed: (f: Harness, run: Run) => void;
}[] = [
  { code: "no_commits", setup: (f) => void (f.sandbox.commits = []), pushed: nothingPushed },
  { code: "scope_violation", setup: (f) => void (f.sandbox.changedFiles = ["src/core/worker.ts"]), pushed: nothingPushed },
  {
    code: "egress_blocked",
    setup: () => undefined,
    implement: () => ({ output: { summary: "s", next_steps: "n" }, transcript: `the agent printed ${TOKEN}` }),
    pushed: nothingPushed,
  },
  {
    // The mid-run diff check stops the agent (design §4, issue #217): the commits go to the wip branch only.
    code: "diff_too_large",
    setup: () => undefined,
    implement: async (spec, f) => {
      f.sandbox.numstat = `5000\t0\t.github/workflows/big.yml\0`;
      f.clock.advance(DIFF_CHECK_MS);
      await waitFor(() => spec.signal.aborted, "the mid-run diff check");
      return { status: "aborted", output: null };
    },
    pushed: (f, run) => {
      const wip = `factory/wip/${run.work_item_id}/${run.id}`;
      const pushes = f.broker.calls.filter((x) => x.name === "forge.push_branch").map((x) => (x.args as { branch: string }).branch);
      expect(pushes).toEqual([wip]);
      expect(f.broker.calls.some((x) => x.name === "forge.open_change")).toBe(false);
      expect(run.outcome).toMatchObject({ wip: { branch: wip, commits: 1 } });
    },
  },
];

for (const c of CASES) {
  describe(`implement failure ${c.code}`, () => {
    const make = async () => {
      let fail = true;
      const ok = { output: { summary: "s", next_steps: "n" } };
      let h: Harness | null = null;
      const f = await pipeline({ implement: (spec) => (fail && c.implement ? c.implement(spec, h!) : ok) });
      h = f;
      c.setup(f);
      return { f, heal: () => {
        fail = false;
        f.sandbox.commits = ["c1"];
        f.sandbox.changedFiles = [];
        f.sandbox.numstat = null;
      } };
    };

    it("is not retried: the item blocks on a human with run_failed:implement:<code> and one comment", async () => {
      const { f } = await make();
      const it0 = await f.submit();
      await f.step();
      f.clock.advance(f.config.retry_max_ms * 4);
      await f.step();

      const runs = await f.runs(it0, "implement");
      expect(runs.map((r) => r.status)).toEqual(["failed"]);
      expect(runs[0]!.outcome).toMatchObject({ status: "failed", error_code: c.code });
      expect(await f.item(it0)).toMatchObject({
        stage: "RUNNING", blocked_on: "human", blocked_reason: `run_failed:implement:${c.code}`, restart_count: 0,
      });
      const comments = f.source.comments.filter((m) => m.marker === `<!-- factory:run-failed:${runs[0]!.id} -->`);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toContain(`\`${c.code}\``);
      expect(comments[0]!.body).toContain("/retry");
      expect(comments[0]!.body).not.toContain(TOKEN);
      c.pushed(f, runs[0]!);
      const changes = (await f.store.listStateChanges(it0.id)).map((s) => s.reason);
      expect(changes).not.toContain("run_retry_scheduled");
      expect(changes.at(-1)).toBe("run_failed");
    });

    it("applying the failed run twice posts one comment and blocks once", async () => {
      const { f } = await make();
      const it0 = await f.submit();
      await f.w1.tick(); // triage
      await f.controller.tickRuns(); // → implement queued
      await f.w1.tick(); // implement fails
      const [done] = await f.store.listUnacknowledgedRuns(10);
      await Promise.all([f.controller.applyRun(done!), f.controller.applyRun(done!)]);
      await f.controller.applyRun(done!);
      expect(f.source.comments.filter((m) => m.marker === `<!-- factory:run-failed:${done!.id} -->`)).toHaveLength(1);
      expect((await f.store.listStateChanges(it0.id)).filter((s) => s.reason === "run_failed")).toHaveLength(1);
    });

    it("/retry then starts a new implement run", async () => {
      const { f, heal } = await make();
      const it0 = await f.submit();
      await f.step();
      expect((await f.item(it0)).blocked_reason).toBe(`run_failed:implement:${c.code}`);
      const agentRuns = f.agentCalls("implement");
      heal();
      f.source.queue.push({ kind: "retry_requested", source: it0.source, comment_id: "900", requester: alice });
      await f.controller.tickIntake();
      expect(await f.item(it0)).toMatchObject({ blocked_on: "none", blocked_reason: null, restart_count: 1 });
      expect((await f.runs(it0, "implement")).at(-1)).toMatchObject({ status: "queued", not_before: null });
      await f.step();
      expect(f.agentCalls("implement")).toBe(agentRuns + 1);
      expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    });
  });
}

describe("other implement failure codes", () => {
  it("are still retried automatically with backoff", async () => {
    let fails = 1;
    const f = await pipeline({
      implement: () => (fails-- > 0 ? { status: "failed", error: "boom" } : { output: { summary: "s", next_steps: "n" } }),
    });
    const it0 = await f.submit();
    await f.step();
    expect(await f.item(it0)).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
    expect((await f.runs(it0, "implement")).map((r) => r.status)).toEqual(["failed", "queued"]);
    f.clock.advance(f.config.retry_base_ms);
    await f.step();
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
  });
});
