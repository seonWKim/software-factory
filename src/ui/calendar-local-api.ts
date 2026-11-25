// The owner's own events' write routes (design 02-tasks-calendar, local events, 2026-11-24), each a POST behind the
// guards every write route passes (write-routes.ts: Host, Origin, Content-Type, the commands token, body size, JSON)
// and the commands actor, as the task routes: POST /api/v1/calendar/local-events adds one, /edit replaces the fields
// it names, /delete removes it. An edit or a delete of a repeating event applies to the whole series. None needs the
// `calendar` setting: the events are the calendar component's own (src/calendar/calendar-local.ts), whose operations
// the composition root (write-routes.ts) hands each handler as `events`. Every refusal comes before the store write.
//
// A copy in a connected calendar (design 02-tasks-calendar, copy to a connected calendar, 2026-11-25): after the local
// write, at most one sync port call, through the Calendar section's ports (calendar-api.ts UiCalendar.ports; none
// without that section). An add copies when its body says `sync: true`; an edit or a delete of a copied event changes
// or removes its copy, the whole series. The answer's `sync` says what the copy did (off, unavailable, synced or
// failed with its error); a failure keeps the local change and its error is stored on the event. Nothing retries it
// on a poll: the next save of that event (the add again, or an edit) retries the copy.

import type { LocalEvent, LocalEventFields, LocalEvents } from "../calendar/index.js";
import { type ApiResult, apiError } from "./api.js";
import type { UiDeps } from "./deps.js";
import { Withholder } from "./withhold.js";

export const LOCAL_EVENTS_PATH = "/api/v1/calendar/local-events";
export const LOCAL_EVENT_EDIT_PATH = "/api/v1/calendar/local-events/edit";
export const LOCAL_EVENT_DELETE_PATH = "/api/v1/calendar/local-events/delete";

const FIELDS = ["title", "starts_at", "ends_at", "all_day", "repeats"] as const;
type SyncPorts = Parameters<LocalEvents["copy"]>[1]["ports"];
type SyncResult = Awaited<ReturnType<LocalEvents["copy"]>>;
const NO_PORTS: SyncPorts = async () => null;
/** The connected calendars' sync ports: the Calendar section's, none without it. */
const portsOf = (d: UiDeps): SyncPorts => d.settings?.calendar?.ports ?? NO_PORTS;
const OFF = { status: 503, value: { error: "Events are off: this server is not on loopback, so it needs ui.user_id." } } as const;
const unknown = (id: string) => apiError(404, `no event ${id}: it was deleted, or the page is out of date; reload it`);

/** The body as an object with only `allowed` keys, or the reason it is refused. */
function fieldsOf(body: unknown, allowed: readonly string[]): Record<string, unknown> | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const extra = Object.keys(body).find((k) => !allowed.includes(k));
  return extra === undefined ? (body as Record<string, unknown>) : { error: `unknown field "${extra}"` };
}

/** The fields to store, checked: `base` (the stored event on an edit) with the body's fields over it. */
function checked(events: LocalEvents, base: Partial<LocalEventFields>, b: Record<string, unknown>): LocalEventFields | { error: string } {
  const merged: Record<string, unknown> = { all_day: false, repeats: "none", ...base };
  for (const k of FIELDS) if (b[k] !== undefined) merged[k] = b[k];
  const error = events.check(merged);
  return error === null ? (merged as unknown as LocalEventFields) : { error };
}

/** The stored event as answered, with what its copy did: its texts through the Withholder, as on the other routes. */
async function shown(d: UiDeps, e: LocalEvent, sync: SyncResult): Promise<ApiResult> {
  const w = new Withholder(d.scanner);
  const plain = async (v: string | null) => (v === null ? null : (await w.plain(v)).text);
  const answered = sync.state === "failed" ? { ...sync, error: await plain(sync.error) } : sync;
  return { status: 200, value: { event: { ...e, title: await plain(e.title), sync_error: await plain(e.sync_error) }, sync: answered } };
}

