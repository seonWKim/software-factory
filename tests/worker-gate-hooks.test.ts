import { describe, expect, it } from "vitest";
import { AGENT_STOP_CHECKS_DEFAULT } from "../src/core/config.js";
import type { AgentRunResult, AgentRunSpec, GateBlock } from "../src/interfaces/agent-runner.js";
import { PROJECT, config, pipeline } from "./helpers/fakes.js";

// The gate hooks (design §4 Pre-push gates, issue #302): the worker gives the implement run's main and fix steps
// the values its own gates use, logs one line per block, and its gates still decide.

const DONE = { output: { summary: "the summary", next_steps: "the next steps" } };
const CHECKS = [["npm", "run", "typecheck"], ["npm", "test"]];

/** An implement script that reports `blocks` on its first call (the main step) and none after. */
function reporting(blocks: GateBlock[]) {
  let calls = 0;
  return (): Partial<AgentRunResult> => (calls++ === 0 ? { ...DONE, gate_blocks: blocks } : DONE);
}

const implementSpecs = (f: Awaited<ReturnType<typeof pipeline>>): AgentRunSpec[] => f.runner.specs.filter((s) => s.role === "implement");

describe("worker: gate hooks in the run spec", () => {
  it("the main step gets the start, the base, allowed_paths, the project's size limits, the check list and the default cap", async () => {
    const f = await pipeline({
      config: {
        repo: { ...config.repo, check_commands: CHECKS },
        settings: { ...config.settings, projects: { [PROJECT.key]: { max_diff_lines: 321, max_diff_files: 7 } } },
      },
    });
    const item = await f.submit();
    await f.step();
    const [main] = implementSpecs(f);
    expect(main!.gate_hooks).toEqual({
      allowed_paths: (await f.item(item)).allowed_paths,
      start_sha: "base",
      base_sha: "basesha",
      limits: { max_diff_lines: 321, max_diff_files: 7 },
      check_commands: CHECKS,
      check_env: {},
      stop_checks: AGENT_STOP_CHECKS_DEFAULT,
      stop_blocks_used: 0,
    });
    expect(AGENT_STOP_CHECKS_DEFAULT).toBe(3);
    expect(main!.gate_hooks!.allowed_paths).toEqual([".github/workflows/"]);
  });

  it("agent_stop_checks sets the cap", async () => {
    const f = await pipeline({ config: { agent_stop_checks: 5 } });
    await f.submit();
    await f.step();
    expect(implementSpecs(f)[0]!.gate_hooks!.stop_checks).toBe(5);
  });

  it("the fix step gets the hooks too, with the Stop blocks the main step used and the merged-in base", async () => {
    const f = await pipeline({
      implement: reporting([
        { hook: "stop", check: "npm test", attempt: 1 },
        { hook: "pre_tool_use", check: "allowed_paths", attempt: 1 },
        { hook: "stop", check: "no_commits", attempt: 2 },
      ]),
    });
    f.sandbox.exits["npm test"] = 1;
    await f.submit();
    await f.step();
    const [main, fix] = implementSpecs(f);
    expect(fix!.prompt).toContain("## Checks failed before push");
    expect(fix!.gate_hooks).toMatchObject({ start_sha: main!.gate_hooks!.start_sha, base_sha: "basesha", stop_checks: 3, stop_blocks_used: 2 });
  });

  it("the merge-conflict step, triage and review get no hooks", async () => {
    const f = await pipeline();
    // The base is not in the branch (the trusted base is still in the fetched one), and merging it conflicts.
    const exec = f.sandbox.exec.bind(f.sandbox);
    f.sandbox.exec = async (h, cmd, o) => {
      const r = await exec(h, cmd, o);
      const line = cmd.join(" ");
      return line === "git merge-base --is-ancestor basesha HEAD" || line.includes(" merge --no-ff ") ? { ...r, exit_code: 1 } : r;
    };
    f.sandbox.conflicts = [".github/workflows/scope.yml"];
    f.sandbox.files = { ".github/workflows/scope.yml": "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main\n" };
    f.runner.script.resolve = () => DONE;
    await f.submit();
    await f.step();
    const [main, ...later] = implementSpecs(f);
    expect(main!.gate_hooks).toBeDefined();
    expect(later.some((s) => s.prompt.includes(".github/workflows/scope.yml") && /conflict/i.test(s.prompt))).toBe(true);
    for (const s of later) expect(s.gate_hooks).toBeUndefined();
    for (const s of f.runner.specs.filter((x) => x.role !== "implement")) expect(s.gate_hooks).toBeUndefined();
    expect(f.runner.specs.some((s) => s.role === "triage")).toBe(true);
  });

  it("review runs get no hooks", async () => {
    const f = await pipeline();
    await f.submit();
    await f.step();
    const reviews = f.runner.specs.filter((s) => s.role === "review");
    expect(reviews.length).toBeGreaterThan(0);
    for (const s of reviews) expect(s.gate_hooks).toBeUndefined();
  });
});

describe("worker: gate hook blocks", () => {
  it("writes one log line per block with the run ID, the check and the attempt", async () => {
    const blocks: GateBlock[] = [
      { hook: "pre_tool_use", check: "allowed_paths", attempt: 1 },
      { hook: "stop", check: "npm test", attempt: 1 },
    ];
    const f = await pipeline({ implement: reporting(blocks) });
    const item = await f.submit();
    await f.step();
    const [run] = await f.runs(item, "implement");
    const lines = f.log.lines.filter((l) => l.msg === "gate hook sent the agent back");
    expect(lines.map((l) => l.fields)).toEqual([
      { run_id: run!.id, step: "", hook: "pre_tool_use", check: "allowed_paths", attempt: 1 },
      { run_id: run!.id, step: "", hook: "stop", check: "npm test", attempt: 1 },
    ]);
  });

  it("the worker's gates still decide: a step that stopped after its blocks with no commits fails with no_commits", async () => {
    const f = await pipeline({ implement: reporting([{ hook: "stop", check: "no_commits", attempt: 3 }]) });
    f.sandbox.commits = [];
    const item = await f.submit();
    await f.step();
    const [run] = await f.runs(item, "implement");
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: "no_commits", detail: "the implementer made no commits" });
  });
});
