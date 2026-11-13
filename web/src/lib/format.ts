import { type MessageKey } from "../i18n/en.js";
import { formatInteger, t, withUnit } from "../i18n/index.js";

// Display helpers. Pure: `now` is passed in, so a test can fix it.

/** "12s", "4m", "3h", "2d" since `at`; "–" for none. */
export function ago(at: string | null | undefined, now: number): string {
  if (!at) return t("format.none");
  const s = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (s < 60) return withUnit(s, "s");
  if (s < 3600) return withUnit(Math.floor(s / 60), "m");
  if (s < 86400) return withUnit(Math.floor(s / 3600), "h");
  return withUnit(Math.floor(s / 86400), "d");
}

/** "in 4m" for a time ahead, "now" for one passed; "–" for none. */
export function until(at: string | null | undefined, now: number): string {
  if (!at) return t("format.none");
  const ms = Date.parse(at) - now;
  return ms <= 0 ? t("format.now") : t("format.in", { time: ago(new Date(now - ms).toISOString(), now) });
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** An ISO time as the viewer's local `YYYY-MM-DD HH:MM`, the form the Tasks page shows a due date and time in; the text itself when it is not one. */
export function localDateTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
  if (n === null || n === undefined) return t("format.none");
  if (n >= 1_000_000) return withUnit(n / 1_000_000, "million", true);
  if (n >= 1000) return withUnit(n / 1000, "thousand", true);
  return formatInteger(n);
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
    if (n > 0) parts.push(withUnit(n, unit));
  }
  return parts.length > 0 ? parts.join(" ") : withUnit(0, "s");
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

export const shortRev =(rev: string | null | undefined) => (rev ? rev.slice(0, 7) : t("format.unknown"));

/** The status page's level names (src/ui/priority.ts LEVEL_LABELS), for the same words in both UIs. */
export const LEVEL_LABELS: Record<string, string> = Object.fromEntries(
  ["ready_to_merge", "needs_approval", "needs_you", "needs_triage", "stuck", "running", "queued", "blocked_by_task", "closed"].map((level) => [
    level,
    t(`level.${level}` as MessageKey),
  ]),
);

/**
 * Levels that wait on the operator: the Floor lists them first. Never "Blocked by another task".
 */
export const NEEDS_YOU_LEVELS = ["ready_to_merge", "needs_approval", "needs_you", "needs_triage", "stuck"] as const;

/** "worker 3" for a worker id `<host>:<pid>:<slot>` (its slot number); "a worker" for any other id; "–" for none. */
export function workerName(id: string | null | undefined): string {
  if (!id) return "–";
  const slot = /:(\d+)$/.exec(id)?.[1];
  return slot === undefined ? "a worker" : `worker ${slot}`;
}

/** True for a worker id `<host>:<pid>:<slot>`, as lease owners and attempt records name a worker loop. */
export const isWorkerId = (id: string): boolean => /^[^:\s]+:\d+:\d+$/.test(id);

/** The stage in words, for a row with no stored reason. */
const STAGE_WORDS: Record<string, string> = {
  NEW: "New, not triaged yet",
  READY: "Specced, not started",
  RUNNING: "Being built",
  REVIEW: "In review",
  CLOSED: "Closed",
};

/** "approve", "retry or reject", "approve, revise or reject". */
function orList(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

/**
 * A waiting row with no stored reason: the item's state and what moves it next (the commands the viewer may send
 * now), never an empty or "no reason" text.
 */
export function stateAndNext(stage: string, commands: readonly { name: string; allowed: boolean }[] | undefined): string {
  const names = (commands ?? []).filter((c) => c.allowed && c.name !== "verdict").map((c) => c.name);
  const next = names.length > 0 ? `${orList(names)} it` : "open the item and send the next command";
  return `${STAGE_WORDS[stage] ?? stage}; next: ${next}`;
}

/**
 * The item page's state pill: the list's level words, from the item's stage, block and why code (the item API has
 * no level). Running, queued and held come from the why code; an item nothing moves (`idle`) is "Stuck".
 */
export function detailLevel(i: { stage: string; blocked_on: string; blocked_reason: string | null; why?: { code: string } | undefined }): string {
  if (i.stage === "CLOSED") return "closed";
  if (i.blocked_on === "human" && i.blocked_reason === "merge_pending") return "ready_to_merge";
  if (i.blocked_on === "human" && (i.blocked_reason === "spec_pending" || i.blocked_reason === "max_revisions")) return "needs_approval";
  if (i.blocked_on === "human" || i.blocked_on === "budget") return "needs_you";
  const code = i.why?.code;
  if (code === "running") return "running";
  if (code === "queued" || code === "not_before" || code === "paused") return "queued";
  if (code === "dependency" || code === "phase" || code === "held" || code === "deadlock" || i.blocked_on === "dependency" || i.blocked_on === "upstream") {
    return "blocked_by_task";
  }
  if (code === "idle") return "stuck";
  return i.stage === "RUNNING" || i.stage === "REVIEW" ? "running" : "queued";
}
