// A local event's copy in a connected calendar (design 02-tasks-calendar, copy to a connected calendar, 2026-11-25).
// The local event is always saved first; the copy is one call on a source's sync port, never more: an add calls
// `add`, an edit of a copied event `edit`, a delete of one `remove`, each on the whole series of a repeating event
// (owner answer 1). With no connected calendar that takes writes, or a read-only one, nothing is called and the
// answer says sync is unavailable. A failed write keeps the local change and stores its error on the event
// (`sync_error`); nothing retries it on a poll (owner answer 2): the next save of that event (an add again or an edit)
// is the retry. The copy's ID is kept on the event, so the calendar read leaves the copy out and shows the event once.
// Whether a calendar takes writes is stored state (`calendar_write_access`): set when the dashboard connects it and
// each time a write asks its port, so the calendar read answers it from the store and never calls the provider.
// This file knows a local event and a sync port only: no provider.

import type { SqlExecutor } from "../state/index.js";
import type { LocalEvent, Repeat } from "./calendar-local.js";

/**
 * A local event as a sync port copies it. The same shape as CalendarCopy (src/interfaces/calendar-source.ts),
 * restated because a component imports no legacy folder (RFC 0015 §9); the UI hands the ports over, so the
 * typecheck keeps the two in step.
 */
export interface CopyFields {
  readonly title: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly all_day: boolean;
  readonly repeats: Repeat;
  readonly time_zone: string;
}

/** CalendarSyncPort (src/interfaces/calendar-source.ts), restated as CopyFields is. */
export interface SyncPort {
  /** The calendar's name as the owner knows it, for the event dialog's switch and note. */
  readonly label: string;
  writable(): Promise<boolean>;
  add(copy: CopyFields): Promise<string>;
  edit(id: string, copy: CopyFields): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * The sync port of the connected calendar named `name`; with null, of the first connected calendar that has one.
 * Null when there is none.
 */
export type SyncPorts = (name: string | null) => Promise<{ name: string; port: SyncPort } | null>;

/**
 * What the copy did: `off` (not asked, nothing called), `unavailable` (asked, but no connected calendar takes writes:
 * nothing called), `synced` (the one call passed) or `failed` (the call, or getting to it, failed: the error is kept).
 */
export type SyncResult =
  | { readonly state: "off" }
  | { readonly state: "unavailable"; readonly reason: string }
  | { readonly state: "synced"; readonly provider: string }
  | { readonly state: "failed"; readonly error: string };

export const NO_WRITABLE_CALENDAR = "Sync is unavailable: no connected calendar takes writes. The event is saved here only.";
export const READ_ONLY_CALENDAR = "Sync is unavailable: the calendar is connected read-only; reconnect it with write access. The event is saved here only.";
/** A stored error is cut to this many characters. */
const ERROR_MAX = 1000;

const errorOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX);

const copyOf = (e: LocalEvent, timeZone: string): CopyFields => ({
  title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, all_day: e.all_day, repeats: e.repeats, time_zone: timeZone,
});

/** Whether `e` has a copy in a connected calendar. */
const copied = (e: LocalEvent): boolean => e.provider !== null && e.provider_event_id !== null;

async function setCopy(db: SqlExecutor, id: string, c: { provider: string | null; provider_event_id: string | null; sync_error: string | null }): Promise<void> {
  await db.run("UPDATE calendar_local_events SET provider = ?, provider_event_id = ?, sync_error = ? WHERE id = ?", [c.provider, c.provider_event_id, c.sync_error, id]);
}

/** Whether calendar `source` takes writes, as last stored; null when nothing is stored for it. One read, no provider call. */
export async function readWriteAccess(db: SqlExecutor, source: string): Promise<boolean | null> {
  const rows = await db.all("SELECT writable FROM calendar_write_access WHERE source = ?", [source]);
  return rows.length === 0 ? null : Number(rows[0]!.writable) === 1;
}

