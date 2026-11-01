import { Refusal, capped, defineTool, int, str } from "./guard.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * Runs a shell command in the workdir with exactly `policy.env` (G1): nothing from the worker's environment.
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
