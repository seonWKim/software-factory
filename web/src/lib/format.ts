// Display helpers. Pure: `now` is passed in, so a test can fix it.

/** "12s", "4m", "3h", "2d" since `at`; "–" for none. */
export function ago(at: string | null | undefined, now: number): string {
  if (!at) return "–";
  const s = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** "in 4m" for a time ahead, "now" for one passed; "–" for none. */
export function until(at: string | null | undefined, now: number): string {
  if (!at) return "–";
  const ms = Date.parse(at) - now;
  return ms <= 0 ? "now" : `in ${ago(new Date(now - ms).toISOString(), now)}`;
}

/** A local item id: `local-` (or `local-filed-`), its hex id, then its phase suffixes (`-phase-N`, nested). */
const LOCAL_ID = /^local-(?:filed-)?([0-9a-f]{8})[0-9a-f-]*?((?:-phase-\d+)*)$/;

/**
 * "#192" for "owner/repo#192"; "30331a68" for "local-30331a68-…" and "30331a68-p3-p2" for its phases (the first
 * 8 characters after `local-`, so a narrow screen fits the row); the id as is otherwise.
 */
export function shortSource(id: string): string {
  const i = id.lastIndexOf("#");
  if (i >= 0) return id.slice(i);
  const m = LOCAL_ID.exec(id);
  return m ? m[1]! + m[2]!.replaceAll("-phase-", "-p") : id;
}

/** 38521431 → "38.5M"; 29285 → "29.3k". */
export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const DURATION_UNITS = [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000], ["ms", 1]] as const;

/** 5400000 → "1h 30m"; 1800000 → "30m"; 1500 → "1s 500ms"; 0 → "0s". Every non-zero unit, largest first. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return String(ms);
  const parts: string[] = [];
  let left = Math.round(ms);
  for (const [unit, size] of DURATION_UNITS) {
    const n = Math.floor(left / size);
    left -= n * size;
    if (n > 0) parts.push(`${n}${unit}`);
  }
  return parts.length > 0 ? parts.join(" ") : "0s";
}

/** True only for an absolute http: or https: URL: the only links the app draws from stored text. */
export function isHttpUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

export const shortRev =(rev: string | null | undefined) => (rev ? rev.slice(0, 7) : "unknown");

/** The status page's level names (src/ui/priority.ts LEVEL_LABELS), for the same words in both UIs. */
export const LEVEL_LABELS: Record<string, string> = {
  ready_to_merge: "Ready to merge",
  needs_approval: "Needs approval",
  needs_human: "Needs a human",
  stuck: "Stuck",
  running: "Running",
  queued: "Queued",
  waiting_on_issue: "Waiting on another issue",
  closed: "Closed",
};

/** Levels that wait on the operator: the Floor lists them first. */
export const NEEDS_YOU_LEVELS = ["ready_to_merge", "needs_approval", "needs_human", "stuck"] as const;
