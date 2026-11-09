import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCovered } from "../src/core/policy.js";
import { sizeDetail } from "../src/core/diff-gate.js";
import { NO_COMMITS_DETAIL } from "../src/worker/index.js";
import type { RunKind } from "../src/core/types.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { ClaudeCodeRunner, buildClaudeArgs } from "../src/impl/runner/claude-code-runner.js";
import { GATE_HOOKS_DIR, HOOK_SCRIPT, HOOK_SPEC, PATH_REFUSAL, editCovered, gateAnswerer, hookScript, specFile } from "../src/impl/runner/gate-hooks.js";
import type { AgentRunResult, AgentRunSpec, GateHooks } from "../src/interfaces/agent-runner.js";
import type { ExecOptions, ExecResult, Sandbox, SandboxHandle } from "../src/interfaces/sandbox.js";
import type { SecretName, SecretStore } from "../src/interfaces/secret-store.js";

// The gate hooks (design §4 Pre-push gates, issue #302): a fake `claude` reads the --settings the runner passes and
// runs the hook commands it finds there, as Claude Code would, against a fake git and fake check commands.

const BIN = "fake-claude";
// Secret values are built at runtime from parts, never written whole.
const TOKEN = ["oauth", "-", "z".repeat(24)].join("");
const OTHER = ["other", "-", "q".repeat(20)].join("");
const secrets: SecretStore = {
  get: async (n: SecretName) => (String(n) === "CLAUDE_CODE_OAUTH_TOKEN" ? { name: n, reveal: () => TOKEN } as never : null),
  valuesForScan: async () => [TOKEN, OTHER],
};
const scanner = new PatternEgressScanner(() => secrets.valuesForScan());
/** Whether this host lets a test listen on a Unix socket (some sandboxes refuse it): the hook script needs one. */
const canListen = await new Promise<boolean>((resolve) => {
  const dir = mkdtempSync(join(tmpdir(), "sf-listen-"));
  const server = createServer();
  const done = (ok: boolean) => {
    rmSync(dir, { recursive: true, force: true });
    resolve(ok);
  };
  server.once("error", () => done(false));
  server.listen(join(dir, "s"), () => server.close(() => done(true)));
});

/**
 * How a test drives the hooks: `hooks` runs the real runner, whose fake claude runs the hook commands from
 * --settings (needs a Unix socket); `direct` asks the same answerer the hook host uses, with no socket.
 */
const MODES = canListen ? (["hooks", "direct"] as const) : (["direct"] as const);
type Mode = (typeof MODES)[number];

const RESULT = `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", usage: {} })}\n`;

interface HookCall {
  out: string;
  code: number | null;
}

/**
 * Runs one hook command as Claude Code does: a shell line, the event JSON on stdin. Its timeout kills the whole
 * process group: a shell that does not exec its command (dash) would leave the node hook holding stdout open.
 */
function runHook(command: string, input: unknown, timeoutMs = 20_000): Promise<HookCall> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ out, code });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

interface Hooks {
  PreToolUse?: { matcher: string; hooks: { command: string; timeout: number }[] }[];
  Stop?: { hooks: { command: string; timeout: number }[] }[];
}

/** What the fake agent can do: its settings, a tool call through PreToolUse, and a stop through Stop. */
interface Agent {
  args: readonly string[];
  hooks: Hooks | undefined;
  workdir: string;
  /** Edit or Write `path`: the PreToolUse hook first; written only when not denied. Returns the deny reason, if any. */
  write(tool: "Edit" | "Write", path: string): Promise<string | null>;
  /** Tries to stop; returns the block reason, or null when the stop is allowed. */
  stop(): Promise<string | null>;
}

class GateSandbox implements Sandbox {
  async updateBase(): Promise<string> {
    return "base";
  }
  /** `git rev-list` output by argument line; default: none. */
  revLists: Record<string, string> = {};
  numstat = "";
  /** Check commands by argv joined with spaces: exit code, output and how long it takes. Default: pass at once. */
  checks: Record<string, { exit: number; out: string; ms?: number }> = {};
  /** Every non-claude command, in order. */
  commands: string[] = [];
  gitThrows = false;
  agent: (a: Agent) => Promise<void> = async () => {};
  claudeArgs: string[] = [];