/** `e` after its copy: the stored row, which now holds the copy's calendar and ID or its error. */
async function copied(d: UiDeps, events: LocalEvents, e: LocalEvent, want: boolean): Promise<ApiResult> {
  const sync = await events.copy(e, { want, ports: portsOf(d) });
  return shown(d, (await events.get(e.id)) ?? e, sync);
}

/**
 * POST /api/v1/calendar/local-events with `{ title, starts_at, ends_at }` and optionally `all_day` (default false),
 * `repeats` (one of REPEATS, default none) and `id` (a caller-chosen `le_` ID, so a retry stores one event): 400 for
 * a bad body; 503 with no actor; else 200 with the stored event, `created_by` the commands actor. With `sync: true`
 * the event is then copied to the first connected calendar that takes writes; the answer's `sync` says how that went.
 */
export async function writeLocalEvent(d: UiDeps, body: unknown, events: LocalEvents): Promise<ApiResult> {
  const actor = d.commands?.actor ?? null;
  if (actor === null) return OFF;
  const b = fieldsOf(body, ["id", "sync", ...FIELDS]);
  if ("error" in b) return apiError(400, String(b.error));
  if (b.sync !== undefined && typeof b.sync !== "boolean") return apiError(400, "sync must be true or false");
  if (b.id !== undefined && !events.isId(b.id)) return apiError(400, "id must be le_ and 8 to 64 letters, digits, _ or -");
  const fields = checked(events, {}, b);
  if ("error" in fields) return apiError(400, fields.error);
  const id = (b.id as string | undefined) ?? null;
  return copied(d, events, await events.add({ id, fields, by: actor, nowMs: d.clock.now().getTime() }), b.sync === true);
}

/** POST /api/v1/calendar/local-events/edit with `{ id }` and the fields to change: 400 for a bad body; 404 for an unknown event; else 200 with it, its copy edited too. */
export async function writeLocalEventEdit(d: UiDeps, body: unknown, events: LocalEvents): Promise<ApiResult> {
  if ((d.commands?.actor ?? null) === null) return OFF;
  const b = fieldsOf(body, ["id", ...FIELDS]);
  if ("error" in b) return apiError(400, String(b.error));
  if (!events.isId(b.id)) return apiError(400, "id must be a local event ID");
  if (!FIELDS.some((k) => b[k] !== undefined)) return apiError(400, `name at least one of ${FIELDS.join(", ")}`);
  const stored = await events.get(b.id);
  if (stored === null) return unknown(b.id);
  const fields = checked(events, stored, b);
  if ("error" in fields) return apiError(400, fields.error);
  const edited = await events.edit(b.id, fields, d.clock.now().getTime());
  return edited === null ? unknown(b.id) : copied(d, events, edited, false);
}

/** POST /api/v1/calendar/local-events/delete with `{ id }`: 404 for an unknown event; else 200, the event and its repeats gone, its copy too. */
export async function writeLocalEventDelete(d: UiDeps, body: unknown, events: LocalEvents): Promise<ApiResult> {
  if ((d.commands?.actor ?? null) === null) return OFF;
  const b = fieldsOf(body, ["id"]);
  if ("error" in b) return apiError(400, String(b.error));
  if (!events.isId(b.id)) return apiError(400, "id must be a local event ID");
  const stored = await events.get(b.id);
  if (stored === null || !(await events.remove(b.id))) return unknown(b.id);
  const sync = await events.uncopy(stored, portsOf(d));
  const answered = sync.state === "failed" ? { ...sync, error: (await new Withholder(d.scanner).plain(sync.error)).text } : sync;
  return { status: 200, value: { id: b.id, deleted: true, sync: answered } };
}

/** Each local-event write route by path, for write-routes.ts. */
export const LOCAL_EVENT_WRITES: Readonly<Record<string, (d: UiDeps, body: unknown, events: LocalEvents) => Promise<ApiResult>>> = {
  [LOCAL_EVENTS_PATH]: writeLocalEvent,
  [LOCAL_EVENT_EDIT_PATH]: writeLocalEventEdit,
  [LOCAL_EVENT_DELETE_PATH]: writeLocalEventDelete,
};
