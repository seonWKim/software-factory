import type { PassportService, ResourceRef } from "../../identity/index.js";
import type { AuthAction, AuthDecision, AuthProvider, AuthResource, CommandPassport, ExternalIdentity, Principal } from "../../interfaces/auth-provider.js";

/**
 * The owner check (or any AuthProvider) with every decision audited (RFC 0015 §8). A person's command carries no edge
 * passport (design 08-permissions, One owner): the inner check decides and Identity records one authz_audit row under
 * passport `none`. With a passport (Identity's own tests), Identity checks it first and the inner check decides the rest.
 */
export class AuditedAuthProvider implements AuthProvider {
  constructor(
    /** The deciding plugin; public so tests can see which one is wired. */
    readonly inner: AuthProvider,
    private readonly identity: Pick<PassportService, "record" | "authorize">,
  ) {}

  resolve(identity: ExternalIdentity): Promise<Principal | null> {
    return this.inner.resolve(identity);
  }

  async authorize(principal: Principal, action: AuthAction, resource: AuthResource, passport?: CommandPassport): Promise<AuthDecision> {
    const ref = resourceRef(resource);
    if (passport !== undefined) {
      const roles = async (holder: string) => {
        if (holder !== principal.user_id) return "passport_principal_mismatch";
        const d = await this.inner.authorize(principal, action, resource);
        return d.allow ? "allowed" : d.reason;
      };
      const r = await this.identity.authorize(passport.id, action, ref, roles, passport.at);
      return r.allow ? { allow: true } : { allow: false, reason: r.reason };
    }
    const decision = await this.inner.authorize(principal, action, resource);
    await this.identity.record({
      passport_id: null,
      principal: principal.user_id,
      action,
      resource: ref,
      allow: decision.allow,
      reason: decision.allow ? "allowed" : decision.reason,
    });
    return decision;
  }
}

function resourceRef(resource: AuthResource): ResourceRef {
  return resource.kind === "work_item" ? { project: null, item: resource.id } : resource.kind === "project" ? { project: resource.id } : { project: null, tool: resource.id };
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
