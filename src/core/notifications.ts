import type { StateChange, Timestamp, WorkItem, WorkItemId } from "./types.js";

/**
 * Owner notices (design 09-notifications): one stored notice per wait, a wait being the state change that set an
 * item's blocked_on to `human`, and one per close (`finished`), keyed on the close state change. Pure: what to write
 * is decided here from the items' state changes, the stored notices, the time and the settings; the notifications
 * unit writes it, and the shell and the `notify_channels` adapters deliver it.
 */

/** What an item waits on the owner for, from its blocked_reason: the needs-you kinds. */
export const WAIT_KINDS = ["spec", "merge", "failure", "other"] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];
/** An item closed: merged, rejected or dropped. */
export const FINISHED_KIND = "finished";
/** Every kind `notice_kinds` turns on or off. */
export const NOTICE_KINDS = [...WAIT_KINDS, FINISHED_KIND] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** The ref of an adapter's notices destination (`<adapter type>:notify`): one per adapter in `notify_channels`. */
export const NOTIFY_REF = "notify";

/** Finished notices start here (owner decision 2026-11-12): a close before it raises none. */
export const FINISHED_CUTOVER = "2026-11-12T00:00:00.000Z";
/** How far back each pass reads closes (owner decision 2026-11-12): an older close raises no notice. */
export const FINISHED_LOOKBACK_MS = 7 * 86_400_000;

/** The kind of the one notice that covers the notices quiet hours held. */
export const SUMMARY_KIND = "summary";
/** A summary covers several items, so it names none: its work item ID is empty, its wait key `quiet:<window end>`. */
export const SUMMARY_ITEM = "";

export interface Notice {
  /** The waiting item, or SUMMARY_ITEM for a summary. */
  work_item_id: string;
  /** The ID of the state change that set blocked_on to `human`; for a summary, `quiet:<held_until of what it covers>`. */
  wait_key: string;
  /** `backfill`: a wait the notices migration found already shown on the Needs-you list, stored as delivered. */
  kind: NoticeKind | typeof SUMMARY_KIND | "backfill";
  created_at: Timestamp;
  /** Set when quiet hours held the notice: the end of the window. A held notice is shown only through its summary. */
  held_until: Timestamp | null;
  /** Set by the shell once shown (phase 2). */
  delivered_at: Timestamp | null;
  /** 1 for an item's notice; for a summary, the held notices it covers. */
  count: number;
}

export type NewNotice = Omit<Notice, "delivered_at">;

export interface NoticeStore {
  /** Inserts the notice, or skips it when its (work_item_id, wait_key) is stored; true when it inserted. */
  recordNotice(n: NewNotice): Promise<boolean>;
  /** Every stored notice of these work item IDs (SUMMARY_ITEM for the summaries), delivered or not. Read-only. */
  listNoticesFor(work_item_ids: readonly string[]): Promise<Notice[]>;
  /** The held notices not yet delivered, oldest first. Read-only. */
  listHeldNotices(): Promise<Notice[]>;
  /** What the owner has still to see: undelivered notices quiet hours do not hold, oldest first. Read-only. */
  listPendingNotices(): Promise<Notice[]>;
}

export interface NoticeSettings {
  notice_kinds: readonly NoticeKind[];
  /** `HH:MM-HH:MM` in local time; empty: off. */
  quiet_hours: string;
}

/** A waiting item with its state changes, oldest first (none when the caller knew it unchanged since its notice). */
export interface WaitingItem {
  item: Pick<WorkItem, "id" | "blocked_on" | "blocked_reason">;
  changes: readonly Pick<StateChange, "id" | "changes">[];
}

/** A closed item with its state changes, oldest first (none when the caller knew it unchanged since its notice). */
export interface ClosedItem {
  item: Pick<WorkItem, "id" | "stage">;
  changes: readonly Pick<StateChange, "id" | "at" | "changes">[];
}

const FAILURE_REASONS = new Set(["max_attempts", "max_restart", "max_loops", "repeated_failure", "recurring_failure"]);

export function noticeKind(blocked_reason: string | null): WaitKind {
  if (blocked_reason === "spec_pending") return "spec";
  if (blocked_reason === "merge_pending") return "merge";
  if (blocked_reason !== null && (blocked_reason.startsWith("run_failed:") || FAILURE_REASONS.has(blocked_reason))) return "failure";
  return "other";
}

/** The ID of the newest state change that set blocked_on to `human`, or null when none did. */
export function waitKey(changes: WaitingItem["changes"]): string | null {
  for (let i = changes.length - 1; i >= 0; i--) if (changes[i]!.changes.blocked_on?.to === "human") return changes[i]!.id;
  return null;
}

/** The newest state change that closed the item, or null when none did. */
export function closeChange(changes: ClosedItem["changes"]): ClosedItem["changes"][number] | null {
  for (let i = changes.length - 1; i >= 0; i--) if (changes[i]!.changes.stage?.to === "CLOSED") return changes[i]!;
  return null;
}

/** The earliest close a pass at `now` notices: the later of the cutover and the lookback. */
export function finishedSince(now: Date): Timestamp {
  return new Date(Math.max(Date.parse(FINISHED_CUTOVER), now.getTime() - FINISHED_LOOKBACK_MS)).toISOString() as Timestamp;
}

/** How a finished notice names the close: completed → merged, rejected → rejected, anything else → dropped. */
export function closeOutcome(close_reason: string | null): "merged" | "rejected" | "dropped" {
  return close_reason === "completed" ? "merged" : close_reason === "rejected" ? "rejected" : "dropped";
}

