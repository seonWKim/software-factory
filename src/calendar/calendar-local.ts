// The owner's own events (design 02-tasks-calendar, local events, 2026-11-24): `calendar_local_events`, one row per
// event the owner added, with its repeat (none, daily, weekly or monthly, no end date). Add, edit and delete write
// that table only; an edit or a delete of a repeating event applies to the whole series (owner answer 1). The read
// expands each repeat inside the range asked (expandLocalEvents, pure): an occurrence keeps the first start's local
// time of day and its length, in this process's time zone, as core/tasks.ts does for a day. Time comes from the
// caller's injected Clock, as `nowMs`. A copy of an event in a connected calendar is calendar-write.ts's: the event
// keeps the copy's calendar and ID and the last copy error, and the read says whether it is copied and that error.

import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "../state/index.js";
import { type SyncPorts, type SyncResult, copyEvent, hideCopies, readWriteAccess, removeCopy, storeWriteAccess } from "./calendar-write.js";

/** The source name the calendar read gives the owner's local events. */
const LOCAL_SOURCE = "local";
const REPEATS = ["none", "daily", "weekly", "monthly"] as const;
export type Repeat = (typeof REPEATS)[number];
/** The longest title taken: an event title is a line, not a document. */
const MAX_LOCAL_TITLE = 500;
/** A caller-chosen event ID: `le_` and 8 to 64 URL-safe characters, so a retried add stores one event. */
const LOCAL_ID = /^le_[A-Za-z0-9_-]{8,64}$/;
/** An ISO instant with its zone: `YYYY-MM-DDTHH:MM`, optional seconds and fraction, then `Z` or `±HH:MM`. */
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86_400_000;

/** The fields of an event the owner sets. Times are ISO instants. */
export interface LocalEventFields {
  readonly title: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly all_day: boolean;
  readonly repeats: Repeat;
}

