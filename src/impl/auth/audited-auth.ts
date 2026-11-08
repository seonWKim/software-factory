import type { AuthProvider as IdentityProvider, PassportService, Principal as IdentityPrincipal, Provider } from "../../identity/index.js";
import type { AuthAction, AuthDecision, AuthProvider, AuthResource, ExternalIdentity, Principal } from "../../interfaces/auth-provider.js";

/**
 * The provider mapping of an auth plugin as Identity's provider (RFC 0015 §8 "Edge"): a forge or chat account
 * resolves to the same factory user the plugin's own `resolve` gives (linked accounts first), with no remote call.
 */
export class PluginIdentityProvider implements IdentityProvider {
  constructor(
    readonly provider: Exclude<Provider, "local" | "service">,
    private readonly plugin: AuthProvider,
  ) {}

  async resolve(identity: { provider: Provider; subject: string }): Promise<IdentityPrincipal | null> {
    if (identity.provider !== this.provider) return null;
    const p = await this.plugin.resolve({ provider: this.provider, subject: identity.subject });
    return p ? { user_id: p.user_id } : null;
  }
}

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
