// The replay primitive the golden replay (src/golden.ts) and the skill-eval replay share: one agent run in a fresh,
// detached sandbox (`branch: null`), destroyed after, with no session, no doc index, no broker tool grant and no
// writable path. Tools are none unless the caller names them (a golden replay gives its role's).
//
// The sandbox and runner types are structural, the shape of the Sandbox and AgentRunner interfaces' calls used here,
// so this component imports no legacy module (tests/architecture/dependency-direction.test.ts).

/** The sandbox calls a replay makes: a detached checkout of the base, and its removal. */
export interface ReplaySandbox<H> {
  create(spec: { repo: string; branch: null; base_ref: string }): Promise<H>;
  destroy(handle: H): Promise<void>;
}

/** The agent run spec a replay sends: an AgentRunSpec with no session, no grant and no writable path. */
export interface ReplayRunSpec<H, T> {
  run_id: string;
  work_item_id: string;
  role: string;
  sandbox: H;
  system_prompt: string;
  prompt: string;
  tools: readonly T[];
  tool_grants: readonly string[];
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
export interface ReplayRequest<T> {
  repo: { path: string; base_branch: string };
  run_id: string;
  work_item_id: string;
  role: string;
  system_prompt: string;
  prompt: string;
  /** The agent's file and shell tools. Absent: none. */
  tools?: readonly T[];
  env_allowlist: Readonly<Record<string, string>>;
  deny_paths: readonly string[];
  model_class: ReplayRunSpec<unknown, T>["model_class"];
  timeout_ms: number;
  output_schema?: Record<string, unknown>;
  signal: AbortSignal;
}

/**
 * Runs one replay: creates a fresh detached sandbox, runs the agent in it, and destroys it whatever the run did.
 * Returns the runner's result; throws what the sandbox or the runner throws (no sandbox is left behind).
 */
export async function replayInSandbox<H, T, R>(parts: { sandbox: ReplaySandbox<H>; runner: ReplayRunner<H, T, R> }, req: ReplayRequest<T>): Promise<R> {
  const handle = await parts.sandbox.create({ repo: req.repo.path, branch: null, base_ref: req.repo.base_branch });
  try {
    return await parts.runner.run({
      run_id: req.run_id,
      work_item_id: req.work_item_id,
      role: req.role,
      sandbox: handle,
      system_prompt: req.system_prompt,
      prompt: req.prompt,
      tools: req.tools ?? [],
      tool_grants: [],
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
