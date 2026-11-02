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
 * Permissions in the factory (design 2026-11-01, issue #107; before: GitHub write access, checked inside the
 * GitHub auth provider, was the only permission). A factory user ID has linked provider accounts; grant
 * sources give it roles per project; a role grants actions. Every command path reaches `authorize` below
 * through `AuthProvider.authorize`, with the factory user ID, never a provider account.
 */

/** What each role may do. The action names are the existing AuthAction values. */
export const ROLE_ACTIONS: Readonly<Record<Role, readonly AuthAction[]>> = {
  requester: ["submit_work"],
  approver: ["submit_work", "approve_spec", "approve_merge", "record_verdict", "use_tool"],
};

/**
 * Actions any resolved user may take unless denied. Intake keeps its own gate: on GitHub only a user with
 * triage access can add the intake label, so this keeps today's behaviour for `submit_work`.
 */
const OPEN_ACTIONS: readonly AuthAction[] = ["submit_work"];

export interface AuthorizeDeps {
  store: Pick<FactoryStore, "getWorkItem" | "listLinks">;
  /** The selected grant sources (`permissions.grants`), in config order. */
  grants: readonly GrantSource[];
}

/**
 * The one authorize check. Any deny refuses (`denied`). Otherwise the action is allowed when any grant gives
 * a role that includes it; local grants are asked first and the first role that covers the action stops the
 * search, so a remote API is not called for a user a local grant already covers. Else `no_role`.
 */
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

/**
 * The accounts of a user: its linked ones, plus the account its ID names. GitHub user IDs stay `github:<id>`
 * (design 2026-11-01), so `github:1` is GitHub account 1 with no link row.
 */
async function accountsOf(d: AuthorizeDeps, user_id: UserId): Promise<LinkedAccount[]> {
  const out = await d.store.listLinks(user_id);
  const m = IMPLIED.exec(user_id);
  if (m && !out.some((a) => a.provider === m[1] && a.subject === m[2])) {
    out.unshift({ provider: m[1] as LinkedAccount["provider"], subject: m[2]! });
  }
  return out;
}

/**
 * An AuthProvider over the store's links and the grant sources. `resolve`: a linked account maps to its
 * user; otherwise `fallback` decides (GitHub: `github:<id>`), and null refuses the account as not linked.
 * Links are looked up by provider and subject only; a display name never changes the user.
 */
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
