// The passport service (RFC 0015 §7 Identity, §8 Passports). It authenticates once at the edge through an
// AuthProvider, answers authorize() from the passport's caveats and the GrantSources' roles, narrows passports
// for runs and tool calls, keeps the deny list, and writes every decision to authz_audit.
//
// Time comes only from Identity's `revocations` tick (no-clock rule): each tick sets the service's clock and
// reloads the deny list. A passport is therefore accepted up to one tick period past its expiry, and another
// replica's revocation reaches this one on its next tick (its own revocations apply at once).

import { randomUUID } from "node:crypto";
import type { TickGenerator } from "../../shared/ticks/tick-generator.js";
import type { SqlExecutor } from "../../state/index.js";
import { ProfileStore, checkDisplayName } from "../profiles/profiles.js";
import { checkRestrictions, outside } from "./restrictions.js";
import { PassportStore } from "./store.js";
import { attenuateToken, makeLink, mintToken, passportOf, tokenHash, verifyToken, type Link, type PassportKeyring } from "./token.js";
import {
  ROLE_ACTIONS,
  type Action,
  type AuthProvider,
  type Authorization,
  type AuthzResult,
  type ExternalIdentity,
  type GrantSource,
  type GrantSubject,
  type Issued,
  type NarrowRequest,
  type Origin,
  type PassportChecker,
  type PassportId,
  type ResourceRef,
  type Restrictions,
} from "./types.js";

/** Actions any authenticated user may take unless a grant source denies them (as in the legacy check). */
const OPEN_ACTIONS: readonly Action[] = ["submit_work"];

export const REVOCATIONS_TICK = "revocations";

export interface IdentityOptions {
  readonly db: SqlExecutor;
  readonly keys: PassportKeyring;
  /** One per provider; a proof whose provider has none is refused. */
  readonly providers: readonly AuthProvider[];
  /** In order; local sources are asked before remote ones. */
  readonly grants: readonly GrantSource[];
  readonly ticks: TickGenerator;
  /** Period of the `revocations` tick: how stale the clock and another replica's deny list may be. Default 10s. */
  readonly refreshMs?: number;
  /** Lifetime of a person passport when the caller names none. Default 1 hour. */
  readonly personTtlMs?: number;
  /** The longest lifetime a person passport may ask for. Default 7 days. */
  readonly maxTtlMs?: number;
  /** Passport ids; random by default. */
  readonly newId?: () => string;
}

export class NotAuthenticated extends Error {}

type Chain = { ok: true; links: readonly Link[] } | { ok: false; reason: string; principal: string | null; links: readonly Link[] | null };

export class PassportService implements Authorization, PassportChecker {
  private readonly store: PassportStore;
  private readonly profiles: ProfileStore;
  private readonly personTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly newId: () => string;
  private clock: string | null = null;
  private revoked = new Set<string>();

  constructor(private readonly o: IdentityOptions) {
    this.store = new PassportStore(o.db);
    this.profiles = new ProfileStore(o.db);
    this.personTtlMs = o.personTtlMs ?? 3_600_000;
    this.maxTtlMs = o.maxTtlMs ?? 7 * 86_400_000;
    this.newId = o.newId ?? (() => `pp_${randomUUID()}`);
    o.ticks.schedule(REVOCATIONS_TICK, o.refreshMs ?? 10_000, async (tick) => {
      this.revoked = await this.store.liveRevocations(tick.now);
      this.clock = tick.now;
    });
  }

  private now(): string {
    if (this.clock === null) throw new Error("identity has had no tick yet: start its TickGenerator first");
    return this.clock;
  }

  /** Edge authentication: the proof's provider resolves it to a principal, which gets a person passport. */
  async authenticate(identity: ExternalIdentity, origin: Origin, opts: { ttl_ms?: number; restrictions?: Restrictions } = {}): Promise<Issued> {
    const now = this.now();
    const provider = this.o.providers.find((p) => p.provider === identity.provider);
    const principal = provider ? await provider.resolve(identity) : null;
    if (!principal) throw new NotAuthenticated(`no ${identity.provider} identity resolves to a factory user`);
    // The enterprise hook: a provider that knows the person's name hands it over here, stored once by id.
    const name = await provider!.displayName?.(identity);
    const checked = name ? checkDisplayName(name) : null;
    if (checked?.ok) await this.profiles.set(principal.user_id, checked.name, identity.provider, now);
    const ttl = Math.min(opts.ttl_ms ?? this.personTtlMs, this.maxTtlMs);
    if (!(ttl > 0)) throw new Error("a passport needs a positive lifetime");
    const key = await this.o.keys.current();
    const root = makeLink({
      id: this.newId(),
      parent_id: null,
      principal: principal.user_id,
      provider: identity.provider,
      origin,
      kind: "person",
      key_id: key.id,
      issued_at: now,
      expires_at: plusMs(now, ttl),
      restrictions: opts.restrictions ?? {},
    });
    const token = mintToken(key, root);
    await this.store.insert(root, tokenHash(token));
    return { token, passport: passportOf([root]) };
  }

