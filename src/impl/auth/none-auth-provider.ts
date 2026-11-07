import type { UserId } from "../../core/types.js";
import type { AuthDecision, AuthProvider, ExternalIdentity, Principal } from "../../interfaces/auth-provider.js";

/** Local dev only, on a private repo. Allows everything. */
export class NoAuthProvider implements AuthProvider {
  async resolve(identity: ExternalIdentity): Promise<Principal | null> {
    return { user_id: `${identity.provider}:${identity.subject}` as UserId, attributes: {} };
  }
  async authorize(): Promise<AuthDecision> {
    return { allow: true };
  }
}