  async create(): Promise<SandboxHandle> {
    throw new Error("unused");
  }
  async destroy(): Promise<void> {}
  async copyIn(): Promise<void> {}
  async copyOut(): Promise<void> {}
  async exec(h: SandboxHandle, cmd: readonly string[], o: ExecOptions): Promise<ExecResult> {
    const res = (exit_code: number, stdout = ""): ExecResult => ({ exit_code, signal: null, stdout, stderr: "", timed_out: false });
    if (cmd[0] === BIN) {
      this.claudeArgs = [...cmd];
      const settings = JSON.parse(cmd[cmd.indexOf("--settings") + 1]!) as { hooks?: Hooks };
      const hooks = settings.hooks;
      await this.agent({
        args: cmd,
        hooks,
        workdir: h.workdir,
        write: async (tool, path) => {
          const hook = hooks?.PreToolUse?.find((m) => new RegExp(`^(${m.matcher})$`).test(tool))?.hooks[0];
          if (hook) {
            const r = await runHook(hook.command, { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: path, content: "x" }, cwd: h.workdir });
            const reply = r.out ? (JSON.parse(r.out) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }) : {};
            if (reply.hookSpecificOutput?.permissionDecision === "deny") return reply.hookSpecificOutput.permissionDecisionReason ?? "denied";
          }
          mkdirSync(join(path, ".."), { recursive: true });
          await writeFile(path, "x");
          return null;
        },
        stop: async () => {
          const hook = hooks?.Stop?.[0]?.hooks[0];
          if (!hook) return null;
          const r = await runHook(hook.command, { hook_event_name: "Stop", stop_hook_active: false });
          const reply = r.out ? (JSON.parse(r.out) as { decision?: string; reason?: string }) : {};
          return reply.decision === "block" ? reply.reason ?? "blocked" : null;
        },
      });
      return res(0, RESULT);
    }
    const line = cmd.join(" ");
    this.commands.push(line);
    if (cmd[0] === "git") {
      if (this.gitThrows) throw new Error("git is not there");
      const args = cmd.slice(1).join(" ");
      if (args.startsWith("rev-list")) return res(0, this.revLists[args] ?? "");
      if (args.startsWith("diff --numstat")) return res(0, this.numstat);
      return res(0, "");
    }
    if (o.signal?.aborted) return res(1);
    const c = this.checks[line] ?? { exit: 0, out: "" };
    if (c.ms) await new Promise((r) => setTimeout(r, c.ms));
    return res(c.exit, c.out);
  }
}

const GATES: GateHooks = {
  allowed_paths: ["src/a.ts", "docs/"],
  start_sha: "start",
  base_sha: "base",
  limits: { max_diff_lines: 100, max_diff_files: 5 },
  check_commands: [["npm", "run", "typecheck"], ["npm", "test"]],
  check_env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  stop_checks: 3,
  stop_blocks_used: 0,
};

function setup(role: RunKind = "implement", gates: GateHooks | null = GATES) {
  const root = mkdtempSync(join(tmpdir(), "sf-gates-"));
  const workdir = join(root, "work");
  mkdirSync(workdir);
  const configDir = join(root, "claude-config");
  const sandbox = new GateSandbox();
  // One commit since the start, a small diff: every stop check passes unless a test changes it.
  sandbox.revLists["rev-list --reverse start..HEAD"] = "c1\n";
  sandbox.numstat = "1\t0\tsrc/a.ts\0";
  const runner = new ClaudeCodeRunner({
    sandbox,
    secrets,
    claudeConfigDir: configDir,
    homesDir: join(root, "homes"),
    models: { cheap: "c", standard: "s", strong: "x" },
    claudeBin: BIN,
    tools: { broker: { listTools: () => [], call: async () => ({ ok: true, content: null }) } as never, scanner },
  });
  const spec: AgentRunSpec = {
    run_id: "run_1" as AgentRunSpec["run_id"],
    work_item_id: "wi_1" as AgentRunSpec["work_item_id"],
    role,
    sandbox: { id: "sbx", workdir },
    system_prompt: "s",
    prompt: "p",
    tools: [],
    tool_grants: [],
    lease_token: 1,
    env_allowlist: {},
    deny_paths: [],
    writable_paths: [],
    model_class: "standard",
    timeout_ms: 60_000,
    signal: new AbortController().signal,
    ...(gates ? { gate_hooks: gates } : {}),
  };
  return { root, workdir, configDir, sandbox, runner, spec };
}

