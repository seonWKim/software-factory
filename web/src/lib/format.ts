import type { Why } from "../api.js";
import { type MessageKey, en } from "../i18n/en.js";
import { formatInteger, locale, t, withUnit } from "../i18n/index.js";

// Display helpers. Pure: `now` is passed in, so a test can fix it.

/**
 * The one relative time, compact: "just now" within a minute either way, "4m ago" / "3h ago" / "2d ago" for the past,
 * "in 4m" for the future; "–" for none. A caller puts the exact local time (`localDateTime`) in the element's title.
 */
export function relativeTime(at: string | null | undefined, now: number): string {
  if (!at) return t("format.none");
  const ms = Date.parse(at) - now;
  const s = Math.floor(Math.abs(ms) / 1000);
  if (s < 60) return t("time.justNow");
  const span = s < 3600 ? withUnit(Math.floor(s / 60), "m") : s < 86400 ? withUnit(Math.floor(s / 3600), "h") : withUnit(Math.floor(s / 86400), "d");
  return t(ms > 0 ? "time.in" : "time.ago", { time: span });
}

/** The internal names that have a catalog label: field names, reason codes and permissions. */
const TERM_KEYS: Readonly<Record<string, MessageKey>> = {
  agent_needs_human: "term.agent_needs_human",
  approve_merge: "term.approve_merge",
  approve_spec: "term.approve_spec",
  allowed_paths: "term.allowed_paths",
  blocked_on: "term.blocked_on",
  checks_failed: "term.checks_failed",
  rule_of_two: "term.rule_of_two",
  spec_conflict: "term.spec_conflict",
  token_cost: "term.token_cost",
};

/** An internal name (a field, reason or command code) in words: its catalog label (`term.<code>`), else the code with spaces for underscores. */
export function termLabel(code: string): string {
  const key = TERM_KEYS[code];
  return key ? t(key) : code.replaceAll("_", " ");
}

/** A run error's code in words: its term label, else its failure title, else the code with spaces for underscores. */
export function errorLabel(code: string): string {
  const title = `failure.${code}.title`;
  return code in TERM_KEYS || !(title in en) ? termLabel(code) : t(title as MessageKey);
}

const RUN_STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
  queued: "run.status.queued",
  running: "run.status.running",
  succeeded: "run.status.succeeded",
  failed: "run.status.failed",
  canceled: "run.status.canceled",
};

/** A run's status in one form each ("Succeeded", "Failed", "Running"); an unknown one as words. */
export function runStatusLabel(status: string): string {
  const key = RUN_STATUS_KEYS[status];
  return key ? t(key) : termLabel(status);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** An ISO time as the viewer's local `YYYY-MM-DD HH:MM`, the form the Tasks page shows a due date and time in; the text itself when it is not one. */
export function localDateTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** An ISO time as the viewer's short local date ("Nov 18"); the text itself when it is not one. */
export function localShortDate(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric" }).format(d);
}

/** Whether `start` to `end` is one whole local day ending at local midnight of the day `made` falls on. */
export function isPreviousLocalDay(start: string, end: string, made: string): boolean {
  const s = new Date(start);
  const e = new Date(end);
  const m = new Date(made);
  if ([s, e, m].some((d) => Number.isNaN(d.getTime()))) return false;
  const nextDay = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1);
  const madeDay = new Date(m.getFullYear(), m.getMonth(), m.getDate());
  return s.getTime() === new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime() && e.getTime() === nextDay.getTime() && e.getTime() === madeDay.getTime();
}

/** A whole number grouped by thousands in the active locale ("4,844"). */
export function groupedInteger(n: number): string {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(n);
}

/** An ISO time as the viewer's local clock time ("9:51 PM"); the text itself when it is not one. */
export function localClock(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : new Intl.DateTimeFormat(locale(), { hour: "numeric", minute: "2-digit" }).format(d);
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

/** A work item's short ID (design 09-dashboard-item): "c86970ff" for "wi_c86970ff…", the 8 hex characters after `wi_` that the CLI accepts; any other ID as it is. */
export function shortItemId(id: string): string {
  return /^wi_([0-9a-f]{8})/.exec(id)?.[1] ?? id;
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
 * Why an item waits, in the active locale: its reason code's text (`why.reason.<code>`, one per code) with the values
 * the API sent, then the open alarms that affect it. `until` comes as an ISO instant and reads as the viewer's local time. `holder` stands for the holder's name (WhyText puts a link
 * there); without it the name is the holder's title or ref, or "another item". An unknown code shows as is.
 */
export function whyText(why: Pick<Why, "reason_code" | "params" | "alarms">, holder?: string): string {
  const vars: Record<string, string | number> = { ...why.params };
  const stage = `why.stage.${vars.stage}`;
  if (stage in en) vars.stage = t(stage as MessageKey);
  if (typeof vars.until === "string") vars.until = localDateTime(vars.until);
  if ("holder" in vars) vars.holder = holder ?? (vars.holder || t("why.anotherItem"));
  const key = `why.reason.${why.reason_code}`;
  return [key in en ? t(key as MessageKey, vars) : termLabel(why.reason_code), ...why.alarms].join(". ");
}
