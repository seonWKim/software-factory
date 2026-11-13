import type { UserId, WorkItemId } from "./types.js";
import type {
  AuthAction,
  AuthDecision,
  AuthProvider,
  AuthResource,
  ExternalIdentity,
  GrantSource,
  GrantSubject,
  LinkedAccount,
  Principal,
  Role,
} from "../interfaces/auth-provider.js";
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
 * Actions any resolved caller may take: a work request is not a command, and the intake label (or the chat source's
 * own rules) stays its gate. Every other action is the owner's.
 */
const OPEN_ACTIONS: readonly AuthAction[] = ["submit_work"];

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
 * of another provider never claims it. `submit_work` stays open to any caller.
 */
export async function authorizeOwner(store: Pick<OwnerStore, "getLocalUser" | "claimLocalOwner">, user_id: UserId, action: AuthAction): Promise<AuthDecision> {
  if (OPEN_ACTIONS.includes(action)) return { allow: true };
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

  authorize(principal: Principal, action: AuthAction): Promise<AuthDecision> {
    return authorizeOwner(this.store, principal.user_id, action);
  }
}

/**
 * Deprecated (phase A of issue #575): roles per project from grant sources (design 2026-11-01). Only the auth plugins
 * `github` and `local` still extend `FactoryAuth`, and nothing selects them; phase B removes them, the grants and
 * everything below.
 */
export const ROLE_ACTIONS: Readonly<Record<Role, readonly AuthAction[]>> = {
  requester: ["submit_work"],
  approver: ["submit_work", "approve_spec", "approve_merge", "record_verdict", "use_tool"],
};

export interface AuthorizeDeps {
  store: Pick<FactoryStore, "getWorkItem" | "listLinks">;
  /** The grant sources, in order. */
  grants: readonly GrantSource[];
}

/** Deprecated (see ROLE_ACTIONS): any deny refuses; else a grant's role that covers the action allows; else `no_role`. */
export async function authorize(d: AuthorizeDeps, user_id: UserId, action: AuthAction, resource: AuthResource): Promise<AuthDecision> {
  const project = await projectOf(d, resource);
  const subject: GrantSubject = { user_id, accounts: await accountsOf(d, user_id) };
  for (const g of d.grants) if (await g.denies(subject, project)) return { allow: false, reason: "denied" };
  if (OPEN_ACTIONS.includes(action)) return { allow: true };
  const ordered = [...d.grants.filter((g) => !g.remote), ...d.grants.filter((g) => g.remote)];
  for (const g of ordered) {
    const roles = await g.roles(subject, project);
    if (roles.some((r) => ROLE_ACTIONS[r].includes(action))) return { allow: true };
  }
  return { allow: false, reason: "no_role" };
}

async function projectOf(d: AuthorizeDeps, resource: AuthResource): Promise<string | null> {
  if (resource.kind === "project") return resource.id;
  if (resource.kind !== "work_item") return null;
  return (await d.store.getWorkItem(resource.id as WorkItemId))?.project ?? null;
}

const IMPLIED = /^(github|slack|oidc):(.+)$/;

/** The accounts of a user: its linked ones, plus the account its ID names (`github:1` is account 1, no link row). */
async function accountsOf(d: AuthorizeDeps, user_id: UserId): Promise<LinkedAccount[]> {
  const out = await d.store.listLinks(user_id);
  const m = IMPLIED.exec(user_id);
  if (m && !out.some((a) => a.provider === m[1] && a.subject === m[2])) {
    out.unshift({ provider: m[1] as LinkedAccount["provider"], subject: m[2]! });
  }
  return out;
}

/** Deprecated (see ROLE_ACTIONS): the unselected auth plugins' base, over the store's links and the grant sources. */
export class FactoryAuth implements AuthProvider {
  constructor(
    private readonly deps: AuthorizeDeps & { store: Pick<FactoryStore, "resolveLink"> },
    private readonly fallback: (identity: ExternalIdentity) => UserId | null = () => null,
  ) {}

  async resolve(identity: ExternalIdentity): Promise<Principal | null> {
    const user_id = (await this.deps.store.resolveLink(identity.provider, identity.subject)) ?? this.fallback(identity);
    return user_id ? { user_id, attributes: {} } : null;
  }

  authorize(principal: Principal, action: AuthAction, resource: AuthResource): Promise<AuthDecision> {
    return authorize(this.deps, principal.user_id, action, resource);
  }
}