/** Runs the fake agent in `mode`: through the runner and its hooks, or straight against the answerer. */
async function drive(f: ReturnType<typeof setup>, mode: Mode): Promise<Pick<AgentRunResult, "status" | "gate_blocks">> {
  if (mode === "hooks") return f.runner.run(f.spec);
  const dir = join(f.configDir, GATE_HOOKS_DIR, f.spec.run_id);
  mkdirSync(dir, { recursive: true });
  const answers = await gateAnswerer({ dir, spec: { ...f.spec, gate_hooks: f.spec.gate_hooks! }, sandbox: f.sandbox, scanner }, f.spec.signal);
  const ask = async (req: unknown) => {
    const a = await answers.answer(req);
    if (a) await answers.sent(a);
    return a?.output as Record<string, never> | undefined;
  };
  await f.sandbox.agent({
    args: [],
    hooks: undefined,
    workdir: f.workdir,
    write: async (tool, path) => {
      const out = (await ask({ event: "pre_tool_use", tool_name: tool, file_path: path })) as { hookSpecificOutput?: { permissionDecisionReason: string } } | undefined;
      if (out?.hookSpecificOutput) return out.hookSpecificOutput.permissionDecisionReason;
      mkdirSync(join(path, ".."), { recursive: true });
      await writeFile(path, "x");
      return null;
    },
    stop: async () => ((await ask({ event: "stop" })) as { reason?: string } | undefined)?.reason ?? null,
  });
  const blocks = await answers.blocks();
  rmSync(dir, { recursive: true, force: true });
  return { status: "completed", ...(blocks.length > 0 ? { gate_blocks: blocks } : {}) };
}

/** An agent that stops until it is allowed to, at most `max` times, and keeps every block reason. */
const stopper = (reasons: string[], max = 10) => async (a: Agent) => {
  for (let i = 0; i < max; i++) {
    const why = await a.stop();
    if (why === null) return;
    reasons.push(why);
  }
};

for (const mode of MODES) describe(`gate hooks: PreToolUse on Edit and Write (${mode})`, () => {
  it("refuses an edit outside allowed_paths, naming them and the spec; the file is not written", async () => {
    const f = setup();
    let refusal: string | null = null;
    f.sandbox.agent = async (a) => {
      refusal = await a.write("Edit", join(a.workdir, "src", "other.ts"));
    };
    const result = await drive(f, mode);
    expect(result.status).toBe("completed");
    expect(existsSync(join(f.workdir, "src", "other.ts"))).toBe(false);
    expect(refusal).toContain(PATH_REFUSAL);
    expect(refusal).toContain("src/a.ts, docs/");
    expect(refusal).toContain("add it to the spec");
    expect(refusal).not.toContain("/approve");
    expect(result.gate_blocks).toEqual([{ hook: "pre_tool_use", check: "allowed_paths", attempt: 1 }]);
  });

  it("refuses a Write outside the workdir", async () => {
    const f = setup();
    let refusal: string | null = null;
    f.sandbox.agent = async (a) => {
      refusal = await a.write("Write", join(f.root, "outside.txt"));
    };
    await drive(f, mode);
    expect(refusal).toContain(PATH_REFUSAL);
    expect(existsSync(join(f.root, "outside.txt"))).toBe(false);
  });

  it("does not refuse an Edit or Write inside allowed_paths: an exact path, or under an entry ending in /", async () => {
    const f = setup();
    const refusals: (string | null)[] = [];
    f.sandbox.agent = async (a) => {
      refusals.push(await a.write("Edit", join(a.workdir, "src", "a.ts")));
      refusals.push(await a.write("Write", join(a.workdir, "docs", "deep", "b.md")));
    };
    const result = await drive(f, mode);
    expect(refusals).toEqual([null, null]);
    expect(existsSync(join(f.workdir, "docs", "deep", "b.md"))).toBe(true);
    expect(result.gate_blocks).toBeUndefined();
  });

});

