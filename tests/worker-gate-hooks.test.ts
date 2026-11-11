import { describe, expect, it } from "vitest";
import { AGENT_STOP_CHECKS_DEFAULT } from "../src/core/config.js";
import type { AgentRunResult, AgentRunSpec, GateBlock } from "../src/interfaces/agent-runner.js";
import type { WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { PackCheckRunner, type PackCheckSpec } from "../src/runtime/hooks/pack-checks.js";
import { SqlHookAudit } from "../src/runtime/index.js";
import { HOOK_REFUSED, Worker } from "../src/worker/runner.js";
import { MemoryStorage, PROJECT, cleanScanner, config, pipeline, prompts } from "./helpers/fakes.js";

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

// Pack checks in the implement run (design §4, issue #494): before_agent and after_agent around each agent step,
// on_tool_call in the gate hooks, before_finish before the pre-push gates. A pass approves nothing.

/** A pipeline whose worker `pw` runs the pack checks `checks` (argv[0] is the check's name) on the fake sandbox. */
async function packPipeline(checks: PackCheckSpec[], o: { toolEnv?: Record<string, string> } = {}) {
  const f = await pipeline();
  /** Every command the sandbox ran and every agent step, in order. */
  const order: string[] = [];
  /** The env and argv of each pack check run. */
  const checkRuns: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  /** How many times each check refuses before it passes (absent: it passes; Infinity: it always refuses). */
  const refuse: Record<string, number> = {};
  const names = new Set(checks.map((c) => c.name));
  const exec = f.sandbox.exec.bind(f.sandbox);
  f.sandbox.exec = async (h, cmd, opts) => {
    order.push(cmd.join(" "));
    if (!names.has(cmd[0]!)) return exec(h, cmd, opts);
    checkRuns.push({ argv: cmd, env: opts.env });
    const left = refuse[cmd[0]!] ?? 0;
    if (left > 0) refuse[cmd[0]!] = left - 1;
    return { exit_code: left > 0 ? 1 : 0, signal: null, stdout: "", stderr: left > 0 ? `${cmd[0]} says no` : "", timed_out: false };
  };
  const run = f.runner.run.bind(f.runner);
  f.runner.run = async (spec) => {
    order.push(`agent:${spec.role}`);
    return run(spec);
  };
  const audit = new SqlHookAudit(storeSql(f.store));
  const pack_checks = new PackCheckRunner(checks, { sandbox: f.sandbox, audit, now: () => f.clock.now().toISOString() });
  const pw = new Worker({
    id: "pw" as WorkerId, store: f.store, sandbox: f.sandbox, runner: f.runner, broker: f.broker, storage: new MemoryStorage(),
    clock: f.clock, config: f.config, prompts, log: f.log, scanner: cleanScanner, toolEnv: o.toolEnv ?? {}, awake: new NoKeepAwake(),
    prRef: (pr) => f.forge.prRef(pr),
  }, { pack_checks });
  const step = async () => {
    while (await pw.tick()) await f.controller.tickRuns();
    await f.controller.tickRuns();
  };
  return { ...f, order, checkRuns, refuse, audit, step };
}

const check = (name: string, point: PackCheckSpec["point"], retries = 3): PackCheckSpec => ({ name, point, argv: [name, "--flag"], timeout_ms: 1000, retries });
const ALL = [check("ba", "before_agent"), check("tc", "on_tool_call"), check("bf", "before_finish"), check("aa", "after_agent")];

describe("worker: pack checks in the implement run", () => {
  it("before_agent and after_agent run around the agent step, before_finish after it and before the pre-push gates and checks", async () => {
    const f = await packPipeline(ALL);
    const item = await f.submit();
    await f.step();
    const [run] = await f.runs(item, "implement");
    expect(run!.outcome?.status).toBe("succeeded");
    const at = (prefix: string) => f.order.findIndex((l) => l.startsWith(prefix));
    expect(at("ba")).toBeGreaterThanOrEqual(0);
    expect(at("ba")).toBeLessThan(at("agent:implement"));
    expect(at("agent:implement")).toBeLessThan(at("aa"));
    expect(at("aa")).toBeLessThan(at("bf"));
    // The scope gate's diff, then the check list: both after before_finish.
    const gates = f.order.findIndex((l, i) => i > at("bf") && l.startsWith("git diff"));
    expect(gates).toBeGreaterThan(at("bf"));
    expect(f.order.lastIndexOf("npm test")).toBeGreaterThan(at("bf"));
    expect(f.order.slice(0, at("bf")).filter((l) => l.startsWith("git diff --name-only") || l === "npm test")).toEqual([]);
    // Triage and review steps run no pack check: only the implement run's step is wrapped.
    expect(f.checkRuns.map((r) => r.argv[0])).toEqual(["ba", "aa", "bf"]);
  });

  it("the main step's gate hooks carry the on_tool_call checks; triage and review get none", async () => {
    const f = await packPipeline(ALL);
    await f.submit();
    await f.step();
    const [main] = implementSpecs(f);
    expect(main!.gate_hooks!.on_tool_call!.checks).toEqual(["tc"]);
    for (const s of f.runner.specs.filter((x) => x.role !== "implement")) expect(s.gate_hooks).toBeUndefined();
  });

  it("a check runs as argv, no shell, with the worker's tool env only: no credential from the process env", async () => {
    const before = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = ["gh", "p_", "x".repeat(20)].join("");
    try {
      const f = await packPipeline([check("ba", "before_agent")], { toolEnv: { PATH: "/usr/bin:/bin", HOME: "/tmp/h" } });
      await f.submit();
      await f.step();
      expect(f.checkRuns).toEqual([{ argv: ["ba", "--flag"], env: { PATH: "/usr/bin:/bin", HOME: "/tmp/h" } }]);
      expect(Object.keys(f.checkRuns[0]!.env)).not.toContain("GITHUB_TOKEN");
    } finally {
      if (before === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = before;
    }
  });

  it("a before_agent refusal fails the run before the agent starts, naming the check; the refusal is audited", async () => {
    const f = await packPipeline([check("ba", "before_agent")]);
    f.refuse.ba = Infinity;
    const item = await f.submit();
    await f.step();
    const [run] = await f.runs(item, "implement");
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: HOOK_REFUSED });
    expect((run!.outcome as { detail: string }).detail).toContain("pack check ba refused at before_agent: exited 1: ba says no");
    expect(implementSpecs(f)).toEqual([]);
    const rows = await f.audit.forSubject(run!.id);
    expect(rows.map((r) => [r.hook, r.point, r.outcome, r.text])).toEqual([["ba", "before_agent", "veto", "exited 1: ba says no"]]);
    expect(rows[0]).toMatchObject({ project_id: item.project, passport_id: null });
  });

  it("an after_agent refusal fails the run after the agent step, before any gate", async () => {
    const f = await packPipeline([check("aa", "after_agent")]);
    f.refuse.aa = Infinity;
    const item = await f.submit();
    await f.step();
    const [run] = await f.runs(item, "implement");
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: HOOK_REFUSED });
    expect(implementSpecs(f)).toHaveLength(1);
    expect(f.order).not.toContain("npm test");
  });

  it("a before_finish refusal sends the agent back with the check's reason; once the check passes the run goes on", async () => {
    const f = await packPipeline([check("bf", "before_finish")]);
    f.refuse.bf = 2;
    const item = await f.submit();
    await f.step();
    const [run] = await f.runs(item, "implement");
    expect(run!.outcome?.status).toBe("succeeded");
    const [, ...fixes] = implementSpecs(f);
    expect(fixes).toHaveLength(2);
    expect(fixes[0]!.prompt).toContain("## A pack check refused before push");
    expect(fixes[0]!.prompt).toContain("bf says no");
    expect(fixes[0]!.gate_hooks).toBeDefined();
    expect((await f.audit.forSubject(run!.id)).map((r) => r.outcome)).toEqual(["veto", "veto"]);
  });

  it("past the check's retries the run fails, naming the check", async () => {
    const f = await packPipeline([check("bf", "before_finish", 1)]);
    f.refuse.bf = Infinity;
    const item = await f.submit();
    await f.step();
    const [run] = await f.runs(item, "implement");
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: HOOK_REFUSED });
    expect((run!.outcome as { detail: string }).detail).toContain("pack check bf refused at before_finish");
    // One send-back (retries 1), then the second refusal fails the run: nothing is pushed.
    expect(implementSpecs(f)).toHaveLength(2);
    expect(f.order).not.toContain("npm test");
  });

  it("a before_finish check that passes skips no gate: the check list, the scope gate and the size gate still fail the run", async () => {
    const failing = await packPipeline(ALL);
    failing.sandbox.exits["npm test"] = 1;
    const a = await failing.submit();
    await failing.step();
    expect((await failing.runs(a, "implement"))[0]!.outcome).toMatchObject({ status: "failed", error_code: "checks_failed" });

    const scope = await packPipeline(ALL);
    scope.sandbox.changedFiles = ["src/outside.ts"];
    const b = await scope.submit();
    await scope.step();
    expect((await scope.runs(b, "implement"))[0]!.outcome).toMatchObject({ status: "failed", error_code: "scope_violation" });

    const size = await packPipeline(ALL);
    size.sandbox.changedFiles = [".github/workflows/a.yml"];
    size.sandbox.numstat = "9999999\t0\t.github/workflows/a.yml\0";
    const c = await size.submit();
    await size.step();
    expect((await size.runs(c, "implement"))[0]!.outcome).toMatchObject({ status: "failed", error_code: "diff_too_large" });
  });
});