  /**
   * A narrower passport from `passport`: a run passport (project, item, run, branch, paths, tools, audience,
   * expiry = the run's deadline) or a per-call token (one tool). Throws when the parent is not valid now or
   * the request would widen any of its caveats or its expiry.
   */
  async narrow(passport: PassportId, req: NarrowRequest): Promise<Issued> {
    const now = this.now();
    const { kind, origin, expires_at, ...restrictions } = req;
    checkRestrictions(restrictions);
    const parent = await this.chainById(passport, now);
    if (!parent.ok) throw new Error(`cannot narrow ${passport}: ${parent.reason}`);
    const last = parent.links[parent.links.length - 1]!;
    if (expires_at !== undefined && expires_at > last.expires_at) throw new Error(`cannot narrow ${passport}: expiry widened`);
    const link = makeLink({
      id: this.newId(),
      parent_id: last.id,
      principal: last.principal,
      provider: last.provider,
      origin: origin ?? (kind === "run" ? "run" : last.origin),
      kind,
      key_id: last.key_id,
      issued_at: now,
      expires_at: expires_at ?? last.expires_at,
      restrictions,
    });
    let token = mintToken((await this.o.keys.get(parent.links[0]!.key_id))!, parent.links[0]!);
    for (const l of [...parent.links.slice(1), link]) token = attenuateToken(token, l);
    await this.store.insert(link, tokenHash(token));
    return { token, passport: passportOf([...parent.links, link]) };
  }

  /** Decides on a stored passport by id (messages carry ids). Audited. */
  async authorize(passport: PassportId, action: Action, resource: ResourceRef): Promise<AuthzResult> {
    const now = this.now();
    return this.decide(passport, await this.chainById(passport, now), action, resource, now);
  }

  /** Decides on a bearer token, offline: signature, expiry, the deny list of the last refresh. Audited. */
  async check(token: string, action: Action, resource: ResourceRef): Promise<AuthzResult> {
    const now = this.now();
    const v = await verifyToken(this.o.keys, token, now);
    const id = v.links?.[v.links.length - 1]?.id ?? "unknown";
    let chain: Chain;
    if (!v.ok) chain = { ok: false, reason: v.reason, principal: v.links?.[0]?.principal ?? null, links: v.links };
    else if (v.links.some((l) => this.revoked.has(l.id))) chain = { ok: false, reason: "revoked", principal: v.passport.principal, links: v.links };
    else chain = { ok: true, links: v.links };
    return this.decide(id, chain, action, resource, now);
  }

  /** Puts a passport, and so every passport narrowed from it, on the deny list. */
  async revoke(passport: PassportId, by: string, reason: string): Promise<void> {
    const row = await this.store.get(passport);
    if (!row) throw new Error(`unknown passport ${passport}`);
    await this.store.revoke(passport, by, reason, this.now(), row.expires_at);
    this.revoked.add(passport);
  }

  /**
   * The stored chain of `id`, re-signed with the key and compared with the stored token hash, so a row
   * edited in the store (a widened caveat, a later expiry, another principal) is refused as tampered.
   */
  private async chainById(id: PassportId, now: string): Promise<Chain> {
    const rows = await this.store.chain(id);
    if (!rows) return { ok: false, reason: "unknown_passport", principal: null, links: null };
    const links = rows.map((r) => makeLink(r));
    const principal = links[0]!.principal;
    const key = await this.o.keys.get(links[0]!.key_id);
    if (!key) return { ok: false, reason: "unknown_key", principal, links };
    let token: string;
    try {
      token = mintToken(key, links[0]!);
      if (tokenHash(token) !== rows[0]!.token_hash) return { ok: false, reason: "tampered", principal, links };
      for (let i = 1; i < links.length; i++) {
        token = attenuateToken(token, links[i]!);
        if (tokenHash(token) !== rows[i]!.token_hash) return { ok: false, reason: "tampered", principal, links };
      }
    } catch {
      return { ok: false, reason: "tampered", principal, links };
    }
    if (now >= links[links.length - 1]!.expires_at) return { ok: false, reason: "expired", principal, links };
    if (await this.store.isRevoked(links.map((l) => l.id))) return { ok: false, reason: "revoked", principal, links };
    return { ok: true, links };
  }

  private async decide(passport_id: string, chain: Chain, action: Action, resource: ResourceRef, at: string): Promise<AuthzResult> {
    let result: AuthzResult;
    if (!chain.ok) result = { allow: false, reason: chain.reason, principal: chain.principal };
    else {
      const principal = chain.links[0]!.principal;
      const scopes = chain.links.map((l) => l.restrictions);
      const broken = outside(scopes, action, resource);
      const granted = broken ? `outside_${broken}` : await this.grantsAllow(principal, action, resource.project);
      result = granted === "allowed" ? { allow: true, reason: "allowed", principal, scopes } : { allow: false, reason: granted, principal };
    }
    await this.store.audit({
      passport_id,
      principal: result.principal ?? "unknown",
      action,
      resource,
      decision: result.allow ? "allow" : "deny",
      reason: result.reason,
      at,
    });
    return result;
  }

  /** The legacy rule: any deny refuses; open actions pass; else a role covering the action, local sources first. */
  private async grantsAllow(user_id: string, action: Action, project: string | null): Promise<string> {
    const subject: GrantSubject = { user_id, accounts: await this.store.accounts(user_id) };
    for (const g of this.o.grants) if (await g.denies(subject, project)) return "denied";
    if (OPEN_ACTIONS.includes(action)) return "allowed";
    const ordered = [...this.o.grants.filter((g) => !g.remote), ...this.o.grants.filter((g) => g.remote)];
    for (const g of ordered) {
      const roles = await g.roles(subject, project);
      if (roles.some((r) => ROLE_ACTIONS[r].includes(action))) return "allowed";
    }
    return "no_role";
  }
}

function plusMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}
