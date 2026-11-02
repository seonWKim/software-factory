import type { UserId } from "../core/types.js";

// design §8. Called by intake, tool wrappers and the human gate. First impl: NoAuth.
// Since 2026-11-01 (issue #107): `resolve` maps a provider account to a factory user (linked accounts first), and
// `authorize` asks the grant sources below through the one shared check in src/core/authorize.ts.

export interface Principal {
  user_id: UserId;
  /** From the identity provider; agents cannot edit these. */
  attributes: Readonly<Record<string, string>>;
}

export interface ExternalIdentity {
  provider: "github" | "slack" | "oidc";
  subject: string; // provider's stable id, e.g. GitHub numeric user id
  /** Display handle, used transiently for provider API lookups. Never stored. */
  login?: string;
}

/** `record_verdict`: a `/verdict` comment (design §4); kept apart from `approve_spec` so it can be granted on its own. */
export type AuthAction = "submit_work" | "approve_spec" | "approve_merge" | "use_tool" | "record_verdict";

export interface AuthResource {
  kind: "project" | "work_item" | "tool";
  id: string;
}

export type AuthDecision = { allow: true } | { allow: false; reason: string };

export interface AuthProvider {
  resolve(identity: ExternalIdentity): Promise<Principal | null>;
  authorize(principal: Principal, action: AuthAction, resource: AuthResource): Promise<AuthDecision>;
}

/** A role on a project (design 2026-11-01). Each grants a fixed set of actions (`ROLE_ACTIONS`, src/core/authorize.ts). */
export type Role = "requester" | "approver";

export const ROLES: readonly Role[] = ["requester", "approver"];

/** One provider account linked to a factory user. Found by provider and subject only, never by display name. */
export interface LinkedAccount {
  provider: ExternalIdentity["provider"];
  subject: string;
}

/** Who a grant source is asked about: the factory user and every account linked to it. */
export interface GrantSubject {
  user_id: UserId;
  accounts: readonly LinkedAccount[];
}

/**
 * A source of roles (plugin kind `grant`, selected by `permissions.grants`; docs/plugins.md, GrantSource).
 * The authorize check takes the union of every selected source's roles, minus any source's deny.
 * `project` is the work item's project key, or null when the resource names none.
 */
export interface GrantSource {
  /** True when `roles` calls a remote API: such sources are asked after local ones, and only if those gave no role. */
  readonly remote: boolean;
  /** An explicit deny for the user on the project. A deny from any source overrides every grant. */
  denies(subject: GrantSubject, project: string | null): Promise<boolean>;
  roles(subject: GrantSubject, project: string | null): Promise<readonly Role[]>;
}