/** Stores whether calendar `source` takes writes; null forgets it (a disconnect). */
export async function storeWriteAccess(db: SqlExecutor, source: string, writable: boolean | null): Promise<void> {
  await db.run("DELETE FROM calendar_write_access WHERE source = ?", [source]);
  if (writable !== null) await db.run("INSERT INTO calendar_write_access (source, writable) VALUES (?, ?)", [source, writable ? 1 : 0]);
}

/**
 * The port to write `e`'s copy through, or why there is none: a copied event's own calendar, else the first. Its
 * answer to `writable` (on a write only, never on a read) is stored, so the calendar read knows it.
 */
async function portFor(db: SqlExecutor, e: LocalEvent, ports: SyncPorts): Promise<{ name: string; port: SyncPort } | { unavailable: string }> {
  const target = await ports(copied(e) ? e.provider : null);
  if (target === null) {
    if (copied(e)) throw new Error(`${e.provider} is not connected: its copy of the event was not changed`);
    return { unavailable: NO_WRITABLE_CALENDAR };
  }
  const writable = await target.port.writable();
  await storeWriteAccess(db, target.name, writable);
  if (writable) return target;
  if (copied(e)) throw new Error(`${target.name} is connected read-only: its copy of the event was not changed`);
  return { unavailable: READ_ONLY_CALENDAR };
}

/**
 * After a local add or edit of `e`: a copied event's copy is edited (whatever `want` says: the copy follows the
 * event); an event with no copy is added to the first connected calendar that takes writes when `want`, or when its
 * last copy failed (`sync_error`: saving it again is the retry). One port call at most. The outcome is stored on the
 * event: the copy's calendar and ID, or the error.
 */
export async function copyEvent(db: SqlExecutor, e: LocalEvent, a: { want: boolean; ports: SyncPorts; timeZone: string }): Promise<SyncResult> {
  if (!copied(e) && !a.want && e.sync_error === null) return { state: "off" };
  try {
    const target = await portFor(db, e, a.ports);
    if ("unavailable" in target) return { state: "unavailable", reason: target.unavailable };
    const copy = copyOf(e, a.timeZone);
    let id = e.provider_event_id;
    if (copied(e)) await target.port.edit(id!, copy);
    else id = await target.port.add(copy);
    await setCopy(db, e.id, { provider: target.name, provider_event_id: id, sync_error: null });
    return { state: "synced", provider: target.name };
  } catch (err) {
    const error = errorOf(err);
    await setCopy(db, e.id, { provider: e.provider, provider_event_id: e.provider_event_id, sync_error: error });
    return { state: "failed", error };
  }
}

/** After a local delete of `e`: its copy, if any, is removed, the whole series. The event is gone, so a failure is only answered. */
export async function removeCopy(db: SqlExecutor, e: LocalEvent, ports: SyncPorts): Promise<SyncResult> {
  if (!copied(e)) return { state: "off" };
  try {
    const target = await portFor(db, e, ports);
    if ("unavailable" in target) return { state: "unavailable", reason: target.unavailable };
    await target.port.remove(e.provider_event_id!);
    return { state: "synced", provider: target.name };
  } catch (err) {
    return { state: "failed", error: errorOf(err) };
  }
}

/**
 * `events` without the copies of local events: an event whose source holds a local event's copy under its ID, or an
 * occurrence of a repeating copy, which a source reports as that ID, `_` and a suffix. One read, no write.
 */
export async function hideCopies<E extends { readonly source: string; readonly id: string }>(db: SqlExecutor, events: readonly E[]): Promise<E[]> {
  const rows = await db.all("SELECT provider, provider_event_id FROM calendar_local_events WHERE provider IS NOT NULL AND provider_event_id IS NOT NULL");
  if (rows.length === 0) return [...events];
  const ids = new Map<string, string[]>();
  for (const r of rows) ids.set(String(r.provider), [...(ids.get(String(r.provider)) ?? []), String(r.provider_event_id)]);
  const isCopy = (e: E) => (ids.get(e.source) ?? []).some((id) => e.id === id || e.id.startsWith(`${id}_`));
  return events.filter((e) => !isCopy(e));
}
