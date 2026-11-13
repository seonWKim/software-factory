import type { PassportService } from "../../identity/index.js";
import type { AuthAction, AuthDecision, AuthProvider, AuthResource, ExternalIdentity, Principal } from "../../interfaces/auth-provider.js";

/**
 * Deprecated (issue #577): the owner check (`OwnerAuth`) now writes each decision's one authz_audit row itself, so
 * every caller is audited, also the ones compose never wrapped (the CLI's approve_tool, `factory settings`, Slack
 * taps). This wrapper only delegates and records nothing, so no decision is audited twice. compose.ts still builds
 * it; removal plan: construct `OwnerAuth` directly there, then delete this class (design 08-permissions).
 */
export class AuditedAuthProvider implements AuthProvider {
  constructor(
    /** The deciding plugin; public so tests can see which one is wired. */
    readonly inner: AuthProvider,
    _identity?: Pick<PassportService, "record">,
  ) {}

  resolve(identity: ExternalIdentity): Promise<Principal | null> {
    return this.inner.resolve(identity);
  }

  authorize(principal: Principal, action: AuthAction, resource: AuthResource): Promise<AuthDecision> {
    return this.inner.authorize(principal, action, resource);
  }
}

/**
 * Outbound's deliveries under its service passport (RFC 0015 §8, M9): each target's write is `use_tool` on that
 * target (`github-push`, `github-change`, ...) by `service:outbound`, decided and audited under that passport.
 * Returns the decision and the passport it was made under, which DeliveryCompleted carries.
 */
export function outboundServiceAuth(
  identity: Pick<PassportService, "service" | "authorize">,
): (project: string, target: string) => Promise<{ passport_id: string; decision: AuthDecision }> {
  return async (project, target) => {
    const passport_id = (await identity.service("outbound")).passport.id;
    const r = await identity.authorize(passport_id, "use_tool", { project, tool: target });
    return { passport_id, decision: r.allow ? { allow: true } : { allow: false, reason: r.reason } };
  };
}

/**
 * The controller's automatic steps (auto mode's spec approvals and merges) under its service passport (RFC 0015 §8):
 * Identity decides on `service:controller`, limited to the controller's actions, and audits it under that passport.
 */
export function controllerServiceAuth(
  identity: Pick<PassportService, "service" | "authorize">,
): (action: AuthAction, resource: { project: string; item: string }) => Promise<AuthDecision> {
  return async (action, resource) => {
    const r = await identity.authorize((await identity.service("controller")).passport.id, action, resource);
    return r.allow ? { allow: true } : { allow: false, reason: r.reason };
  };
}
