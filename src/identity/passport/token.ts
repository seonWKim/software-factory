// The passport token (RFC 0015 §8 "Format"): an HMAC chain, macaroon style, on node:crypto.
//
//   sig_0 = HMAC(signing key, link_0)        link_0: principal, provider, origin, kind, times, caveats
//   sig_i = HMAC(sig_{i-1}, link_i)          link_i: one more set of caveats, never fewer
//   token = "sfp1." + base64url(JSON links) + "." + hex(sig_n)
//
// Only the root needs the key, and the key never leaves its keyring: the keyring signs. Anyone holding a token
// can add a link (narrow it); nobody can remove one, because sig_{i-1} cannot be recovered from sig_i.
// Verification recomputes the chain with the key named by link_0 and compares in constant time.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalRestrictions, checkRestrictions, widens } from "./restrictions.js";
import type { Origin, Passport, PassportKind, Provider, Restrictions } from "./types.js";

/** A signing key held by its keyring. `sign` is HMAC-SHA256 under the key; the key material is never returned. */
export interface SigningKey {
  /** A version id, stored with each passport; safe to show. */
  readonly id: string;
  sign(data: string): string;
}

/** Where passport keys come from (solo: a local key; enterprise: a shared key in the SecretStore, rotated). */
export interface PassportKeyring {
  /** The key new passports are signed with. */
  current(): Promise<SigningKey>;
  /** A key by version, current or retired-but-still-accepted; null when unknown. */
  get(id: string): Promise<SigningKey | null>;
}

export interface Link {
  readonly id: string;
  readonly parent_id: string | null;
  readonly principal: string;
  readonly provider: Provider;
  readonly origin: Origin;
  readonly kind: PassportKind;
  readonly key_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly restrictions: Restrictions;
}

const PREFIX = "sfp1";

/** A link with its fields in one fixed order and its caveats canonical, so the same facts always give the same token. */
export function makeLink(f: Link): Link {
  return {
    id: f.id,
    parent_id: f.parent_id,
    principal: f.principal,
    provider: f.provider,
    origin: f.origin,
    kind: f.kind,
    key_id: f.key_id,
    issued_at: f.issued_at,
    expires_at: f.expires_at,
    restrictions: canonicalRestrictions(f.restrictions),
  };
}

function canonical(l: Link): string {
  return JSON.stringify([
    l.id,
    l.parent_id,
    l.principal,
    l.provider,
    l.origin,
    l.kind,
    l.key_id,
    l.issued_at,
    l.expires_at,
    canonicalRestrictions(l.restrictions),
  ]);
}

function chainSig(rootSig: string, links: readonly Link[]): string {
  let sig = rootSig;
  for (const l of links) sig = createHmac("sha256", Buffer.from(sig, "hex")).update(canonical(l)).digest("hex");
  return sig;
}

function encode(links: readonly Link[], sig: string): string {
  return `${PREFIX}.${Buffer.from(JSON.stringify(links)).toString("base64url")}.${sig}`;
}

/** sha256 of the token: what the store keeps instead of the token. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Signs a root link with `key`. */
export function mintToken(key: SigningKey, root: Link): string {
  if (root.parent_id !== null || root.key_id !== key.id) throw new Error("a root link has no parent and names its signing key");
  checkRestrictions(root.restrictions);
  const l = makeLink(root);
  return encode([l], chainSig(key.sign(canonical(l)), []));
}

/** Adds a link to a token without any key. The caller has checked the token; this only refuses a malformed link. */
export function attenuateToken(token: string, link: Link): string {
  const { links, sig } = decode(token);
  const parent = links[links.length - 1]!;
  const problem = linkProblem(links, link, parent);
  if (problem) throw new Error(`cannot narrow: ${problem}`);
  const l = makeLink(link);
  return encode([...links, l], chainSig(sig, [l]));
}

function linkProblem(chain: readonly Link[], link: Link, parent: Link): string | null {
  if (link.parent_id !== parent.id) return "parent mismatch";
  if (link.principal !== parent.principal || link.provider !== parent.provider || link.key_id !== parent.key_id) return "principal changed";
  if (link.expires_at > parent.expires_at) return "expiry widened";
  try {
    checkRestrictions(link.restrictions);
  } catch (err) {
    return (err as Error).message;
  }
  const key = widens(chain.map((l) => l.restrictions), link.restrictions);
  return key ? `restriction ${key} widened` : null;
}

function decode(token: string): { links: Link[]; sig: string } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || !/^[0-9a-f]{64}$/.test(parts[2]!)) throw new Error("malformed token");
  const links = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Link[];
  if (!Array.isArray(links) || links.length === 0) throw new Error("malformed token");
  return { links, sig: parts[2]! };
}

export type Verified = { ok: true; passport: Passport; links: readonly Link[] } | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" | "expired"; links: readonly Link[] | null };

/**
 * Verifies a token offline: the chain's signature under the key its root names, each link narrowing the one
 * before, and `now` before every link's expiry. Revocation is the caller's check (it needs the deny list).
 */
export async function verifyToken(keys: PassportKeyring, token: string, now: string): Promise<Verified> {
  let decoded: { links: Link[]; sig: string };
  try {
    decoded = decode(token);
  } catch {
    return { ok: false, reason: "malformed", links: null };
  }
  const { links, sig } = decoded;
  const root = links[0]!;
  if (root.parent_id !== null) return { ok: false, reason: "malformed", links };
  for (let i = 1; i < links.length; i++) if (linkProblem(links.slice(0, i), links[i]!, links[i - 1]!)) return { ok: false, reason: "malformed", links };
  const key = await keys.get(root.key_id);
  if (!key) return { ok: false, reason: "unknown_key", links };
  const expected = Buffer.from(chainSig(key.sign(canonical(root)), links.slice(1)), "hex");
  if (!timingSafeEqual(expected, Buffer.from(sig, "hex"))) return { ok: false, reason: "bad_signature", links };
  const last = links[links.length - 1]!;
  if (now >= last.expires_at) return { ok: false, reason: "expired", links };
  return { ok: true, links, passport: passportOf(links) };
}

/** The passport a verified chain describes. */
export function passportOf(links: readonly Link[]): Passport {
  const root = links[0]!;
  const last = links[links.length - 1]!;
  return {
    id: last.id,
    parent_id: last.parent_id,
    principal: root.principal,
    provider: root.provider,
    origin: last.origin,
    kind: last.kind,
    chain: links.map((l) => canonicalRestrictions(l.restrictions)),
    issued_at: last.issued_at,
    expires_at: last.expires_at,
    key_id: root.key_id,
  };
}