for (const mode of MODES) describe(`gate hooks: Stop (${mode})`, () => {
  it("sends a stop with no commits since the start back with the no-commit reason; the base fallback counts", async () => {
    const f = setup();
    f.sandbox.revLists = {};
    const reasons: string[] = [];
    f.sandbox.agent = async (a) => {
      reasons.push((await a.stop())!);
      // An earlier run's work on the branch (#261): commits since the base, merges left out.
      f.sandbox.revLists["rev-list --reverse --no-merges base..HEAD"] = "earlier\n";
      reasons.push((await a.stop()) ?? "allowed");
    };
    const result = await drive(f, mode);
    expect(reasons[0]).toContain(NO_COMMITS_DETAIL);
    expect(reasons[0]).toContain("no_commits");
    expect(reasons[1]).toBe("allowed");
    expect(f.sandbox.commands.filter((c) => c.startsWith("git rev-list"))).toEqual([
      "git rev-list --reverse start..HEAD", "git rev-list --reverse --no-merges base..HEAD",
      "git rev-list --reverse start..HEAD", "git rev-list --reverse --no-merges base..HEAD",
    ]);
    expect(result.gate_blocks).toEqual([{ hook: "stop", check: "no_commits", attempt: 1 }]);
  });

  it("sends a stop with a failing check back with its name and output tail; checks run in order and stop at the first failure", async () => {
    const f = setup();
    f.sandbox.checks["npm run typecheck"] = { exit: 2, out: `${"noise\n".repeat(1000)}src/a.ts(3,1): error TS2304` };
    const reasons: string[] = [];
    f.sandbox.agent = async (a) => {
      reasons.push((await a.stop())!);
    };
    const result = await drive(f, mode);
    expect(reasons[0]).toContain("`npm run typecheck` failed (exited 2)");
    expect(reasons[0]).toContain("error TS2304");
    expect(reasons[0]!.length).toBeLessThan(2600);
    expect(f.sandbox.commands.filter((c) => c.startsWith("npm"))).toEqual(["npm run typecheck"]);
    expect(result.gate_blocks).toEqual([{ hook: "stop", check: "npm run typecheck", attempt: 1 }]);
  });

  it("runs the checks in order and names the second when only it fails", async () => {
    const f = setup();
    f.sandbox.checks["npm test"] = { exit: 1, out: "FAIL tests/x.test.ts" };
    const reasons: string[] = [];
    f.sandbox.agent = async (a) => void reasons.push((await a.stop())!);
    await drive(f, mode);
    expect(f.sandbox.commands.filter((c) => c.startsWith("npm"))).toEqual(["npm run typecheck", "npm test"]);
    expect(reasons[0]).toContain("`npm test` failed (exited 1)");
  });

  it("withholds a flagged output tail whole", async () => {
    const f = setup();
    const token = ["gh", "p_", "x".repeat(36)].join("");
    f.sandbox.checks["npm run typecheck"] = { exit: 1, out: `sentinel-head ${token} after` };
    const reasons: string[] = [];
    f.sandbox.agent = async (a) => void reasons.push((await a.stop())!);
    await drive(f, mode);
    expect(reasons[0]).toContain("withheld");
    expect(reasons[0]).not.toContain(token);
    expect(reasons[0]).not.toContain("sentinel-head");
  });

  it("sends a diff over max_diff_lines or max_diff_files back with the size gate's own wording", async () => {
    const f = setup();
    f.sandbox.numstat = "101\t0\tsrc/a.ts\0";
    const reasons: string[] = [];
    f.sandbox.agent = async (a) => {
      reasons.push((await a.stop())!);
      f.sandbox.numstat = Array.from({ length: 6 }, (_, i) => `1\t0\tdocs/f${i}.md\0`).join("");
      reasons.push((await a.stop())!);
    };
    const result = await drive(f, mode);
    expect(reasons[0]).toContain(sizeDetail({ lines: 101, files: 1 }, GATES.limits));
    expect(reasons[1]).toContain(sizeDetail({ lines: 6, files: 6 }, GATES.limits));
    // No check runs on an over-size diff.
    expect(f.sandbox.commands.some((c) => c.startsWith("npm"))).toBe(false);
    expect(result.gate_blocks?.map((b) => [b.check, b.attempt])).toEqual([["diff_too_large", 1], ["diff_too_large", 2]]);
  });

  it("blocks at most stop_checks times, then allows the next stop: no loop", async () => {
    const f = setup();
    f.sandbox.revLists = {};
    const reasons: string[] = [];
    f.sandbox.agent = stopper(reasons);
    const result = await drive(f, mode);
    expect(reasons).toHaveLength(3);
    expect(reasons[2]).toContain("stop check 3 of 3");
    expect(result.gate_blocks?.map((b) => b.attempt)).toEqual([1, 2, 3]);
  });

  it("counts the blocks earlier steps used against the cap", async () => {
    const f = setup("implement", { ...GATES, stop_checks: 3, stop_blocks_used: 2 });
    f.sandbox.revLists = {};
    const reasons: string[] = [];
    f.sandbox.agent = stopper(reasons);
    const result = await drive(f, mode);
    expect(reasons).toHaveLength(1);
    expect(result.gate_blocks).toEqual([{ hook: "stop", check: "no_commits", attempt: 3 }]);
  });

  it("allows the stop when every check passes", async () => {
    const f = setup();
    const reasons: string[] = [];
    f.sandbox.agent = stopper(reasons);
    const result = await drive(f, mode);
    expect(reasons).toEqual([]);
    expect(result.gate_blocks).toBeUndefined();
    expect(f.sandbox.commands.filter((c) => c.startsWith("npm"))).toEqual(["npm run typecheck", "npm test"]);
  });
});

