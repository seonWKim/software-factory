import type { UserId } from "../core/types.js";

// design §8. Called by intake, tool wrappers and the human gate. One implementation: the owner check (`OwnerAuth`,
// src/core/authorize.ts; design 08-permissions, One owner). `resolve` maps a provider account to a factory user
// (linked accounts first); `authorize` allows the store's local owner only.

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
}

/**
 * `record_verdict`: a `/verdict` comment (design §4); kept apart from `approve_spec` so it can be granted on its own.
 * `approve_tool`: approve or revoke a pack tool or MCP server (design 11-packs).
 */
export type AuthAction = "submit_work" | "approve_spec" | "approve_merge" | "use_tool" | "record_verdict" | "approve_tool";

export interface AuthResource {
  kind: "project" | "work_item" | "tool";
  id: string;
}

export type AuthDecision = { allow: true } | { allow: false; reason: string };

export interface AuthProvider {
  resolve(identity: ExternalIdentity): Promise<Principal | null>;
  /** A person's command carries no passport: the owner check decides it and audits the decision (passport `none`). */
  authorize(principal: Principal, action: AuthAction, resource: AuthResource): Promise<AuthDecision>;
}

/** One provider account linked to a factory user. Found by provider and subject only, never by display name. */
export interface LinkedAccount {
  provider: ExternalIdentity["provider"];
  subject: string;
}

