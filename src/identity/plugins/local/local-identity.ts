// The solo default (RFC 0015 §10): the operator's identity from the environment, and the owner holds every
// role. Keys only (an email or a login name), never a display name such as git's user.name.

import type { AuthProvider, ExternalIdentity, GrantSource, GrantSubject, Principal, Role } from "../../passport/types.js";

/** What the environment says about the operator; each null when unavailable. */
export interface LocalEnvironment {
  readonly gitEmail: string | null;
  readonly osUser: string | null;
}

export const ANONYMOUS_USER = "local:anonymous";

/** git user.email, else the OS user, else `anonymous`. A value with whitespace is skipped. */
export function localIdentity(env: LocalEnvironment): ExternalIdentity {
  const ok = (v: string | null): v is string => v !== null && /^\S+$/.test(v.trim());
  if (ok(env.gitEmail)) return { provider: "local", subject: env.gitEmail.trim().toLowerCase() };
  if (ok(env.osUser)) return { provider: "local", subject: env.osUser.trim() };
  return { provider: "local", subject: "anonymous" };
}

/** A local subject is its own factory user: `local:<subject>`, or the subject when it already is a user id. */
export class LocalAuthProvider implements AuthProvider {
  readonly provider = "local" as const;

  async resolve(identity: ExternalIdentity): Promise<Principal | null> {
    if (identity.provider !== "local" || !/^\S+$/.test(identity.subject)) return null;
    return { user_id: /^[a-z]+:\S+$/.test(identity.subject) ? identity.subject : `local:${identity.subject}` };
  }
}

/** The owner has every role on every project; nobody else has one. `local:anonymous` is never the owner. */
export class OwnerGrant implements GrantSource {
  readonly remote = false;

  constructor(private readonly owner: string) {}

  async denies(): Promise<boolean> {
    return false;
  }

  async roles(subject: GrantSubject): Promise<readonly Role[]> {
    return subject.user_id === this.owner && subject.user_id !== ANONYMOUS_USER ? ["owner"] : [];
  }
}
