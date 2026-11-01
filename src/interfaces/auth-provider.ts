import type { UserId } from "../core/types.js";

// design §8. Called by intake, tool wrappers and the human gate. First impl: NoAuth.

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
