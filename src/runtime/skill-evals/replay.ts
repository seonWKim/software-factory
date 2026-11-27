// The replay primitive the golden replay (src/golden.ts) and the skill-eval replay share: one agent run in a fresh,
// detached sandbox (`branch: null`), destroyed after, with no session, no doc index and no writable path. Tools,
// broker tool grants and MCP servers are none unless the caller names them (a golden replay gives its role's tools).
// A caller may prepare the sandbox before the agent starts: the skill-eval replay cleans it (cleanSkillSandbox).
//
// The sandbox and runner types are structural, the shape of the Sandbox and AgentRunner interfaces' calls used here,
// so this component imports no legacy module (tests/architecture/dependency-direction.test.ts).

/** The sandbox calls a replay makes: a detached checkout of the base, a command and a copy into it, and its removal. */
export interface ReplaySandbox<H> {
  create(spec: { repo: string; branch: null; base_ref: string }): Promise<H>;
  exec(handle: H, cmd: readonly string[], opts: { env: Readonly<Record<string, string>>; stdin?: string; signal?: AbortSignal }): Promise<{ exit_code: number | null; stderr: string }>;
  copyIn(handle: H, hostPath: string, sandboxPath: string): Promise<void>;
  destroy(handle: H): Promise<void>;
}

/** An approved MCP server as a run gets it (the AgentRunSpec's PackMcpServer shape): stdio, with no credential. */
export interface ReplayMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

/** The agent run spec a replay sends: an AgentRunSpec with no session and no writable path. */
export interface ReplayRunSpec<H, T> {
  run_id: string;
  work_item_id: string;
  role: string;
  sandbox: H;
  system_prompt: string;
  prompt: string;
  tools: readonly T[];
  tool_grants: readonly string[];
  mcp_servers?: readonly ReplayMcpServer[];
  lease_token: number;
  env_allowlist: Readonly<Record<string, string>>;
  deny_paths: readonly string[];
  writable_paths: readonly string[];
  model_class: "cheap" | "standard" | "strong";
  timeout_ms: number;
  output_schema?: Record<string, unknown>;
  signal: AbortSignal;
}

export interface ReplayRunner<H, T, R> {
  run(spec: ReplayRunSpec<H, T>): Promise<R>;
}

/** What one replay runs: the repo to check out, and the run's prompt, class and limits. */
export interface ReplayRequest<T, H = unknown> {
  repo: { path: string; base_branch: string };
  run_id: string;
  work_item_id: string;
  role: string;
  system_prompt: string;
  prompt: string;
  /** The agent's file and shell tools. Absent: none. */
  tools?: readonly T[];
  /** The ToolBroker tools granted to the agent. Absent: none. */
  tool_grants?: readonly string[];
  /** The MCP servers the agent gets. Absent: none, and the spec names none. */
  mcp_servers?: readonly ReplayMcpServer[];
  /** Runs on the new sandbox before the agent starts; a throw ends the replay (the sandbox is still destroyed). */
  prepare?: (handle: H) => Promise<void>;
  env_allowlist: Readonly<Record<string, string>>;
  deny_paths: readonly string[];
  model_class: ReplayRunSpec<unknown, T>["model_class"];
  timeout_ms: number;
  output_schema?: Record<string, unknown>;
  signal: AbortSignal;
}

/**
 * Runs one replay: creates a fresh detached sandbox, prepares it, runs the agent in it, and destroys it whatever the
 * run did. Returns the runner's result; throws what the sandbox, the preparation or the runner throws (no sandbox is
 * left behind).
 */
export async function replayInSandbox<H, T, R>(parts: { sandbox: ReplaySandbox<H>; runner: ReplayRunner<H, T, R> }, req: ReplayRequest<T, H>): Promise<R> {
  const handle = await parts.sandbox.create({ repo: req.repo.path, branch: null, base_ref: req.repo.base_branch });
  try {
    await req.prepare?.(handle);
    return await parts.runner.run({
      run_id: req.run_id,
      work_item_id: req.work_item_id,
      role: req.role,
      sandbox: handle,
      system_prompt: req.system_prompt,
      prompt: req.prompt,
      tools: req.tools ?? [],
      tool_grants: req.tool_grants ?? [],
      ...(req.mcp_servers ? { mcp_servers: req.mcp_servers } : {}),
      lease_token: 0,
      env_allowlist: req.env_allowlist,
      deny_paths: req.deny_paths,
      writable_paths: [],
      model_class: req.model_class,
      timeout_ms: req.timeout_ms,
      ...(req.output_schema ? { output_schema: req.output_schema } : {}),
      signal: req.signal,
    });
  } finally {
    await parts.sandbox.destroy(handle);
  }
}

