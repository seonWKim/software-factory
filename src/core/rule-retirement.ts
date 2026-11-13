// Retire suggestions for the Rules page's Applied group (design 07-self-improvement.md and 09-dashboard-app.md):
// which promoted rules look ready to retire, each with its reason. Pure: it reads only what the caller hands it (the
// rule's block, the other applied rules, its class's incident count from `evolve show`, whether a repo path exists and
// today) and makes no model call. A suggestion is never acted on here: only the owner's Retire verdict retires a rule.

/** Days since its judged date before a rule with no new incident is suggested as stale (fixed, decision 1). */
export const STALE_DAYS = 30;

/** The shorter of two rules' defaults must be this long before one covering the other counts as a duplicate. */
export const DUPLICATE_MIN_CHARS = 20;

/** The repo folders a rule's path must start with to be checked against this checkout. */
export const REPO_FOLDERS = ["src/", "web/", "docs/", "prompts/", "tests/", "scripts/"] as const;

/** An applied rule as the suggestions read it: its block's parts (a part the block lacks is absent). */
export interface RetireRule {
  readonly id: string;
  readonly default: string;
  readonly exceptions?: string;
  readonly scope?: string;
  /** The T- IDs on the block's `근거` line. */
  readonly incidents?: readonly string[];
  /** The block's `판정일` (YYYY-MM-DD). */
  readonly judged?: string;
}

export interface RetireInputs {
  /** Every applied rule, `rule` among them or not; the others are checked for covering it. */
  readonly applied: readonly RetireRule[];
  /** How many incidents `evolve show` counts for the class now; absent when it could not be read (no stale check). */
  readonly incidents?: number;
  /** Whether a repo-relative path exists in this checkout. */
  readonly exists: (path: string) => boolean;
  readonly now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Lower case, runs of space as one space, trimmed. */
const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** A path under one of the repo folders, not inside a longer word or path. */
const REPO_PATH = new RegExp(`(?<![\\w./-])(?:${REPO_FOLDERS.map((f) => f.replace("/", "\\/")).join("|")})[\\w./-]*`, "g");

/** Each repo path `text` names, in order, without a trailing dot, comma or slash. */
export function repoPaths(text: string): string[] {
  return [...new Set([...text.matchAll(REPO_PATH)].map((m) => m[0].replace(/[.,/]+$/, "")))];
}

/** Stale: judged at least STALE_DAYS ago and its class has no incident beyond those on its `근거` line. */
function stale(rule: RetireRule, o: RetireInputs): string | null {
  if (rule.judged === undefined || o.incidents === undefined) return null;
  const judged = Date.parse(`${rule.judged}T00:00:00Z`);
  if (Number.isNaN(judged)) return null;
  const days = Math.floor((o.now.getTime() - judged) / DAY_MS);
  if (days < STALE_DAYS || o.incidents > (rule.incidents?.length ?? 0)) return null;
  return `no new incident for ${days} days since judged on ${rule.judged}`;
}

/** Duplicate: another applied rule's default equals this one's or contains it, normalized, the shorter long enough. */
function duplicates(rule: RetireRule, applied: readonly RetireRule[]): string[] {
  const mine = normalize(rule.default);
  return applied
    .filter((other) => {
      if (other.id === rule.id) return false;
      const theirs = normalize(other.default);
      return Math.min(mine.length, theirs.length) >= DUPLICATE_MIN_CHARS && theirs.includes(mine);
    })
    .map((other) => `covered by ${other.id}`);
}

/** Gone from the repo: each path under a repo folder its default, exceptions or scope names that this checkout lacks. */
function gone(rule: RetireRule, exists: (path: string) => boolean): string[] {
  const text = [rule.default, rule.exceptions ?? "", rule.scope ?? ""].join("\n");
  return repoPaths(text).filter((p) => !exists(p)).map((p) => `names ${p}, which this repo does not have`);
}

/** Why `rule` looks ready to retire: one reason per signal it meets (stale, duplicate, gone from the repo); none: []. */
export function retireSuggestions(rule: RetireRule, o: RetireInputs): string[] {
  const old = stale(rule, o);
  return [...(old === null ? [] : [old]), ...duplicates(rule, o.applied), ...gone(rule, o.exists)];
}
