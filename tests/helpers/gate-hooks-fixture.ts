import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunKind } from "../../src/core/types.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import { ClaudeCodeRunner } from "../../src/impl/runner/claude-code-runner.js";
import { GATE_HOOKS_DIR, gateAnswerer } from "../../src/impl/runner/gate-hooks.js";
import type { AgentRunResult, AgentRunSpec, GateHooks } from "../../src/interfaces/agent-runner.js";
import agentStopCheck from "../../src/worker/settings/agent-stop-check-ms.setting.js";
import type { ExecOptions, ExecResult, Sandbox, SandboxHandle } from "../../src/interfaces/sandbox.js";
import type { SecretName, SecretStore } from "../../src/interfaces/secret-store.js";

// The gate hooks (design §4 Pre-push gates, issue #302): a fake `claude` reads the --settings the runner passes and
// runs the hook commands it finds there, as Claude Code would, against a fake git and fake check commands.

export const BIN = "fake-claude";
// Secret values are built at runtime from parts, never written whole.
export const TOKEN = ["oauth", "-", "z".repeat(24)].join("");
export const OTHER = ["other", "-", "q".repeat(20)].join("");
export const secrets: SecretStore = {
  get: async (n: SecretName) => (String(n) === "CLAUDE_CODE_OAUTH_TOKEN" ? { name: n, reveal: () => TOKEN } as never : null),
  valuesForScan: async () => [TOKEN, OTHER],
};
export const scanner = new PatternEgressScanner(() => secrets.valuesForScan());
/** Whether this host lets a test listen on a Unix socket (some sandboxes refuse it): the hook script needs one. */
export const canListen = await new Promise<boolean>((resolve) => {
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
export const MODES = canListen ? (["hooks", "direct"] as const) : (["direct"] as const);
type Mode = (typeof MODES)[number];

const RESULT = `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", usage: {} })}\n`;

export interface HookCall {
  out: string;
  code: number | null;
}

/**
 * Runs one hook command as Claude Code does: a shell line, the event JSON on stdin. Its timeout kills the whole
 * process group: a shell that does not exec its command (dash) would leave the node hook holding stdout open.
 */
export function runHook(command: string, input: unknown, timeoutMs = 20_000): Promise<HookCall> {
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

export interface Hooks {
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
  /** What test selection reads: the changed files, the tracked files and `git grep`'s import lines (each `path\0line`). */
  changed: string[] = [];
  tracked: string[] = [];
  imports: string[] = [];
  /** Check commands by argv joined with spaces: exit code, output and how long it takes. Default: pass at once. */
  checks: Record<string, { exit: number; out: string; ms?: number }> = {};
  /** Every non-claude command, in order. */
  commands: string[] = [];
  /** The commands stopped by their abort signal: the real sandboxes kill the whole process group then. */
  killed: string[] = [];
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
      // The real sandboxes kill the CLI on its signal or its timeout; the fake agent is left behind.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ended = new Promise<ExecResult>((resolve) => {
        const killed = (timed_out: boolean): ExecResult => ({ exit_code: null, signal: "SIGTERM", stdout: "", stderr: "", timed_out });
        o.signal?.addEventListener("abort", () => resolve(killed(false)), { once: true });
        if (o.timeout_ms) timer = setTimeout(() => resolve(killed(true)), o.timeout_ms);
      });
      const agent = this.agent({
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
      }).then(() => res(0, RESULT));
      try {
        return await Promise.race([agent, ended]);
      } finally {
        clearTimeout(timer);
      }
    }
    const line = cmd.join(" ");
    this.commands.push(line);
    if (cmd[0] === "git") {
      if (this.gitThrows) throw new Error("git is not there");
      const args = cmd.slice(1).join(" ");
      if (args.startsWith("rev-list")) return res(0, this.revLists[args] ?? "");
      if (args.startsWith("diff --numstat")) return res(0, this.numstat);
      if (args.startsWith("diff --name-only")) return res(0, this.changed.map((p) => `${p}\0`).join(""));
      if (args.startsWith("ls-files")) return res(0, this.tracked.map((p) => `${p}\0`).join(""));
      if (args.startsWith("grep")) return res(this.imports.length > 0 ? 0 : 1, this.imports.join("\n"));
      return res(0, "");
    }
    if (o.signal?.aborted) return res(1);
    const c = this.checks[line] ?? { exit: 0, out: "" };
    if (c.ms) {
      const aborted = await new Promise<boolean>((r) => {
        const t = setTimeout(() => r(false), c.ms);
        o.signal?.addEventListener("abort", () => (clearTimeout(t), r(true)), { once: true });
      });
      if (aborted) {
        this.killed.push(line);
        return { exit_code: null, signal: "SIGTERM", stdout: "", stderr: "", timed_out: false };
      }
    }
    return res(c.exit, c.out);
  }
}

