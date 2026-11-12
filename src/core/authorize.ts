import type { UserId } from "./types.js";
import type { AuthAction, AuthDecision, AuthProvider, AuthResource, ExternalIdentity, Principal } from "../interfaces/auth-provider.js";
import type { FactoryStore } from "../interfaces/factory-store.js";

/**
 * The one owner check (design 08-permissions, One owner; issue #575). The factory serves one person: a gate action is
 * allowed only when the command's factory user is the owner, whatever surface it came from (GitHub, Slack, the
 * CLI, the dashboard). It replaces the per-origin auth plugins (`github`, `local`, `none`) and the grant sources.
 */

/** The local identity used when the environment names no one (src/core/local-cli.ts). Never the owner. */
export const ANONYMOUS_USER = "local:anonymous" as UserId;

/** The refusal reason for anyone but the owner, and the reply the command gets. */
export const NOT_OWNER = "not_owner";
export const NOT_OWNER_REPLY = "only the owner may send this command";

/** Actions any resolved user may take: intake keeps its own gate on the source (the intake label). */
const OPEN_ACTIONS: readonly AuthAction[] = ["submit_work"];

export interface OwnerAuthDeps {
  store: Pick<FactoryStore, "resolveLink" | "getLocalUser" | "claimLocalOwner">;
  /**
   * The identity this process's environment names (`cli_user`, else the CLI identity): the one user that claims the
   * owner while the store has none, so a solo setup needs no step. Null: only a stored owner is the owner.
   */
  claimer: UserId | null;
}

/**
 * The owner as the factory's AuthProvider. `resolve`: a linked account maps to its factory user; an unlinked GitHub
 * account is `github:<id>` and a local identity its own user (`localUserId`); any other unlinked account resolves to
 * no user. `authorize`: `submit_work` is open; every other action needs the owner, else `not_owner`. No remote call.
 */
export class OwnerAuth implements AuthProvider {
  constructor(private readonly d: OwnerAuthDeps) {}

  async resolve(identity: ExternalIdentity): Promise<Principal | null> {
    const linked = await this.d.store.resolveLink(identity.provider, identity.subject);
    const user_id = linked ?? (identity.provider === "github" ? (`github:${identity.subject}` as UserId) : localUserId(identity));
    return user_id ? { user_id, attributes: {} } : null;
  }

  /** The resource does not matter: the owner may act on every project and item. */
  async authorize(principal: Principal, action: AuthAction, _resource?: AuthResource): Promise<AuthDecision> {
    if (OPEN_ACTIONS.includes(action)) return { allow: true };
    return (await this.isOwner(principal.user_id)) ? { allow: true } : { allow: false, reason: NOT_OWNER };
  }

  /** The store's local owner; while there is none, the claimer becomes it. `anonymous` never is. */
  private async isOwner(user_id: UserId): Promise<boolean> {
    if (user_id === ANONYMOUS_USER) return false;
    if ((await this.d.store.getLocalUser(user_id))?.role === "owner") return true;
    if (user_id !== this.d.claimer) return false;
    return (await this.d.store.claimLocalOwner(user_id)).user_id === user_id;
  }
}

/** The factory user of a local identity: the subject when it is already a user ID, else `local:<subject>`. */
export function localUserId(identity: ExternalIdentity): UserId | null {
  if (identity.provider !== "local") return null;
  return (/^[a-z]+:\S+$/.test(identity.subject) ? identity.subject : `local:${identity.subject}`) as UserId;
}