describe.runIf(canListen)("gate hooks: Stop and the stall clock", () => {
  it("a Stop check that runs longer than stall_ms is not a stall: the run completes", async () => {
    const f = setup();
    f.spec = { ...f.spec, stall_ms: 100, first_output_ms: 100 };
    f.sandbox.checks["npm test"] = { exit: 0, out: "", ms: 600 };
    const reasons: string[] = [];
    f.sandbox.agent = stopper(reasons);
    const result = await f.runner.run(f.spec);
    expect(reasons).toEqual([]);
    expect(result.status).toBe("completed");
  });
});

for (const mode of MODES) describe(`gate hooks: failures never block (${mode})`, () => {
  it("a host that cannot run its checks allows the stop, and the run completes", async () => {
    const f = setup();
    f.sandbox.gitThrows = true;
    const reasons: string[] = [];
    f.sandbox.agent = stopper(reasons);
    const result = await drive(f, mode);
    expect(reasons).toEqual([]);
    expect(result.status).toBe("completed");
  });

});

describe("gate hooks: coverage rule", () => {
  it("uses the scope gate's coverage rule: editCovered agrees with isCovered on every path", () => {
    const allowed = ["src/a.ts", "docs/", "lib", "x/y/"];
    const paths = ["src/a.ts", "src/a.tsx", "src/a.ts/b", "docs/x.md", "docs", "docsx/a", "lib", "lib/z.ts", "x/y/z", "x/y", "x/yz", "a/../src/a.ts"];
    for (const p of paths) {
      const normal = join("/w", p).slice("/w/".length);
      expect(editCovered(join("/w", p), ["/w"], allowed), p).toBe(isCovered(normal, allowed));
      expect(editCovered(p, ["/w"], allowed), p).toBe(isCovered(normal, allowed));
    }
    expect(editCovered("/elsewhere/src/a.ts", ["/w"], allowed)).toBe(false);
    expect(editCovered("/w", ["/w"], ["/"])).toBe(false);
  });
});