export const GATES: GateHooks = {
  allowed_paths: ["src/a.ts", "docs/"],
  start_sha: "start",
  base_sha: "base",
  limits: { max_diff_lines: 100, max_diff_files: 5 },
  check_commands: [["npm", "run", "typecheck"], ["npm", "test"]],
  check_env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  stop_checks: 3,
  stop_blocks_used: 0,
};

export function setup(role: RunKind = "implement", gates: GateHooks | null = GATES, stopCheckMs?: number) {
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
    ...(stopCheckMs === undefined ? {} : { stop_check_ms: stopCheckMs }),
  };
  return { root, workdir, configDir, sandbox, runner, spec };
}

/** Runs the fake agent in `mode`: through the runner and its hooks, or straight against the answerer. */
export async function drive(f: ReturnType<typeof setup>, mode: Mode): Promise<Pick<AgentRunResult, "status" | "gate_blocks" | "stop_selections">> {
  if (mode === "hooks") return f.runner.run(f.spec);
  const dir = join(f.configDir, GATE_HOOKS_DIR, f.spec.run_id);
  mkdirSync(dir, { recursive: true });
  const answers = await gateAnswerer({ dir, spec: { ...f.spec, gate_hooks: f.spec.gate_hooks!, stop_check_ms: f.spec.stop_check_ms ?? agentStopCheck.default! }, sandbox: f.sandbox, scanner, after }, f.spec.signal);
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
  const selections = answers.selections();
  rmSync(dir, { recursive: true, force: true });
  return { status: "completed", ...(blocks.length > 0 ? { gate_blocks: blocks } : {}), ...(selections.length > 0 ? { stop_selections: selections } : {}) };
}

/** An agent that stops until it is allowed to, at most `max` times, and keeps every block reason. */
export const stopper = (reasons: string[], max = 10) => async (a: Agent) => {
  for (let i = 0; i < max; i++) {
    const why = await a.stop();
    if (why === null) return;
    reasons.push(why);
  }
};

/** A real timer for the hooks, as the runner gives them. */
export function after(ms: number, fn: () => void): () => void {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
}

/** The answerer the hook host uses, with the Stop check's limit, in a fresh hook folder. */
export async function answerer(f: ReturnType<typeof setup>, stopCheckMs: number) {
  const dir = join(f.configDir, GATE_HOOKS_DIR, f.spec.run_id);
  mkdirSync(dir, { recursive: true });
  return gateAnswerer({ dir, spec: { ...f.spec, stop_check_ms: stopCheckMs, gate_hooks: f.spec.gate_hooks! }, sandbox: f.sandbox, scanner, after }, f.spec.signal);
}

/** The hook settings the runner passes, read from the fake claude's --settings (no hook is run). */
export async function hookSettings(f: ReturnType<typeof setup>): Promise<Hooks> {
  let hooks: Hooks | undefined;
  f.sandbox.agent = async (a) => void (hooks = a.hooks);
  await f.runner.run(f.spec);
  if (!hooks) throw new Error("no hooks in --settings");
  return hooks;
}
