import { Refusal, capped, defineTool, int, str } from "./guard.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * Command names Bash refuses, as word sequences. Same names the Claude Code runner denies through its harness
 * settings, so a runner that uses the shared tools gets the same checks.
 */
export const DENIED_COMMANDS: readonly string[] = [
  "gh",
  "security",
  "git push",
  "git credential",
  "printenv",
  "env",
  "mysql",
  "mysqldump",
  "mysqladmin",
];

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Returns the first denied command name that starts a segment of `command`, or undefined. Name-based only:
 * splits on `;`, `&`, `|` and newlines, skips leading `VAR=value` words, and matches whole words. Does not
 * catch `/usr/bin/env`, `sh -c`, `eval`, subshells or quoting tricks (design §5, Sandbox).
 */
export function deniedCommand(command: string): string | undefined {
  for (const segment of command.split(/[;&|\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && ASSIGNMENT.test(words[i]!)) i++;
    const rest = words.slice(i);
    for (const name of DENIED_COMMANDS) {
      const parts = name.split(" ");
      if (parts.every((p, j) => rest[j] === p)) return name;
    }
  }
  return undefined;
}

/**
 * Runs a shell command in the workdir with exactly `policy.env` (G1): nothing from the worker's environment.
 * Refuses, before anything runs, a command with a segment that starts with a `DENIED_COMMANDS` name.
 * Not path-checked: a command can still read a denied file or write outside the workdir. Only an OS-level
 * sandbox can stop that (design §5, Sandbox).
 */
export const Bash = defineTool({
  name: "Bash",
  description:
    "Run a shell command (/bin/sh -c) in the workdir. Returns stdout then stderr; a non-zero exit code is appended. The environment holds only allowlisted variables.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS },
    },
    required: ["command"],
    additionalProperties: false,
  },
  capability: "exec",
  async run(input, ctx) {
    if (ctx.policy.env_refusal) throw new Refusal(ctx.policy.env_refusal);
    const command = str(input, "command", true);
    const denied = deniedCommand(command);
    if (denied) throw new Refusal(`command refused: "${denied}" is not allowed in Bash`);
    const timeout_ms = Math.min(int(input, "timeout_ms") ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const r = await ctx.sandbox.exec(ctx.handle, ["/bin/sh", "-c", command], {
      env: ctx.policy.env,
      timeout_ms,
      ...(ctx.signal && { signal: ctx.signal }),
    });
    if (r.timed_out) throw new Refusal(`command timed out after ${timeout_ms} ms`);
    let out = r.stdout;
    if (r.stderr) out += (out && !out.endsWith("\n") ? "\n" : "") + r.stderr;
    if (r.exit_code !== 0) {
      out += `${out && !out.endsWith("\n") ? "\n" : ""}[exit code ${r.exit_code ?? `signal ${r.signal}`}]`;
    }
    return capped(ctx, out);
  },
});
