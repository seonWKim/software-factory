// The agent's file and shell tools, defined once, with their guards enforced here rather than by a harness's
// settings (design §5, Sandbox). Any AgentRunner can expose them. Tools reach the run folder only through
// `Sandbox.exec`, with paths as argv entries. Egress scanning of their output stays with the caller (G5).
//
// Guarantees: Read, Glob, Grep, Write and Edit never touch a path under deny_paths (or a `.env` file), in its
// written or its symlink-resolved form, and never a path outside the workdir and writable_paths. Bash gets
// only `policy.env` and refuses a secret-looking env_allowlist key; it is not path-checked.

import { Bash } from "./bash.js";
import { Edit, Read, Write } from "./file-tools.js";
import { Glob, Grep } from "./search-tools.js";
import type { ToolSpec } from "./types.js";

export { Bash } from "./bash.js";
export { Edit, Read, Write } from "./file-tools.js";
export { FORBIDDEN_ENV, OUTPUT_CAP, type GuardPolicy, type GuardPolicyInput, guardPolicy } from "./policy.js";
export { Glob, Grep } from "./search-tools.js";
export type { ToolCapability, ToolContext, ToolResult, ToolSpec } from "./types.js";

/** The six tools, in a fixed order. */
export const TOOLS: readonly ToolSpec[] = [Read, Glob, Grep, Write, Edit, Bash];
