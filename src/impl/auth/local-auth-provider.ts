import { FactoryAuth } from "../../core/authorize.js";
import type { UserId } from "../../core/types.js";
import type { ExternalIdentity, GrantSource, GrantSubject, Role } from "../../interfaces/auth-provider.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";

/** The local identity used when the environment names no one (src/core/local-cli.ts). Read and create only. */
export const ANONYMOUS_USER = "local:anonymous" as UserId;

/**
 * Roles from the store's local users (issue #318): `owner` and `approver` approve, `requester` and anyone without
 * a row only submit work. The first identity asked about while the store has no owner becomes the owner, so a
 * solo setup needs no step; `anonymous` never does. No remote call.
 */
export class LocalUsersGrant implements GrantSource {
  readonly remote = false;

  constructor(private readonly store: Pick<FactoryStore, "getLocalUser" | "claimLocalOwner" | "listLocalUsers">) {}

  async denies(): Promise<boolean> {
    return false;
  }

  async roles(subject: GrantSubject): Promise<readonly Role[]> {
    let row = await this.store.getLocalUser(subject.user_id);
    if (!row && subject.user_id !== ANONYMOUS_USER) {
      const owner = await this.store.claimLocalOwner(subject.user_id);
      if (owner.user_id === subject.user_id) row = owner;
    }
    if (!row) return [];
    return row.role === "requester" ? ["requester"] : ["approver"];
  }
}

/**
 * Local auth (issue #318): authorizes commands from the local CLI and the local UI with no GitHub call, no link
 * and no account outside this machine. A local identity `local:<x>` (or a `cli_user` such as `github:1`, kept as
 * it is) is its own factory user; links are still read first. Roles come from the store's local users
 * (LocalUsersGrant) and from the configured grants that make no remote call (`static`), so a deny there still
 * refuses; remote grants (`github-permission`) are never asked. Any other provider is refused as not linked:
 * GitHub comments are authorized by the auth plugin selected for `github_issue`.
 */
export class LocalAuthProvider extends FactoryAuth {
  constructor(
    store: Pick<FactoryStore, "resolveLink" | "listLinks" | "getWorkItem" | "getLocalUser" | "claimLocalOwner" | "listLocalUsers">,
    grants: readonly GrantSource[] = [],
  ) {
    super({ store, grants: [new LocalUsersGrant(store), ...grants.filter((g) => !g.remote)] }, localUserId);
  }
}

/** The factory user of a local identity: the subject when it is already a user ID, else `local:<subject>`. */
export function localUserId(identity: ExternalIdentity): UserId | null {
  if (identity.provider !== "local") return null;
  return (/^[a-z]+:\S+$/.test(identity.subject) ? identity.subject : `local:${identity.subject}`) as UserId;
}
