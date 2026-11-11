// Pack checks (design 04-pre-push-gates.md, 11-packs.md, issue #494): a pack layer's `checks/<name>.json`, enabled
// by name in `hooks`, run as argv (no shell) through the run's sandbox with the worker's tool env, never a
// credential. A check can only object: exit 0 is "no objection", which approves nothing (the engine's gates run
// after it as before); any other exit, a crash or a timeout refuses. Each refusal is written to the hook audit.

import type { PackCheckPoint } from "../../shared/hook.js";
import { type HookAudit, type HookOutcomeKind, TEXT_MAX } from "./run-hooks.js";

/** One enabled pack check, as src/packs/packs.ts loads it. The runner keeps the order it is given. */
export interface PackCheckSpec {
  readonly name: string;
  readonly point: PackCheckPoint;
  readonly argv: readonly string[];
  readonly timeout_ms: number;
  readonly retries: number;
}

/** The run's sandbox handle and its exec, as the Sandbox interface has them (src/interfaces is outside this component). */
export interface CheckHandle {
  readonly workdir: string;
}
export interface CheckSandbox {
  exec(
    handle: CheckHandle,
    cmd: readonly string[],
    opts: { env: Readonly<Record<string, string>>; timeout_ms?: number; signal?: AbortSignal },
  ): Promise<{ exit_code: number | null; signal: string | null; stdout: string; stderr: string; timed_out: boolean }>;
}

export interface PackRefusal {
  check: string;
  reason: string;
  retries: number;
}

/** What one point's checks are bound to: the run (the audit's subject), its project, its sandbox and the tool env. */
export interface PackRunContext {
  subject: string;
  project_id: string;
  sandbox: CheckHandle;
  env: Readonly<Record<string, string>>;
}

export interface BoundPackGate {
  readonly checks: readonly string[];
  run(args: readonly string[], signal: AbortSignal): Promise<PackRefusal | null>;
  untilPassed(fix: (r: PackRefusal) => Promise<void>, signal: AbortSignal): Promise<PackRefusal | null>;
}

const clip = (t: string) => (t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t);

/** The last non-empty line a check printed (stderr first), for its refusal reason. */
function lastLine(stdout: string, stderr: string): string {
  const lines = (stderr.trim() || stdout.trim()).split("\n");
  return lines[lines.length - 1]!.trim();
}

/** The enabled pack checks of a factory (the `PackChecks` the worker takes), run through `sandbox`. */
export class PackCheckRunner {
  constructor(
    private readonly checks: readonly PackCheckSpec[],
    private readonly d: { sandbox: CheckSandbox; audit?: HookAudit; now: () => string },
  ) {}

  at(point: PackCheckPoint, ctx: PackRunContext): BoundPackGate | null {
    const due = this.checks.filter((c) => c.point === point);
    if (due.length === 0) return null;
    const run = async (args: readonly string[], signal: AbortSignal): Promise<PackRefusal | null> => {
      for (const c of due) {
        const [outcome, text] = signal.aborted ? (["error", "stopped before it ran"] as const) : await this.runOne(c, ctx, args, signal);
        if (outcome === "pass") continue;
        const reason = clip(text ?? "refused");
        await this.d.audit?.record([
          { hook: c.name, point, subject: ctx.subject, project_id: ctx.project_id, passport_id: null, outcome, text: reason, at: this.d.now() },
        ]);
        return { check: c.name, reason, retries: c.retries };
      }
      return null;
    };
    return {
      checks: due.map((c) => c.name),
      run,
      untilPassed: async (fix, signal) => {
        const refusals = new Map<string, number>();
        for (;;) {
          const r = await run([], signal);
          if (r === null) return null;
          const n = (refusals.get(r.check) ?? 0) + 1;
          refusals.set(r.check, n);
          if (n > r.retries) return r;
          await fix(r);
        }
      },
    };
  }

  /** One check: exit 0 passes; another exit is a veto, a kill a crash (`error`), past its timeout a `timeout`. */
  private async runOne(c: PackCheckSpec, ctx: PackRunContext, args: readonly string[], signal: AbortSignal): Promise<[HookOutcomeKind, string | null]> {
    try {
      const r = await this.d.sandbox.exec(ctx.sandbox, [...c.argv, ...args], { env: { ...ctx.env }, timeout_ms: c.timeout_ms, signal });
      if (r.timed_out) return ["timeout", `pack_check_timeout: over its ${c.timeout_ms} ms timeout`];
      if (r.exit_code === 0) return ["pass", null];
      if (r.exit_code === null) return ["error", `pack_check_error: killed by ${r.signal ?? "a signal"}`];
      const said = lastLine(r.stdout, r.stderr);
      return ["veto", `exited ${r.exit_code}${said ? `: ${said}` : ""}`];
    } catch (err) {
      return ["error", `pack_check_error: ${err instanceof Error ? err.message : String(err)}`];
    }
  }
}