describe("gate hooks: failures never block (host)", () => {
  it("a hook host that cannot start runs the step without hooks, and the run completes", async () => {
    const f = setup();
    mkdirSync(f.configDir, { recursive: true });
    // A file where the hook folder's parent should be: the host cannot make its folder.
    writeFileSync(join(f.configDir, GATE_HOOKS_DIR), "");
    const result = await f.runner.run(f.spec);
    expect(result.status).toBe("completed");
    expect(result.gate_blocks).toBeUndefined();
    expect(f.sandbox.claudeArgs).toEqual(buildClaudeArgs(f.spec, "s", BIN));
  });
});

describe("gate hooks: failures never block (hook script)", () => {
  it.skipIf(!canListen)("a hook that cannot reach its host, crashes or is killed for its timeout allows and fails nothing", async () => {
    const f = setup();
    const calls: HookCall[] = [];
    f.sandbox.agent = async (a) => {
      const pre = a.hooks!.PreToolUse![0]!.hooks[0]!.command;
      const stop = a.hooks!.Stop![0]!.hooks[0]!.command;
      // Not JSON on stdin: the script answers nothing.
      calls.push(await runHook(pre, "not json"));
      // Killed for its timeout while the host runs a slow check.
      f.sandbox.checks["npm run typecheck"] = { exit: 1, out: "" };
      const slow = f.sandbox.exec.bind(f.sandbox);
      f.sandbox.exec = async (h, cmd, o) => (cmd[0] === "npm" ? new Promise(() => {}) : slow(h, cmd, o));
      calls.push(await runHook(stop, {}, 300));
      f.sandbox.exec = slow;
      // The spec file names a socket that is gone.
      const dir = join(f.configDir, GATE_HOOKS_DIR, "run_1");
      const spec = JSON.parse(readFileSync(join(dir, HOOK_SPEC), "utf8")) as { socket: string };
      await writeFile(join(dir, HOOK_SPEC), JSON.stringify({ ...spec, socket: join(f.root, "gone") }));
      calls.push(await runHook(stop, {}));
      calls.push(await runHook(pre, { tool_name: "Edit", tool_input: { file_path: "/elsewhere" } }));
    };
    const result = await f.runner.run(f.spec);
    expect(calls.map((c) => c.out)).toEqual(["", "", "", ""]);
    expect(calls[0]!.code).toBe(0);
    expect(calls[2]!.code).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.gate_blocks).toBeUndefined();
  });
});

