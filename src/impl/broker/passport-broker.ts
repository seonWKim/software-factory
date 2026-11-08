import type { PassportChecker, ResourceRef } from "../../identity/index.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../../interfaces/tool-broker.js";

/** The audience a run passport names (src/worker/passports/run-passports.ts): only the broker accepts it. */
const AUDIENCE = "tool-broker";

/** The run passport the worker minted for a run, as this process holds it. */
export interface HeldRunPassport {
  readonly token: string;
  readonly project: string;
  readonly branch: string;
}

/**
 * G2 with passports (RFC 0015 §8 "Tools", M9): every call is checked against the run's passport before the inner
 * broker sees it. The check is offline (HMAC chain, expiry, the deny list of Identity's last tick) and audited in
 * authz_audit. Refused: a run with no passport in this process, a revoked or expired passport (or a revoked
 * parent), a tool, run, item or branch the passport does not name. Only stricter than the inner broker, which
 * still checks the lease, the branch prefix and egress itself.
 */
export class PassportToolBroker implements ToolBroker {
  constructor(
    /** The guarded broker; public so startup checks and tests can see which plugin is wired. */
    readonly inner: ToolBroker,
    private readonly deps: {
      checker: PassportChecker;
      passportOf: (run: string) => HeldRunPassport | null;
    },
  ) {}

  listTools(grants: readonly string[]): ToolDescriptor[] {
    return this.inner.listTools(grants);
  }

  allTools(): readonly ToolDescriptor[] {
    return this.inner.allTools();
  }

  async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    const held = this.deps.passportOf(ctx.run_id);
    if (!held) return { ok: false, error_code: "passport_missing", message: `run ${ctx.run_id} holds no run passport` };
    const resource: ResourceRef = {
      project: held.project,
      item: ctx.work_item_id,
      run: ctx.run_id,
      // A tool that names a branch is checked on it; one that names none (a comment) acts on the run's own.
      branch: branchArg(args) ?? held.branch,
      tool: name,
      audience: AUDIENCE,
    };
    const decision = await this.deps.checker.check(held.token, "use_tool", resource);
    if (!decision.allow) return { ok: false, error_code: "passport_denied", message: `${name}: ${decision.reason}` };
    return this.inner.call(ctx, name, args);
  }
}

function branchArg(args: unknown): string | null {
  const b = typeof args === "object" && args !== null ? (args as { branch?: unknown }).branch : undefined;
  return typeof b === "string" ? b : null;
}
