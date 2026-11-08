import { describe, expect, it } from "vitest";
import { DIFF_CHECK_MS } from "../src/worker/index.js";
import type { FactoryConfig } from "../src/core/config.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import { PROJECT, config, pipeline, waitFor } from "./helpers/fakes.js";

// The implement run's diff budget (design §4 Pre-push gates, issue #217): the prompt states the item's project's
// max_diff_lines and max_diff_files, and while the agent step runs the worker reads the branch diff against the base
// every DIFF_CHECK_MS. Over either limit: the agent is stopped, the commits go to the run's wip branch, the run fails
// with diff_too_large, and no PR branch is pushed and no PR opened.

type Harness = Awaited<ReturnType<typeof pipeline>>;

/** An implement script that lets the mid-run check run once with `numstat`, then waits for an abort or finishes. */
const midRun = (get: () => Harness, numstat: string) => async (spec: AgentRunSpec) => {
  const f = get();
  const before = f.sandbox.gitCalls.filter((c) => c.startsWith("diff --numstat")).length;
  f.sandbox.numstat = numstat;
  f.clock.advance(DIFF_CHECK_MS);
  await waitFor(
    () => spec.signal.aborted || f.sandbox.gitCalls.filter((c) => c.startsWith("diff --numstat")).length > before,
    "the mid-run diff check",
  );
  // Let a check that just read the diff decide before the step returns.
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  if (spec.signal.aborted) return { status: "aborted" as const, output: null };
  return { output: { summary: "the summary", next_steps: "the next steps" } };
};

async function harness(numstat: string, cfg: Partial<FactoryConfig> = {}) {
  let f: Harness | null = null;
  f = await pipeline({ implement: midRun(() => f!, numstat), config: cfg });
  return f;
}

describe("implement diff budget", () => {
  it("states the item's project's max_diff_lines and max_diff_files in the implement prompt", async () => {
    const f = await harness(`1\t0\t.github/workflows/scope.yml\0`, {
      settings: { ...config.settings, projects: { [PROJECT.key]: { max_diff_lines: 1234, max_diff_files: 17 } } },
    });
    await f.submit();
    await f.step();
    const spec = f.runner.specs.find((s) => s.role === "implement")!;
    expect(spec.prompt).toContain("## Diff budget");
    expect(spec.prompt).toContain("1234 lines");
    expect(spec.prompt).toContain("17 files");
    expect(spec.prompt).toContain("diff_too_large");
  });

  it("stops an over-budget agent step early, keeps its commits on the wip branch and opens no PR", async () => {
    const f = await harness(`1501\t0\t.github/workflows/big.yml\0`);
    const it0 = await f.submit();
    await f.step();

    const runs = await f.runs(it0, "implement");
    expect(runs.map((r) => r.status)).toEqual(["failed"]);
    const outcome = runs[0]!.outcome!;
    expect(outcome).toMatchObject({ status: "failed", error_code: "diff_too_large", infra: false });
    if (outcome.status !== "failed") throw new Error("not failed");
    expect(outcome.detail).toContain("1501 lines (limit max_diff_lines = 1500)");
    expect(outcome.detail).toContain("1 files (limit max_diff_files = 40)");
    // The agent saw the abort, and no later agent step (merge, fix) ran in the run.
    expect(f.runner.specs.filter((s) => s.role === "implement")).toHaveLength(1);
    expect(f.runner.specs[f.runner.specs.length - 1]!.role).toBe("implement");
    expect(f.runner.aborted.map((s) => s.role)).toEqual(["implement"]);

    // The commits on the wip branch, recorded on the outcome; nothing to the PR branch, no PR.
    const wipBranch = `factory/wip/${it0.id}/${runs[0]!.id}`;
    expect(outcome.wip).toMatchObject({ branch: wipBranch, commits: 1 });
    const pushes = f.broker.calls.filter((c) => c.name === "github.push_branch").map((c) => (c.args as { branch: string }).branch);
    expect(pushes).toEqual([wipBranch]);
    expect(f.broker.calls.some((c) => c.name === "github.open_pr")).toBe(false);
    // No sync and no check ran after the stop: the run failed before the base merge and the pre-push checks.
    expect(f.sandbox.commands).not.toContain("npm test");

    // Not retried automatically (NO_AUTO_RETRY): the item blocks on a human.
    f.clock.advance(f.config.retry_max_ms * 4);
    await f.step();
    expect((await f.runs(it0, "implement")).map((r) => r.status)).toEqual(["failed"]);
    expect(await f.item(it0)).toMatchObject({ blocked_on: "human", blocked_reason: "run_failed:implement:diff_too_large" });
    expect((await f.store.listStateChanges(it0.id)).map((s) => s.reason)).not.toContain("run_retry_scheduled");
  });

  it("goes over budget on files alone", async () => {
    const files = Array.from({ length: 41 }, (_, i) => `1\t0\t.github/workflows/f${i}.yml\0`).join("");
    const f = await harness(files);
    const it0 = await f.submit();
    await f.step();
    const [run] = await f.runs(it0, "implement");
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: "diff_too_large" });
    if (run!.outcome?.status !== "failed") throw new Error("not failed");
    expect(run!.outcome.detail).toContain("41 files (limit max_diff_files = 40)");
  });

  it("passes a diff exactly at both limits: the run goes on and opens its PR", async () => {
    const files = [`1461\t0\t.github/workflows/f0.yml\0`, ...Array.from({ length: 39 }, (_, i) => `1\t0\t.github/workflows/f${i + 1}.yml\0`)].join("");
    const f = await harness(files);
    const it0 = await f.submit();
    await f.step();
    expect(f.runner.aborted).toHaveLength(0);
    const [run] = await f.runs(it0, "implement");
    expect(run!.outcome).toMatchObject({ status: "succeeded" });
    expect(f.broker.calls.some((c) => c.name === "github.open_pr")).toBe(true);
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW" });
  });

  it("reads the diff in a git folder of its own, so the agent's git config and hooks cannot change it", async () => {
    const f = await harness(`1501\t0\t.github/workflows/big.yml\0`);
    await f.submit();
    await f.step();
    const i = f.sandbox.gitCalls.findIndex((c) => c.startsWith("diff --numstat"));
    expect(i).toBeGreaterThanOrEqual(0);
    const env = f.sandbox.gitEnvs[i]!;
    // Not the run's git folder (/repo/.git in the fake): an empty one the worker made, reading only the objects.
    expect(env.GIT_DIR).toBeDefined();
    expect(env.GIT_DIR).not.toBe("/repo/.git");
    expect(env.GIT_OBJECT_DIRECTORY).toBe("/repo/.git/objects");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_KEY_0).toBe("core.hooksPath");
    expect(env.GIT_CONFIG_VALUE_0).toBe("/dev/null");
    expect(f.sandbox.gitCalls.some((c) => c.startsWith("init --bare"))).toBe(true);
    // The folder is removed after the read.
    expect(f.sandbox.commands.some((c) => c.startsWith("rm -rf -- ") && c.endsWith(env.GIT_DIR!))).toBe(true);
  });
});
