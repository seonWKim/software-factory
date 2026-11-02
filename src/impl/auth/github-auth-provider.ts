import { FactoryAuth } from "../../core/authorize.js";
import type { UserId } from "../../core/types.js";
import type { AuthDecision, AuthProvider, ExternalIdentity, GrantSource, Principal } from "../../interfaces/auth-provider.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";

/**
 * GitHub accounts as factory users (design 2026-11-01). A linked account maps to its factory user; any other
 * GitHub account is `github:<numeric id>`, so existing history keeps its approvers. Other providers resolve only
 * through a link. Permission comes from the grant sources (`permissions.grants`; the GitHub check is the
 * `github-permission` grant), never from this class. Deny by default.
 */
export class GitHubAuthProvider extends FactoryAuth {
  constructor(store: Pick<FactoryStore, "resolveLink" | "listLinks" | "getWorkItem">, grants: readonly GrantSource[]) {
    super({ store, grants }, (identity) => (identity.provider === "github" ? (`github:${identity.subject}` as UserId) : null));
  }
}

/** Local dev only, on a private repo. Allows everything. */
export class NoAuthProvider implements AuthProvider {
  async resolve(identity: ExternalIdentity): Promise<Principal | null> {
    return { user_id: `${identity.provider}:${identity.subject}` as UserId, attributes: {} };
  }
  async authorize(): Promise<AuthDecision> {
    return { allow: true };
  }
}
