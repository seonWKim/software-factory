import { isAbsolute, normalize, resolvePath } from "./paths.js";

/** Largest content a tool returns, in characters. Longer output is cut here and marked `truncated`. */
export const OUTPUT_CAP = 64 * 1024;

/**
 * Env var names that must never reach an agent's shell through env_allowlist (G1). Same pattern as the
 * Claude Code runner's; core cannot import src/impl, so it lives here too.
 */
export const FORBIDDEN_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE/i;

/** PATH for the tools' own helper commands, and for Bash when env_allowlist sets none. */
export const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export interface GuardPolicyInput {
  /** The sandbox workdir (absolute). */
  workdir: string;
  /** Paths no file tool may read, write or list, wherever they are. */
  deny_paths: readonly string[];
  /** Paths outside the workdir the file tools may read and write. */
  writable_paths: readonly string[];
  /** Non-secret env vars for Bash. Nothing else is inherited. */
  env_allowlist: Readonly<Record<string, string>>;
}

export interface GuardPolicy {
  /** Normalized, absolute. */
  readonly workdir: string;
  /** Normalized, absolute (relative entries are taken against the workdir). */
  readonly deny_paths: readonly string[];
  readonly writable_paths: readonly string[];
  /** Bash's whole environment: `PATH` (default unless allowlisted) plus env_allowlist. Empty when refused. */
  readonly env: Readonly<Record<string, string>>;
  /** Set when env_allowlist has a secret-looking key: Bash refuses to run. */
  readonly env_refusal: string | null;
  /** Set when the input cannot be enforced (e.g. a relative workdir): every tool refuses. */
  readonly invalid: string | null;
  readonly output_cap: number;
}

/** The one guard policy every tool enforces. Pure: no I/O, no throw. */
export function guardPolicy(input: GuardPolicyInput): GuardPolicy {
  const invalid = isAbsolute(input.workdir) ? null : `workdir must be an absolute path, got ${JSON.stringify(input.workdir)}`;
  const workdir = normalize(input.workdir);
  const forbidden = Object.keys(input.env_allowlist).filter((k) => FORBIDDEN_ENV.test(k));
  const env_refusal = forbidden.length > 0 ? `env_allowlist may not contain ${forbidden.join(", ")} (G1)` : null;
  return {
    workdir,
    deny_paths: input.deny_paths.map((p) => resolvePath(workdir, p)),
    writable_paths: input.writable_paths.map((p) => resolvePath(workdir, p)),
    env: env_refusal ? {} : { PATH: DEFAULT_PATH, ...input.env_allowlist },
    env_refusal,
    invalid,
    output_cap: OUTPUT_CAP,
  };
}