/** A needs-you notice's one-line reason, from its kind: fixed text, never the item's free text. */
export function waitReason(kind: WaitKind): string {
  return { spec: "spec to approve", merge: "ready to merge", failure: "a run failed", other: "waiting on you" }[kind];
}

/** `notify_channels`: distinct non-empty names (whether each is a source plugin is checked where the registry is). */
export function parseNotifyChannels(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((c) => typeof c === "string" && c.trim() !== "") || new Set(value).size !== value.length) {
    throw new Error("notify_channels must be a list of distinct source plugin names, e.g. [\"slack\"], or [] for none");
  }
  return value as string[];
}

const HHMM = "([01]\\d|2[0-3]):([0-5]\\d)";
const WINDOW = new RegExp(`^${HHMM}-${HHMM}$`);

/** Minutes after local midnight of the window's start and end, or null when quiet hours are off. Throws on a bad value. */
export function parseQuietHours(value: unknown): { start: number; end: number } | null {
  if (value === "") return null;
  const m = typeof value === "string" ? WINDOW.exec(value) : null;
  if (!m) throw new Error('quiet_hours must be "HH:MM-HH:MM" (24-hour, local time), or "" for off');
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start === end) throw new Error("quiet_hours must start and end at different times");
  return { start, end };
}

/** The `quiet_hours` setting as written, once checked. Throws on a bad value. */
export function quietHoursSetting(value: unknown): string {
  parseQuietHours(value);
  return value as string;
}

/** Each kind listed once, every one a known kind. Throws on a bad value. */
export function parseNoticeKinds(value: unknown): NoticeKind[] {
  const known = NOTICE_KINDS as readonly unknown[];
  if (!Array.isArray(value) || !value.every((k) => known.includes(k)) || new Set(value).size !== value.length) {
    throw new Error(`notice_kinds must be a list of distinct kinds from ${NOTICE_KINDS.join(", ")}`);
  }
  return value as NoticeKind[];
}

/** The end of the quiet-hours window `now` is in, or null when it is in none (or quiet hours are off). */
export function quietUntil(quiet_hours: string, now: Date): Date | null {
  const w = parseQuietHours(quiet_hours);
  if (w === null) return null;
  const m = now.getHours() * 60 + now.getMinutes();
  const inside = w.start < w.end ? m >= w.start && m < w.end : m >= w.start || m < w.end;
  if (!inside) return null;
  const end = new Date(now.getTime());
  end.setHours(Math.floor(w.end / 60), w.end % 60, 0, 0);
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
  return end;
}

const summaryKey = (held_until: string) => `quiet:${held_until}`;

/**
 * The notices to write at `now`: one per item whose current wait has none, one per close since `finishedSince(now)`
 * with none (each held to the window's end inside quiet hours, and none for a kind turned off), then one summary per
 * ended window whose held notices have none yet. A wait or close already stored, under any kind, is never noticed
 * again, so an item is noticed once per wait and once per close.
 */
export function decideNotices(input: {
  waiting: readonly WaitingItem[];
  closed?: readonly ClosedItem[];
  stored: readonly Notice[];
  now: Date;
  settings: NoticeSettings;
}): NewNotice[] {
  const { now, settings } = input;
  const at = now.toISOString() as Timestamp;
  // Keyed, so a notice read twice (an item's own and a held one) counts once.
  const byKey = new Map(input.stored.map((n) => [`${n.work_item_id}\n${n.wait_key}`, n]));
  const stored = new Set(byKey.keys());
  const quiet = quietUntil(settings.quiet_hours, now);
  const held = quiet && (quiet.toISOString() as Timestamp);
  const out: NewNotice[] = [];
  for (const { item, changes } of input.waiting) {
    if (item.blocked_on !== "human") continue;
    const key = waitKey(changes);
    if (key === null || stored.has(`${item.id}\n${key}`)) continue;
    const kind = noticeKind(item.blocked_reason);
    if (!settings.notice_kinds.includes(kind)) continue;
    out.push({ work_item_id: item.id, wait_key: key, kind, created_at: at, held_until: held, count: 1 });
  }
  const since = finishedSince(now);
  for (const { item, changes } of settings.notice_kinds.includes(FINISHED_KIND) ? (input.closed ?? []) : []) {
    const close = item.stage === "CLOSED" ? closeChange(changes) : null;
    if (close === null || close.at < since || stored.has(`${item.id}\n${close.id}`)) continue;
    out.push({ work_item_id: item.id, wait_key: close.id, kind: FINISHED_KIND, created_at: at, held_until: held, count: 1 });
  }
  const ended = new Map<Timestamp, number>();
  for (const n of byKey.values()) {
    if (n.kind === SUMMARY_KIND || n.held_until === null || n.delivered_at !== null || Date.parse(n.held_until) > now.getTime()) continue;
    ended.set(n.held_until, (ended.get(n.held_until) ?? 0) + 1);
  }
  for (const [held_until, count] of [...ended].sort(([a], [b]) => a.localeCompare(b))) {
    if (stored.has(`${SUMMARY_ITEM}\n${summaryKey(held_until)}`)) continue;
    out.push({ work_item_id: SUMMARY_ITEM, wait_key: summaryKey(held_until), kind: SUMMARY_KIND, created_at: at, held_until: null, count });
  }
  return out;
}

/** Whether the stored notices of `id` show its wait unchanged since: a notice newer than the item's last update. */
export function noticedSince(stored: readonly Notice[], id: WorkItemId, updated_at: Timestamp): boolean {
  return stored.some((n) => n.work_item_id === id && n.created_at >= updated_at);
}
