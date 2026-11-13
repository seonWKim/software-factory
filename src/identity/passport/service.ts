// The passport service (RFC 0015 §7 Identity, §8 Passports). It authenticates once at the edge through an
// AuthProvider, answers authorize() from the passport's caveats and the principal's role, narrows passports
// for runs and tool calls, keeps the deny list, and writes every decision to authz_audit.
//
// Time comes only from Identity's `revocations` tick (no-clock rule): each tick sets the service's clock and
// reloads the deny list. A passport is therefore accepted up to one tick period past its expiry, and another
// replica's revocation reaches this one on its next tick (its own revocations apply at once).

import { randomUUID } from "node:crypto";
import type { TickGenerator } from "../../shared/ticks/tick-generator.js";
import { addMs } from "../../shared/time.js";
import type { SqlExecutor } from "../../state/index.js";
import { ANONYMOUS_USER } from "../plugins/local/local-identity.js";
import { SERVICE_PREFIX, ServiceAuthProvider, serviceRestrictions, type ServiceName } from "../plugins/service/service-identity.js";
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
  type Issued,
  type NarrowRequest,
  type Origin,
  type PassportChecker,
  type PassportId,
  type ResourceRef,
  type RoleCheck,
  type Restrictions,
} from "./types.js";

/** Actions any authenticated user may take. */
const OPEN_ACTIONS: readonly Action[] = ["submit_work"];

export const REVOCATIONS_TICK = "revocations";

/** A service passport's lifetime: a run passport narrowed from it gets at least half of it (12h) ahead. */
const SERVICE_TTL_MS = 24 * 3_600_000;

export interface IdentityOptions {
  readonly db: SqlExecutor;
  readonly keys: PassportKeyring;
  /** One per provider; a proof whose provider has none is refused. */
  readonly providers: readonly AuthProvider[];
  /**
   * The principal that holds the owner role beside the service principals. Absent in a running factory: a person's
   * command takes the owner check instead (design 08-permissions, One owner). `local:anonymous` never holds it.
   */
  readonly owner?: string;
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
  private readonly providers: readonly AuthProvider[];
  private readonly refreshMs: number;
  /** This replica's own service passports, reissued before they expire. Each replica holds its own. */
  private readonly services = new Map<ServiceName, Issued>();
  private clock: string | null = null;
  private revoked = new Set<string>();

  constructor(private readonly o: IdentityOptions) {
    // The service provider is built in: a component acting as itself needs no configuration.
    this.providers = [new ServiceAuthProvider(), ...o.providers.filter((p) => p.provider !== "service")];
    this.refreshMs = o.refreshMs ?? 10_000;
    this.store = new PassportStore(o.db);
    this.profiles = new ProfileStore(o.db);
    this.personTtlMs = o.personTtlMs ?? 3_600_000;
    this.maxTtlMs = o.maxTtlMs ?? 7 * 86_400_000;
    this.newId = o.newId ?? (() => `pp_${randomUUID()}`);
    let ticked!: () => void;
    this.firstTick = new Promise((resolve) => (ticked = resolve));
    o.ticks.schedule(REVOCATIONS_TICK, this.refreshMs, async (tick) => {
      this.revoked = await this.store.liveRevocations(tick.now);
      this.clock = tick.now;
      ticked();
    });
  }

  private readonly firstTick: Promise<void>;

  /** Resolves after the first `revocations` tick: from then on the service has a time and a deny list. */
  ready(): Promise<void> {
    return this.firstTick;
  }

  private now(): string {
    if (this.clock === null) throw new Error("identity has had no tick yet: start its TickGenerator first");
    return this.clock;
  }