/** The non-secret environment of the clean-up commands: a system PATH only (G1). */
const CLEAN_ENV = { PATH: "/usr/bin:/bin" };

/**
 * Removes what would steer the agent besides the skill under test, in the checkout's root (the run folder): every
 * CLAUDE.md and AGENTS.md at any depth (`.git` skipped), the `.claude/`, `.agents/` and `.codex/` folders, and every
 * other skill folder (a folder holding a SKILL.md; one at the root loses only that file). Then makes `.claude/skills/`.
 */
const CLEAN_SCRIPT = [
  "set -e",
  "rm -rf .claude .agents .codex",
  "find . -name .git -prune -o \\( -name CLAUDE.md -o -name AGENTS.md \\) -exec rm -f {} +",
  "skills=$(find . -name .git -prune -o -name SKILL.md -print)",
  'printf "%s\\n" "$skills" | while IFS= read -r f; do [ -n "$f" ] || continue; d=$(dirname "$f"); if [ "$d" = . ]; then rm -f "$f"; else rm -rf "$d"; fi; done',
  "mkdir -p .claude/skills",
].join("\n");

/** The skill a clean sandbox holds: its folder name, its folder on the host, and the SKILL.md text under test. */
export interface CleanSandboxSkill {
  /** The skill's folder name: it is copied to `.claude/skills/<name>/`. */
  name: string;
  /** The skill's folder on the host. */
  folder: string;
  /** The SKILL.md text under test (a stored version's or a draft's), written over the copied one. */
  text: string;
}

/** What the clean sandbox holds besides the checkout: the skill under test, and the case's seed folder when it names one. */
export interface CleanSandboxSpec {
  /** Absent: a baseline replay (design 07-self-improvement), with no skill folder and no SKILL.md. */
  skill?: CleanSandboxSkill;
  /** The case's seed folder on the host, copied into the checkout's root; absent: none. */
  seed_folder?: string;
}

/**
 * Prepares a replay's sandbox for a skill eval (design 06-measurement, clean replays): cleans the checkout
 * (CLEAN_SCRIPT), copies the skill to `.claude/skills/<name>/` with the SKILL.md under test (none for a baseline
 * replay), then the seed folder. Throws when a step fails, so the agent never starts in a half-cleaned sandbox.
 */
export async function cleanSkillSandbox<H>(sandbox: ReplaySandbox<H>, handle: H, s: CleanSandboxSpec, signal?: AbortSignal): Promise<void> {
  const run = async (cmd: readonly string[], stdin?: string) => {
    const r = await sandbox.exec(handle, cmd, { env: CLEAN_ENV, ...(stdin !== undefined ? { stdin } : {}), ...(signal ? { signal } : {}) });
    if (r.exit_code !== 0) throw new Error(`skill-eval sandbox clean-up failed (${cmd[0]}): ${r.stderr.trim()}`);
  };
  const skill = s.skill;
  if (skill && (!/^[A-Za-z0-9_.-]+$/.test(skill.name) || /^\.+$/.test(skill.name))) throw new Error(`skill-eval replay: bad skill name ${JSON.stringify(skill.name)}`);
  await run(["sh", "-c", CLEAN_SCRIPT]);
  if (skill) {
    const target = `.claude/skills/${skill.name}`;
    await sandbox.copyIn(handle, skill.folder, target);
    await run(["sh", "-c", 'cat > "$1"', "sh", `${target}/SKILL.md`], skill.text);
  }
  if (s.seed_folder !== undefined) await sandbox.copyIn(handle, s.seed_folder, ".");
}
