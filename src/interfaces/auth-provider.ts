import type { UserId } from "../core/types.js";

// design §8. Called by intake, tool wrappers and the human gate. Since issue #575 one implementation: the owner check
// (`OwnerAuth`, src/core/authorize.ts). `resolve` maps a provider account to a factory user (linked accounts first);
// `authorize` allows a gate action only to the owner.

export interface Principal {
  user_id: UserId;
  /** From the identity provider; agents cannot edit these. */
  attributes: Readonly<Record<string, string>>;
}

export interface ExternalIdentity {
  /** `local`: an account on the machine the factory runs on (issue #198). */
  provider: "github" | "slack" | "oidc" | "local";
  subject: string; // provider's stable id, e.g. a forge's numeric user id
  /** Display handle, used transiently for provider API lookups. Never stored. */
  login?: string;
  /**
   * The edge passport this identity's command entered with (RFC 0015 §8, Identity): set by the command inbox from
   * the command row. Absent: none (a row from before M9, an actor no provider resolves, a polled source event).
   */
  passport?: CommandPassport;
}

/**
 * A command's edge passport and when the command was recorded (the store's clock). Its expiry is checked at `at`:
 * it proves who sent the command then, however long the command waited in its stream; revocation is checked now.
 */
export interface CommandPassport {
  id: string;
  at: string;
}

/**
 * `record_verdict`: a `/verdict` comment (design §4); kept apart from `approve_spec` so it can be granted on its own.
 * `approve_tool`: approve or revoke a pack tool or MCP server (design 11-packs); the owner's only, no role grants it.
 */
export type AuthAction = "submit_work" | "approve_spec" | "approve_merge" | "use_tool" | "record_verdict" | "approve_tool";

export interface AuthResource {
  kind: "project" | "work_item" | "tool";
  id: string;
}

export type AuthDecision = { allow: true } | { allow: false; reason: string };

export interface AuthProvider {
  resolve(identity: ExternalIdentity): Promise<Principal | null>;
  /**
   * `passport`: the command's edge passport. The controller's wrapper (`AuditedAuthProvider`) has Identity check
   * it before the owner check decides; the owner check ignores it.
   */
  authorize(principal: Principal, action: AuthAction, resource: AuthResource, passport?: CommandPassport): Promise<AuthDecision>;
}

/** A local user's stored role (`identity_local_users`); kept until roles are removed (issue #568, phase 2). It grants nothing. */
export type Role = "requester" | "approver";

/** One provider account linked to a factory user. Found by provider and subject only, never by display name. */
export interface LinkedAccount {
  provider: ExternalIdentity["provider"];
  subject: string;
}
