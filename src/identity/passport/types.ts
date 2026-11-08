// Identity's public types (RFC 0015 §6.2, §8 "Passports"). Names follow the legacy AuthProvider and
// GrantSource (src/interfaces/auth-provider.ts) so the two can be bridged while the legacy code moves.

/** Who vouched for the principal at the edge. `service`: a factory process acting as itself. */
export type Provider = "local" | "github" | "slack" | "oidc" | "service";
/** Where the request entered the factory. */
export type Origin = "cli" | "ui" | "github" | "slack" | "run" | "service";
/** person: authenticated at the edge. run: narrowed for one run. call: narrowed to one tool call. */
export type PassportKind = "person" | "run" | "service" | "call";

/** The identity proof an edge adapter hands to Identity once. Provider and stable subject only, never a display name. */
export interface ExternalIdentity {
  readonly provider: Provider;
  readonly subject: string;
}

export interface Principal {
  /** A factory user id (`local:<email>`, `github:<numeric id>`) or a service name. Never a display name. */
  readonly user_id: string;
}

/** Turns an edge proof into a principal (solo: the local identity; enterprise: OIDC, SSO, linked accounts). */
export interface AuthProvider {
  readonly provider: Provider;
  /** null: the proof names no factory user (refused at the edge). */
  resolve(identity: ExternalIdentity): Promise<Principal | null>;
  /**
   * Enterprise hook (owner decision 2026-11-08): a provider that knows the person's name (an OIDC `name` claim, a
   * GitHub profile) returns it, and `authenticate` stores it once in identity_profiles against the principal. A
   * name the person set in `factory setup` is kept. Not implemented by any provider yet; the local one has none.
   */
  displayName?(identity: ExternalIdentity): Promise<string | null>;
}

export type Action = "submit_work" | "approve_spec" | "approve_merge" | "record_verdict" | "use_tool";
export const ACTIONS: readonly Action[] = ["submit_work", "approve_spec", "approve_merge", "record_verdict", "use_tool"];

/** owner: every action (the solo default). The other two are the legacy roles. */
export type Role = "owner" | "approver" | "requester";

export const ROLE_ACTIONS: Readonly<Record<Role, readonly Action[]>> = {
  owner: ACTIONS,
  approver: ["submit_work", "approve_spec", "approve_merge", "record_verdict", "use_tool"],
  requester: ["submit_work"],
};

/** One account linked to a factory user (identity_user_links). */
export interface LinkedAccount {
  readonly provider: string;
  readonly subject: string;
}

export interface GrantSubject {
  readonly user_id: string;
  readonly accounts: readonly LinkedAccount[];
}

/** A source of roles per project. A deny from any source overrides every grant. */
export interface GrantSource {
  /** True when `roles` calls a remote API: asked after local sources, and only when they gave no covering role. */
  readonly remote: boolean;
  denies(subject: GrantSubject, project: string | null): Promise<boolean>;
  roles(subject: GrantSubject, project: string | null): Promise<readonly Role[]>;
}

/**
 * Caveats one link of a passport adds. Each field present limits the passport to the listed values; an absent
 * field adds no limit at this link. A request must satisfy the caveats of every link, so a later link can
 * only narrow (macaroon style).
 */
export interface Restrictions {
  readonly actions?: readonly Action[];
  readonly projects?: readonly string[];
  readonly items?: readonly string[];
  readonly runs?: readonly string[];
  readonly branches?: readonly string[];
  /** Repository paths: `dir/**` covers everything below dir, `**` everything, anything else one exact path. */
  readonly paths?: readonly string[];
  readonly tools?: readonly string[];
  /** Who may accept the passport (a tool broker, a sandbox proxy). */
  readonly audience?: readonly string[];
}

export const RESTRICTION_KEYS = ["actions", "projects", "items", "runs", "branches", "paths", "tools", "audience"] as const;
export type RestrictionKey = (typeof RESTRICTION_KEYS)[number];

/** What a request touches. Each caveat on a field needs the field named here (fail closed). */
export interface ResourceRef {
  readonly project: string | null;
  readonly item?: string;
  readonly run?: string;
  readonly branch?: string;
  readonly paths?: readonly string[];
  readonly tool?: string;
  readonly audience?: string;
}

export type PassportId = string;

/** A verified passport: the chain's facts, never a secret or a display name. */
export interface Passport {
  readonly id: PassportId;
  readonly parent_id: PassportId | null;
  readonly principal: string;
  readonly provider: Provider;
  readonly origin: Origin;
  readonly kind: PassportKind;
  /** The caveats of every link, root first. */
  readonly chain: readonly Restrictions[];
  readonly issued_at: string;
  /** The earliest expiry along the chain. */
  readonly expires_at: string;
  readonly key_id: string;
}

export interface Issued {
  readonly passport: Passport;
  /** The bearer token (the HMAC chain). Returned once; only its hash is stored. */
  readonly token: string;
}

export type AuthzResult =
  | { readonly allow: true; readonly reason: "allowed"; readonly principal: string; readonly scopes: readonly Restrictions[] }
  | { readonly allow: false; readonly reason: string; readonly principal: string | null };

/** RFC 0015 §6.2: the sync API other components call through identity/index.ts. */
export interface Authorization {
  authorize(passport: PassportId, action: Action, resource: ResourceRef): Promise<AuthzResult>;
  narrow(passport: PassportId, restrictions: NarrowRequest): Promise<Issued>;
}

export interface NarrowRequest extends Restrictions {
  readonly kind: Exclude<PassportKind, "person" | "service">;
  readonly origin?: Origin;
  /** Must not be later than the parent's expiry; defaults to it. */
  readonly expires_at?: string;
}

/**
 * What the ToolBroker (G2) and a sandbox-edge proxy call on every tool call: the run passport's token is
 * verified offline (HMAC chain, revocation list from the last refresh) and the decision is audited.
 */
export interface PassportChecker {
  check(token: string, action: Action, resource: ResourceRef): Promise<AuthzResult>;
}
