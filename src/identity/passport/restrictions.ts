// Caveats (RFC 0015 §8): a request must satisfy every link's restrictions, and a new link may only narrow.
// Pure functions: no I/O, no clock.

import { RESTRICTION_KEYS, type Action, type ResourceRef, type RestrictionKey, type Restrictions } from "./types.js";

/** A path pattern is `**`, `dir/**`, or one exact relative path; never absolute, never with `..` or empty parts. */
export function validPathPattern(p: string): boolean {
  if (p === "**") return true;
  const body = p.endsWith("/**") ? p.slice(0, -3) : p;
  return body !== "" && !body.startsWith("/") && body.split("/").every((s) => s !== "" && s !== "." && s !== ".." && s !== "**");
}

/** Whether pattern `p` covers path or pattern `x` (both valid). */
export function pathCovers(p: string, x: string): boolean {
  if (p === "**") return true;
  if (x === "**") return false;
  if (!p.endsWith("/**")) return p === x;
  const dir = p.slice(0, -3);
  const target = x.endsWith("/**") ? x.slice(0, -3) : x;
  return target === dir || target.startsWith(`${dir}/`);
}

function covers(key: RestrictionKey, parent: readonly string[], child: readonly string[]): boolean {
  if (key === "paths") return child.every((c) => parent.some((p) => pathCovers(p, c)));
  return child.every((c) => parent.includes(c));
}

/** Checks a link's own caveats: lists of non-empty strings, valid path patterns. Throws on a malformed one. */
export function checkRestrictions(r: Restrictions): void {
  for (const key of Object.keys(r)) {
    if (!(RESTRICTION_KEYS as readonly string[]).includes(key)) throw new Error(`unknown restriction "${key}"`);
  }
  for (const key of RESTRICTION_KEYS) {
    const v = r[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s !== "")) throw new Error(`restriction ${key} must be a list of non-empty strings`);
    if (key === "paths") for (const p of v as readonly string[]) if (!validPathPattern(p)) throw new Error(`restriction paths: ${JSON.stringify(p)} is not a relative path or dir/**`);
  }
}

/**
 * The first caveat in `chain` that `child` would widen, or null. A child that leaves a field out adds no limit
 * there, and still inherits the chain's; a child that names a field must stay inside every link that names it.
 */
export function widens(chain: readonly Restrictions[], child: Restrictions): RestrictionKey | null {
  for (const key of RESTRICTION_KEYS) {
    const c = child[key];
    if (c === undefined) continue;
    for (const link of chain) {
      const p = link[key];
      if (p !== undefined && !covers(key, p, c)) return key;
    }
  }
  return null;
}

function resourceValues(key: RestrictionKey, action: Action, r: ResourceRef): readonly string[] | undefined {
  switch (key) {
    case "actions":
      return [action];
    case "projects":
      return r.project === null ? undefined : [r.project];
    case "items":
      return r.item === undefined ? undefined : [r.item];
    case "runs":
      return r.run === undefined ? undefined : [r.run];
    case "branches":
      return r.branch === undefined ? undefined : [r.branch];
    case "paths":
      return r.paths;
    case "tools":
      return r.tool === undefined ? undefined : [r.tool];
    case "audience":
      return r.audience === undefined ? undefined : [r.audience];
  }
}

/**
 * The first caveat of `chain` the request breaks, or null when every link allows it. A caveat on a field the
 * resource does not name is broken: a run passport limited to paths never authorizes a request that names none.
 */
export function outside(chain: readonly Restrictions[], action: Action, resource: ResourceRef): RestrictionKey | null {
  for (const link of chain) {
    for (const key of RESTRICTION_KEYS) {
      const allowed = link[key];
      if (allowed === undefined) continue;
      const values = resourceValues(key, action, resource);
      if (values === undefined || values.length === 0) return key;
      if (key === "paths" && !values.every(validPathPattern)) return key;
      if (!covers(key, allowed, values)) return key;
    }
  }
  return null;
}

/** Restrictions with keys in a fixed order and lists sorted, so the signed text of a link is canonical. */
export function canonicalRestrictions(r: Restrictions): Restrictions {
  const out: Record<string, readonly string[]> = {};
  for (const key of RESTRICTION_KEYS) {
    const v = r[key];
    if (v !== undefined) out[key] = [...new Set(v)].sort();
  }
  return out as Restrictions;
}
