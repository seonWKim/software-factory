import type { UserId } from "./types.js";
import type { AuthAction, AuthDecision, AuthProvider, AuthResource, ExternalIdentity, Principal } from "../interfaces/auth-provider.js";
import type { FactoryStore } from "../interfaces/factory-store.js";

/**
 * The one owner check (design 08-permissions, One owner; phase A of issue #575). Every command path (the controller
 * units, the command inbox, the local CLI, the dashboard commands and approve_tool) reaches `authorizeOwner` through
 * `OwnerAuth`: the caller's identity, resolved to a factory user, must be the store's local owner. Anyone else is
 * refused as `not_owner`. Service principals (the controller's auto mode, the worker's and outbound's tool calls)
 * keep their passport checks and never reach it.
 */

/** The owner check's refusal reason. */
export const NOT_OWNER = "not_owner";
/** The reply a command refused by the owner check gets. */
export const NOT_OWNER_REPLY = "only the owner may send this command";
/** The identity the environment gives when it names no one: never the owner. */
export const ANONYMOUS_USER = "local:anonymous" as UserId;

/**
 * Actions any caller may take: a work request is not a command, and the intake label stays its gate. Every other
 * action is the owner's.
 */
const OPEN_ACTIONS: readonly AuthAction[] = ["submit_work"];
/** A chat account no link maps to a factory user: a chat source has no intake label, so it may not file work either. */
const UNLINKED_CHAT = /^(slack|oidc):/;

/** The reply for a refused decision: the owner check's text, with the reason when it is not `not_owner`. */
export function refusalReply(reason: string): string {
  return reason === NOT_OWNER ? NOT_OWNER_REPLY : `${NOT_OWNER_REPLY} (\`${reason}\`)`;
}

export type OwnerStore = Pick<FactoryStore, "resolveLink" | "getLocalUser" | "claimLocalOwner">;

/** The factory user of a local identity: the subject when it is already a user ID, else `local:<subject>`. */
export function localUserId(identity: ExternalIdentity): UserId | null {
  if (identity.provider !== "local") return null;
  return (/^[a-z]+:\S+$/.test(identity.subject) ? identity.subject : `local:${identity.subject}`) as UserId;
}

/**
 * The factory user of `identity`: its linked user first (by provider and subject only, never a display name), else
 * a local identity's own ID, else `<provider>:<subject>`, which is never the owner unless linked.
 */
export async function factoryUserOf(store: Pick<OwnerStore, "resolveLink">, identity: ExternalIdentity): Promise<UserId> {
  return (await store.resolveLink(identity.provider, identity.subject)) ?? localUserId(identity) ?? (`${identity.provider}:${identity.subject}` as UserId);
}

/**
 * The owner check: `user_id` must be the store's local owner. A local user ID asked while the store has no owner
 * claims it (solo needs no setup: you are the owner on your first command); `anonymous` never does, and an account
 * of another provider never claims it. `submit_work` stays open to any caller but an unlinked chat account.
 */
export async function authorizeOwner(store: Pick<OwnerStore, "getLocalUser" | "claimLocalOwner">, user_id: UserId, action: AuthAction): Promise<AuthDecision> {
  if (OPEN_ACTIONS.includes(action) && !UNLINKED_CHAT.test(user_id)) return { allow: true };
  if (user_id === ANONYMOUS_USER) return { allow: false, reason: NOT_OWNER };
  let row = await store.getLocalUser(user_id);
  if (!row && user_id.startsWith("local:")) row = await store.claimLocalOwner(user_id);
  return row?.user_id === user_id && row.role === "owner" ? { allow: true } : { allow: false, reason: NOT_OWNER };
}

/** The owner check as an AuthProvider: what compose gives every command path. No grant, no remote call. */
export class OwnerAuth implements AuthProvider {
  constructor(private readonly store: OwnerStore) {}

  async resolve(identity: ExternalIdentity): Promise<Principal> {
    return { user_id: await factoryUserOf(this.store, identity), attributes: {} };
  }

  /** The resource does not matter: the owner may act on every one, anyone else on none. */
  authorize(principal: Principal, action: AuthAction, _resource?: AuthResource): Promise<AuthDecision> {
    return authorizeOwner(this.store, principal.user_id, action);
  }
}