  /** Edge authentication: the proof's provider resolves it to a principal, which gets a person passport. */
  async authenticate(identity: ExternalIdentity, origin: Origin, opts: { ttl_ms?: number; restrictions?: Restrictions } = {}): Promise<Issued> {
    const now = this.now();
    const provider = this.providers.find((p) => p.provider === identity.provider);
    const principal = provider ? await provider.resolve(identity) : null;
    if (!principal) throw new NotAuthenticated(`no ${identity.provider} identity resolves to a factory user`);
    // A service principal comes only from the service provider: a person's proof never mints one.
    if (principal.user_id.startsWith(SERVICE_PREFIX) !== (identity.provider === "service")) {
      throw new NotAuthenticated(`a ${identity.provider} identity cannot be ${principal.user_id}`);
    }
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
      expires_at: addMs(now, ttl),
      restrictions: opts.restrictions ?? {},
    });
    const token = mintToken(key, root);
    await this.store.insert(root, tokenHash(token));
    return { token, passport: passportOf([root]) };
  }

  /**
   * This replica's passport for a component acting with no person behind it, limited to that service's actions
   * (SERVICE_ACTIONS). It lasts SERVICE_TTL_MS (capped by maxTtlMs) and is reissued once half of that has passed
   * or it is revoked, so a run passport narrowed from it always has at least half the lifetime ahead.
   */
  async service(name: ServiceName): Promise<Issued> {
    const now = this.now();
    const ttl = Math.min(SERVICE_TTL_MS, this.maxTtlMs);
    const held = this.services.get(name);
    if (held && addMs(now, ttl / 2) < held.passport.expires_at && !this.revoked.has(held.passport.id)) return held;
    const issued = await this.authenticate({ provider: "service", subject: name }, "service", { ttl_ms: ttl, restrictions: serviceRestrictions(name) });
    this.services.set(name, issued);
    return issued;
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
  async authorize(passport: PassportId, action: Action, resource: ResourceRef, roles?: RoleCheck, valid_at?: string): Promise<AuthzResult> {
    const now = this.now();
    // A command's passport proves who sent it when it was recorded: expiry is checked then (never later than now),
    // revocation now.
    const at = valid_at !== undefined && valid_at < now ? valid_at : now;
    return this.decide(passport, await this.chainById(passport, at), action, resource, now, roles);
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

  /**
   * Records a decision taken outside Identity, so authz_audit holds every decision while the legacy authorize
   * (src/core/authorize.ts) still decides commands. `passport_id` is the command's edge passport when known.
   */
  async record(e: { passport_id: PassportId | null; principal: string; action: Action; resource: ResourceRef; allow: boolean; reason: string }): Promise<void> {
    await this.store.audit({
      passport_id: e.passport_id ?? "none",
      principal: e.principal,
      action: e.action,
      resource: e.resource,
      decision: e.allow ? "allow" : "deny",
      reason: e.reason,
      at: this.now(),
    });
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

  private async decide(passport_id: string, chain: Chain, action: Action, resource: ResourceRef, at: string, roles?: RoleCheck): Promise<AuthzResult> {
    let result: AuthzResult;
    if (!chain.ok) result = { allow: false, reason: chain.reason, principal: chain.principal };
    else {
      const principal = chain.links[0]!.principal;
      const scopes = chain.links.map((l) => l.restrictions);
      const broken = outside(scopes, action, resource);
      const granted = broken ? `outside_${broken}` : roles ? await roles(principal) : this.roleAllows(principal, action);
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

  /**
   * Open actions pass; else the owner role covers the action. A service principal holds the owner role: its passport's
   * `actions` caveat is what limits it, safe because only the `service` provider resolves a `service:` principal
   * (authenticate). The `owner` option holds it too, never `local:anonymous`. Anyone else: `no_role`.
   */
  private roleAllows(user_id: string, action: Action): string {
    if (OPEN_ACTIONS.includes(action)) return "allowed";
    const owner = user_id.startsWith(SERVICE_PREFIX) || (user_id === this.o.owner && user_id !== ANONYMOUS_USER);
    return owner && ROLE_ACTIONS.owner.includes(action) ? "allowed" : "no_role";
  }
}