describe("gate hooks: files", () => {
  it("the spec file and the script hold no secret value and no env; the spec file has what the hooks check", async () => {
    const f = setup();
    const spec = JSON.stringify(specFile({ ...f.spec, gate_hooks: { ...GATES, check_env: { ...GATES.check_env, X: OTHER } } }, "/tmp/s"));
    const script = hookScript();
    for (const value of await secrets.valuesForScan()) {
      expect(spec).not.toContain(value);
      expect(script).not.toContain(value);
    }
    expect(spec).not.toContain("check_env");
    expect(JSON.parse(spec)).toMatchObject({
      socket: "/tmp/s", allowed_paths: GATES.allowed_paths, start_sha: "start", base_sha: "base", limits: GATES.limits,
      check_commands: GATES.check_commands, stop_checks: 3, stop_blocks_used: 0,
    });
    expect((await scanner.scan("log", spec + script)).clean).toBe(true);
  });

  it("the script alone: with no host to reach, or input it cannot read, it prints nothing and exits 0", async () => {
    const f = setup();
    const dir = join(f.configDir, GATE_HOOKS_DIR, "run_1");
    mkdirSync(dir, { recursive: true });
    await writeFile(join(dir, HOOK_SCRIPT), hookScript());
    await writeFile(join(dir, HOOK_SPEC), JSON.stringify({ socket: join(f.root, "gone") }));
    const cmd = `'${process.execPath}' '${join(dir, HOOK_SCRIPT)}'`;
    expect(await runHook(`${cmd} stop`, {})).toEqual({ out: "", code: 0 });
    expect(await runHook(`${cmd} pre_tool_use`, "not json")).toEqual({ out: "", code: 0 });
    await writeFile(join(dir, HOOK_SPEC), "{");
    expect(await runHook(`${cmd} stop`, {})).toEqual({ out: "", code: 0 });
  });

  it.skipIf(!canListen)("the script and spec file sit in the run's folder in the harness config dir, outside the workdir; no secret value in them; removed after", async () => {
    const f = setup();
    let seen: { files: string[]; spec: string; script: string; command: string } | null = null;
    f.sandbox.agent = async (a) => {
      const dir = join(f.configDir, GATE_HOOKS_DIR, "run_1");
      seen = {
        files: readdirSync(dir).sort(),
        spec: readFileSync(join(dir, HOOK_SPEC), "utf8"),
        script: readFileSync(join(dir, HOOK_SCRIPT), "utf8"),
        command: a.hooks!.Stop![0]!.hooks[0]!.command,
      };
    };
    await f.runner.run(f.spec);
    expect(seen!.files).toEqual([HOOK_SCRIPT, HOOK_SPEC]);
    expect(seen!.command).toContain(join(f.configDir, GATE_HOOKS_DIR, "run_1", HOOK_SCRIPT));
    expect(seen!.command.startsWith(f.workdir)).toBe(false);
    expect(join(f.configDir).startsWith(f.workdir)).toBe(false);
    for (const value of await secrets.valuesForScan()) {
      expect(seen!.spec).not.toContain(value);
      expect(seen!.script).not.toContain(value);
    }
    // The spec file has what the hooks check, not the check env.
    expect(JSON.parse(seen!.spec)).toMatchObject({ allowed_paths: GATES.allowed_paths, start_sha: "start", base_sha: "base", stop_checks: 3 });
    expect(seen!.spec).not.toContain("PATH");
    expect((await scanner.scan("log", seen!.spec + seen!.script)).clean).toBe(true);
    expect(existsSync(join(f.configDir, GATE_HOOKS_DIR, "run_1"))).toBe(false);
  });
});

describe("gate hooks: other steps get neither hook", () => {
  for (const role of ["triage", "review", "resolve", "update"] as const) {
    it(`${role}: the runner's arguments are those without hooks, even when the spec names some`, async () => {
      const f = setup(role);
      await f.runner.run(f.spec);
      expect(f.sandbox.claudeArgs).toEqual(buildClaudeArgs(f.spec, "s", BIN));
      expect(f.sandbox.claudeArgs.join(" ")).not.toContain('"hooks"');
    });
  }

  it("an implement step without gate_hooks (the merge-conflict step): arguments unchanged, no hook folder", async () => {
    const f = setup("implement", null);
    let made = true;
    f.sandbox.agent = async () => void (made = existsSync(join(f.configDir, GATE_HOOKS_DIR)));
    await f.runner.run(f.spec);
    expect(f.sandbox.claudeArgs).toEqual(buildClaudeArgs(f.spec, "s", BIN));
    expect(made).toBe(false);
  });

  it.skipIf(!canListen)("an implement step with gate_hooks gets both hooks in --settings, the rest of the settings unchanged", async () => {
    const f = setup();
    let args: readonly string[] = [];
    f.sandbox.agent = async (a) => void (args = a.args);
    await f.runner.run(f.spec);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as Record<string, unknown> & { hooks: Hooks };
    expect(settings.hooks.PreToolUse![0]!.matcher).toBe("Edit|Write");
    expect(settings.hooks.Stop).toHaveLength(1);
    const { hooks: _hooks, ...rest } = settings;
    const plain = buildClaudeArgs(f.spec, "s", BIN);
    expect(rest).toEqual(JSON.parse(plain[plain.indexOf("--settings") + 1]!));
    expect(args.filter((_, i) => args[i - 1] !== "--settings")).toEqual(plain.filter((_, i) => plain[i - 1] !== "--settings"));
  });
});