/** One local event. `created_by` is the identity that added it, never a display name. */
export interface LocalEvent extends LocalEventFields {
  readonly id: string;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * An event's copy state (calendar-write.ts). `provider` and `provider_event_id`: the connected calendar that holds its
 * copy and the copy's ID there (null: no copy); `sync_error`: the last copy write's error, null after a success.
 */
interface LocalEventCopy {
  readonly provider: string | null;
  readonly provider_event_id: string | null;
  readonly sync_error: string | null;
}

/** One stored local event, with its copy state. */
export type StoredLocalEvent = LocalEvent & LocalEventCopy;

/** One occurrence as the calendar read places it: the stored event's fields at that occurrence's instants. */
export interface LocalOccurrence {
  readonly source: typeof LOCAL_SOURCE;
  readonly id: string;
  readonly title: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly all_day: boolean;
  readonly repeats: Repeat;
  readonly details: null;
  /** The connected calendar that holds its copy, or null. */
  readonly copied_to: string | null;
  /** The last copy write's error, kept on the event; null after a success. */
  readonly sync_error: string | null;
}

/** This process's time zone, the one every local day of the calendar read is counted in. */
export function processTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Whether `v` is an ISO instant with its zone, on a real calendar day. */
function isInstant(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = INSTANT.exec(v);
  if (m === null || Number.isNaN(Date.parse(v))) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
}

/** Why the fields are refused (empty or long title, unknown repeat, bad instant, end not after start), or null. */
function localEventError(f: Record<string, unknown>): string | null {
  if (typeof f.title !== "string" || f.title.trim() === "") return "title must be a non-empty string";
  if (f.title.length > MAX_LOCAL_TITLE) return `title must be at most ${MAX_LOCAL_TITLE} characters`;
  if (!isInstant(f.starts_at)) return "starts_at must be an ISO instant, e.g. 2026-11-24T09:00:00Z";
  if (!isInstant(f.ends_at)) return "ends_at must be an ISO instant, e.g. 2026-11-24T10:00:00Z";
  if (typeof f.all_day !== "boolean") return "all_day must be true or false";
  if (typeof f.repeats !== "string" || !(REPEATS as readonly string[]).includes(f.repeats)) return `repeats must be one of ${REPEATS.join(", ")}`;
  if (Date.parse(f.ends_at) <= Date.parse(f.starts_at)) return "ends_at must be after starts_at";
  return null;
}

/** Whether `id` is a caller-chosen local event ID. */
const isLocalEventId = (id: unknown): id is string => typeof id === "string" && LOCAL_ID.test(id);

const iso = (v: string) => new Date(Date.parse(v)).toISOString();

const textOrNull = (v: unknown): string | null => (v == null ? null : String(v));

function row(r: Record<string, unknown>): StoredLocalEvent {
  return {
    provider: textOrNull(r.provider), provider_event_id: textOrNull(r.provider_event_id), sync_error: textOrNull(r.sync_error),
    id: String(r.id), title: String(r.title), starts_at: String(r.starts_at), ends_at: String(r.ends_at), all_day: Number(r.all_day) === 1,
    repeats: String(r.repeats) as Repeat, created_by: String(r.created_by), created_at: String(r.created_at), updated_at: String(r.updated_at),
  };
}

/** The stored event `id`, or null. */
async function getLocalEvent(db: SqlExecutor, id: string): Promise<StoredLocalEvent | null> {
  const [r] = await db.all("SELECT * FROM calendar_local_events WHERE id = ?", [id]);
  return r === undefined ? null : row(r);
}

/**
 * Stores one event (fields checked by localEventError first) under `id` (a new `le_` ID when null), its instants
 * normalised to UTC ISO. Safe to run twice: a second add under the same ID writes nothing and answers the stored one.
 */
async function addLocalEvent(db: SqlExecutor, a: { id: string | null; fields: LocalEventFields; by: string; nowMs: number }): Promise<StoredLocalEvent> {
  const id = a.id ?? `le_${randomUUID()}`;
  const now = new Date(a.nowMs).toISOString();
  const f = a.fields;
  await db.run(
    "INSERT OR IGNORE INTO calendar_local_events (id, title, starts_at, ends_at, all_day, repeats, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, f.title.trim(), iso(f.starts_at), iso(f.ends_at), f.all_day ? 1 : 0, f.repeats, a.by, now, now],
  );
  return (await getLocalEvent(db, id))!;
}

/** Replaces the fields of event `id`, the whole series for a repeating one; null when no such event is stored. */
async function editLocalEvent(db: SqlExecutor, id: string, fields: LocalEventFields, nowMs: number): Promise<StoredLocalEvent | null> {
  const changed = await db.run(
    "UPDATE calendar_local_events SET title = ?, starts_at = ?, ends_at = ?, all_day = ?, repeats = ?, updated_at = ? WHERE id = ?",
    [fields.title.trim(), iso(fields.starts_at), iso(fields.ends_at), fields.all_day ? 1 : 0, fields.repeats, new Date(nowMs).toISOString(), id],
  );
  return changed === 1 ? getLocalEvent(db, id) : null;
}

/** Deletes event `id`, with every occurrence of its repeat; false when no such event was stored. */
async function deleteLocalEvent(db: SqlExecutor, id: string): Promise<boolean> {
  return (await db.run("DELETE FROM calendar_local_events WHERE id = ?", [id])) === 1;
}

/** The owner's local events on one store driver: the write routes' operations, handed to them by the composition root. */
export interface LocalEvents {
  /** Why the fields are refused, or null (localEventError). */
  check(fields: Record<string, unknown>): string | null;
  /** Whether `id` is a local event ID. */
  isId(id: unknown): id is string;
  get(id: string): Promise<StoredLocalEvent | null>;
  add(a: { id: string | null; fields: LocalEventFields; by: string; nowMs: number }): Promise<StoredLocalEvent>;
  edit(id: string, fields: LocalEventFields, nowMs: number): Promise<StoredLocalEvent | null>;
  remove(id: string): Promise<boolean>;
  /** After an add or edit of `event`: its copy in a connected calendar, at most one port call (calendar-write.ts copyEvent). */
  copy(event: StoredLocalEvent, a: { want: boolean; ports: SyncPorts }): Promise<SyncResult>;
  /** After a delete of `event`: its copy removed, if it has one (calendar-write.ts removeCopy). */
  uncopy(event: StoredLocalEvent, ports: SyncPorts): Promise<SyncResult>;
  /** `events` less the copies of local events, so each shows once (calendar-write.ts hideCopies). */
  hideCopies<E extends { readonly source: string; readonly id: string }>(events: readonly E[]): Promise<E[]>;
  /** Whether a calendar takes writes, as stored (calendar-write.ts): read with no provider call; null forgets it. */
  readonly writeAccess: { get(source: string): Promise<boolean | null>; set(source: string, writable: boolean | null): Promise<void> };
}

/** The local events stored through `db`. */
export function localEvents(db: SqlExecutor): LocalEvents {
  return {
    check: localEventError, isId: isLocalEventId,
    get: (id) => getLocalEvent(db, id), add: (a) => addLocalEvent(db, a), edit: (id, f, nowMs) => editLocalEvent(db, id, f, nowMs), remove: (id) => deleteLocalEvent(db, id),
    copy: (e, a) => copyEvent(db, e, { ...a, timeZone: processTimeZone() }), uncopy: (e, ports) => removeCopy(db, e, ports), hideCopies: (events) => hideCopies(db, events),
    writeAccess: { get: (source) => readWriteAccess(db, source), set: (source, writable) => storeWriteAccess(db, source, writable) },
  };
}

/** The local days `from` through `to` (YYYY-MM-DD) as instants: local midnight of `from`, local midnight after `to`. */
function rangeBounds(from: string, to: string): { from: number; to: number } {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  return { from: new Date(fy, fm - 1, fd).getTime(), to: new Date(ty, tm - 1, td + 1).getTime() };
}

/** The stored events that can have an occurrence in the local days `from` through `to`: one read, no write. */
export async function readLocalEvents(db: SqlExecutor, from: string, to: string): Promise<StoredLocalEvent[]> {
  const b = rangeBounds(from, to);
  const rows = await db.all(
    "SELECT * FROM calendar_local_events WHERE starts_at < ? AND (repeats <> 'none' OR ends_at > ?) ORDER BY starts_at, id",
    [new Date(b.to).toISOString(), new Date(b.from).toISOString()],
  );
  return rows.map(row);
}

/** The occurrence `n` steps after the first start, in local wall-clock time; null for a month without that day. */
function nthStart(first: Date, repeats: Exclude<Repeat, "none">, n: number): Date | null {
  const [y, m, d] = [first.getFullYear(), first.getMonth(), first.getDate()];
  const time = [first.getHours(), first.getMinutes(), first.getSeconds(), first.getMilliseconds()] as const;
  if (repeats !== "monthly") return new Date(y, m, d + n * (repeats === "daily" ? 1 : 7), ...time);
  const at = new Date(y, m + n, d, ...time);
  return at.getDate() === d ? at : null;
}

/** The first step worth trying for a range starting at `fromMs`: a few steps early, never below 0. */
function firstStep(first: Date, repeats: Exclude<Repeat, "none">, lengthMs: number, fromMs: number): number {
  const days = Math.floor((fromMs - first.getTime() - lengthMs) / DAY_MS) - 2;
  if (days <= 0) return 0;
  return repeats === "daily" ? days : repeats === "weekly" ? Math.floor(days / 7) : Math.floor(days / 31);
}

/**
 * Each occurrence of `events` that overlaps the local days `from` through `to`, by start, then ID. A repeat steps a
 * day, a week or a month from the first start's local date at its local time of day; a monthly one on the 29th to
 * 31st skips the months without that day. A timed occurrence keeps the first's length; an all-day one its number of
 * days, ending at a local midnight. Pure.
 */
export function expandLocalEvents(events: readonly (LocalEvent & Partial<LocalEventCopy>)[], from: string, to: string): LocalOccurrence[] {
  const b = rangeBounds(from, to);
  const out: LocalOccurrence[] = [];
  for (const e of events) {
    const first = new Date(Date.parse(e.starts_at));
    const lengthMs = Date.parse(e.ends_at) - first.getTime();
    const lengthDays = Math.max(1, Math.round(lengthMs / DAY_MS));
    const endOf = (s: Date) => (e.all_day ? new Date(s.getFullYear(), s.getMonth(), s.getDate() + lengthDays) : new Date(s.getTime() + lengthMs));
    const push = (s: Date, end: Date) => {
      if (s.getTime() < b.to && end.getTime() > b.from) {
        out.push({
          source: LOCAL_SOURCE, id: e.id, title: e.title, starts_at: s.toISOString(), ends_at: end.toISOString(), all_day: e.all_day, repeats: e.repeats, details: null,
          copied_to: e.provider_event_id == null ? null : (e.provider ?? null), sync_error: e.sync_error ?? null,
        });
      }
    };
    if (e.repeats === "none") {
      push(first, new Date(Date.parse(e.ends_at)));
      continue;
    }
    for (let n = firstStep(first, e.repeats, lengthMs, b.from); ; n++) {
      const s = nthStart(first, e.repeats, n);
      if (s === null) continue;
      if (s.getTime() >= b.to) break;
      push(s, endOf(s));
    }
  }
  return out.sort((x, y) => x.starts_at.localeCompare(y.starts_at) || x.id.localeCompare(y.id));
}
