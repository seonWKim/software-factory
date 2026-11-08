import type { PassportService } from "../../identity/index.js";
import type { AuthAction, AuthDecision, AuthProvider, AuthResource, ExternalIdentity, Principal } from "../../interfaces/auth-provider.js";

/**
 * Any auth plugin, with every authorize decision written to authz_audit (RFC 0015 §8, M9). The decision is the
 * plugin's own, unchanged: Identity records it, it does not decide yet. The legacy call carries no passport, so
 * the row's passport_id is `none` until the controller's command units pass the command's passport (M5).
 */
export class AuditedAuthProvider implements AuthProvider {
  constructor(
    /** The deciding plugin; public so tests can see which one is wired. */
    readonly inner: AuthProvider,
    private readonly identity: Pick<PassportService, "record">,
  ) {}

  resolve(identity: ExternalIdentity): Promise<Principal | null> {
    return this.inner.resolve(identity);
  }

  async authorize(principal: Principal, action: AuthAction, resource: AuthResource): Promise<AuthDecision> {
    const decision = await this.inner.authorize(principal, action, resource);
    await this.identity.record({
      passport_id: null,
      principal: principal.user_id,
      action,
      resource: resource.kind === "work_item" ? { project: null, item: resource.id } : resource.kind === "project" ? { project: resource.id } : { project: null, tool: resource.id },
      allow: decision.allow,
      reason: decision.allow ? "allowed" : decision.reason,
    });
    return decision;
  }
}
