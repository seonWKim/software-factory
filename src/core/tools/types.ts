import type { Sandbox, SandboxHandle } from "../../interfaces/sandbox.js";
import type { GuardPolicy } from "./policy.js";

/** What a tool may do. Read, Glob, Grep: read. Write, Edit: write. Bash: exec. */
export type ToolCapability = "read" | "write" | "exec";

/**
 * Every tool result. A refusal or a sandbox failure is `{ok:false, error}`; tools never throw.
 * `truncated` is present (true) only when the content was cut at the output cap.
 */
export type ToolResult = { ok: true; content: string; truncated?: true } | { ok: false; error: string };

export interface ToolContext {
  sandbox: Sandbox;
  handle: SandboxHandle;
  /** From `guardPolicy`. Every path and env check uses it; nothing comes from the runner. */
  policy: GuardPolicy;
  signal?: AbortSignal;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the input object. */
  readonly input_schema: Readonly<Record<string, unknown>>;
  readonly capability: ToolCapability;
  /** Validates `input` itself. Resolves to a ToolResult; never rejects. */
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
