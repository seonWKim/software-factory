// The plain tasks' routes (design 02-tasks): GET /api/v1/tasks, the Tasks page's views with the stored calendar events, and GET
// /api/v1/tasks/done, its Done tab; POST /api/v1/tasks/edit,
// /done, /reopen, /delete and /sub, the page's row actions, and /schedule, its timeline's drop, each calling the store method of its CLI command (`factory task
// edit`, `done`, `reopen`, `delete`, `sub`), so the page and the CLI cannot diverge; POST /api/v1/tasks/build,
// its Build this button (task-build.ts, the same action as `factory task build`); and POST /api/v1/tasks, which
// stores one plain task from quick-add words, for the desktop shell's quick-add box. The words go through the same parser as `factory task add` (src/core/quick-add.ts)
// and the task through the same store method, with the ID the caller chose, so a retry stores one task. The task is
// created by the page's commands actor (UiCommands), whose per-process token the request carries. The request guards
// (Host, Origin, Content-Type, CSRF token, body size, JSON) run in server.ts before writeTask is reached; every
// refusal comes before the store write.

import { readCalendar } from "../calendar/index.js";
import { needsDueDate, parseQuickAdd, parseQuickEdit, validDate } from "../core/quick-add.js";
import { buildTask } from "../core/task-build.js";
import { doneWindow, durationError, taskViews } from "../core/tasks.js";
import type { Timestamp } from "../core/types.js";
import { TASK_LIST_LIMIT } from "../core/local-cli.js";
import type { ApiResult } from "./api.js";
import type { UiDeps } from "./pages.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import { TASKS_ADD_KEYS, type TasksAddKey } from "../runtime/settings/tasks-add-key.setting.js";
import { Withholder } from "./withhold.js";

export const TASKS_PATH = "/api/v1/tasks";
export const TASK_BUILD_PATH = "/api/v1/tasks/build";
export const TASK_EDIT_PATH = "/api/v1/tasks/edit";
export const TASK_DONE_PATH = "/api/v1/tasks/done";
export const TASK_REOPEN_PATH = "/api/v1/tasks/reopen";
export const TASK_DELETE_PATH = "/api/v1/tasks/delete";
export const TASK_SUB_PATH = "/api/v1/tasks/sub";
export const TASK_SCHEDULE_PATH = "/api/v1/tasks/schedule";

/** A caller-chosen task ID: `tk_` and 8 to 64 URL-safe characters (the CLI's own `tk_<random>`). */
const TASK_ID = /^tk_[A-Za-z0-9_-]{8,64}$/;
/** The longest task ID Build this takes. */
const MAX_ID = 200;
/** The longest quick-add text taken; a task title is a line, not a document. */
export const MAX_WORDS = 1000;

/** Each task's or event's title through the Withholder, as on the other routes. */
async function shown<T extends { title: string }>(w: Withholder, rows: readonly T[]): Promise<T[]> {
  return Promise.all(rows.map(async (t) => ({ ...t, title: (await w.plain(t.title)).text })));
}

/**
 * GET /api/v1/tasks: the open tasks' views (Inbox, Today, Upcoming, Projects; core/tasks.ts taskViews) at the server's
 * clock, in its time zone, with the calendar events stored by the last syncs placed in Today and Upcoming, and
 * `calendar`, each source's last sync time and whether its last sync failed. Reads the stored copy only: no source
 * is called and nothing is written. `csrf_token` and `can_build` for Build this (null and false when the commands
 * route is off). `add_key`, the quick-add field's submit key: the `tasks_add_key` setting's stored global value.
 */
export async function readTasks(d: UiDeps): Promise<ApiResult> {
  const now = d.clock.now();
  const w = new Withholder(d.scanner);
  const open = await shown(w, await d.store.listTasks(TASK_LIST_LIMIT));
  const calendar = await readCalendar(storeSql(d.store));
  const events = await shown(w, calendar.events);
  const can_build = (d.commands?.actor ?? null) !== null;
  const add_key = await readAddKey(d);
  return {
    status: 200,
    value: { as_of: now.toISOString(), ...taskViews(open, now, events), calendar: calendar.sources, csrf_token: d.commands?.token ?? null, can_build, add_key },
  };
}

/** The `tasks_add_key` setting: its stored global override when that is one of the choices, else the default (`enter`). */
async function readAddKey(d: UiDeps): Promise<TasksAddKey> {
  const row = (await d.store.listSettingOverrides()).find((o) => o.key === "tasks_add_key" && o.project === "");
  let value: unknown = null;
  try {
    value = row === undefined ? null : JSON.parse(row.value);
  } catch {
    // Not JSON: the default applies.
  }
  return TASKS_ADD_KEYS.find((k) => k === value) ?? TASKS_ADD_KEYS[0];
}

/**
 * GET /api/v1/tasks/done, the Tasks page's Done tab (design 02-tasks, Done view): the done tasks of the last
 * DONE_WINDOW_DAYS days at the server's clock, most recently done first, every list in one list; with `?before=<ISO
 * time>` (Show older), those of the DONE_WINDOW_DAYS days before it. `older`: a task was done before the window;
 * `next_before`: the `before` of Show older's read, the oldest row's done time (the window's start when it has none).
 * Reads the stored copy only: no source is called and nothing is written.
 */
export async function readDoneTasks(d: UiDeps, before: string | null): Promise<ApiResult> {
  const end = before === null ? null : Date.parse(before);
  if (end !== null && Number.isNaN(end)) return refused(400, "before must be an ISO time, e.g. 2026-11-13T09:00:00.000Z");
  const now = d.clock.now();
  const window = doneWindow(now, end === null ? null : (new Date(end).toISOString() as Timestamp));
  const r = await d.store.listDoneTasks(window);
  const tasks = await shown(new Withholder(d.scanner), r.tasks);
  return { status: 200, value: { as_of: now.toISOString(), tasks, older: r.older, next_before: tasks.at(-1)?.done_at ?? window.from } };
}

/**
 * POST /api/v1/tasks/build with `{ id }`, after the request guards: 400 for a body that is not one; 503 with no actor;
 * 409 for a done task, an unknown one or no stored project key (nothing written); else 200 with the work item's ID,
 * `created` false when the task already had it.
 */
export async function writeTaskBuild(d: UiDeps, body: unknown): Promise<ApiResult> {
  const actor = d.commands?.actor ?? null;
  if (actor === null) return { status: 503, value: { error: "Build is off: this server is not on loopback, so it needs ui.user_id." } };
  const b = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  // Any stored ID: a chat-added task's ID is its message's, not the tk_<random> this route's quick-add takes.
  if (b === null || Object.keys(b).some((k) => k !== "id") || typeof b.id !== "string" || b.id === "" || b.id.length > MAX_ID) {
    return { status: 400, value: { error: `the body must be { "id": "<task id>" }, the ID at most ${MAX_ID} characters` } };
  }
  const project = (await d.settings?.resolveProject())?.key ?? null;
  const r = await buildTask(d.store, b.id, project, actor);
  if (!r.ok) return { status: 409, value: { error: r.reason } };
  return { status: 200, value: { task_id: r.task.id, work_item_id: r.item.id, created: r.created } };
}

type Field = "id" | "words" | "parent";

/** Why `v` is not a valid value for the field, or null. `id` is a new task's ID; `parent` (and `id` with `stored`) any stored one. */
function fieldError(k: Field, v: unknown, stored: boolean): string | null {
  if (k === "words") return typeof v === "string" && v.length <= MAX_WORDS ? null : `words must be a string of at most ${MAX_WORDS} characters`;
  // Any stored ID: a chat-added task's ID is its message's, not the tk_<random> quick-add takes.
  if (k === "parent" || stored) return typeof v === "string" && v !== "" && v.length <= MAX_ID ? null : `${k} must be a task ID of at most ${MAX_ID} characters`;
  return typeof v === "string" && TASK_ID.test(v) ? null : "id must be tk_ and 8 to 64 letters, digits, - or _";
}

/** The body as an object with exactly `keys`, each valid, or why it is not one. `stored`: `id` names a stored task. */
function parseBody<K extends Field>(body: unknown, keys: readonly K[], stored = false): Record<K, string> | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !(keys as readonly string[]).includes(k));
  if (extra) return { error: `unknown field "${extra}"` };
  for (const k of keys) {
    const error = fieldError(k, b[k], stored);
    if (error !== null) return { error };
  }
  return b as Record<K, string>;
}

const OFF = { status: 503, value: { error: "Tasks are off: this server is not on loopback, so it needs ui.user_id." } } as const;
const refused = (status: 400 | 404 | 409, error: string): ApiResult => ({ status, value: { error } });
const unknown = (id: string) => refused(404, `no task ${id}: it was deleted, or the page is out of date; reload it`);

/**
 * POST /api/v1/tasks with `{ id, words }`, after the request guards: 400 for a body that is not one or words the
 * parser refuses (its reason); 503 when the page has no actor; else 200 with the stored task (the one already stored
 * under that ID on a retry). The title leaves through the Withholder, as on the other routes.
 */
export async function writeTask(d: UiDeps, body: unknown): Promise<ApiResult> {
  const actor = d.commands?.actor ?? null;
  if (actor === null) return OFF;
  const b = parseBody(body, ["id", "words"]);
  if ("error" in b) return refused(400, b.error);
  const parsed = parseQuickAdd(b.words);
  if (!parsed.ok) return { status: 400, value: { error: parsed.reason } };
  const task = await d.store.addTask({ ...parsed.task, id: b.id, created_by: actor });
  const title = (await new Withholder(d.scanner).plain(task.title)).text;
  return { status: 200, value: { task: { ...task, title } } };
}

/**
 * POST /api/v1/tasks/edit with `{ id, words }`, the store's updateTask as `factory task edit`: the title and the
 * quick-add words for date, time, duration, priority and list, each field named by the words and only those; recurrence is not
 * edited here. 400 for words the parser refuses or a recurrence; 404 for an unknown task; 409 for a done one; else
 * 200 with the stored task. Every refusal writes nothing.
 */
export async function writeTaskEdit(d: UiDeps, body: unknown): Promise<ApiResult> {
  if ((d.commands?.actor ?? null) === null) return OFF;
  const b = parseBody(body, ["id", "words"], true);
  if ("error" in b) return refused(400, b.error);
  const parsed = parseQuickEdit(b.words);
  if (!parsed.ok) return refused(400, parsed.reason);
  if (parsed.edit.recurrence !== undefined) return refused(400, "a task's recurrence is not edited here: leave out every day, every week or every month");
  const r = await d.store.updateTask(b.id, parsed.edit);
  if (r.ok) return { status: 200, value: { task: (await shown(new Withholder(d.scanner), [r.task]))[0] } };
  if (r.reason === "needs_due_date") return refused(409, needsDueDate(r.recurrence));
  return r.reason === "done" ? refused(409, "the task is done: a done task cannot be edited") : unknown(b.id);
}

/** POST /api/v1/tasks/done with `{ id }`, the store's completeTask as `factory task done`: 404 for an unknown task; else 200, `completed` false when it was already done. */
export async function writeTaskDone(d: UiDeps, body: unknown): Promise<ApiResult> {
  if ((d.commands?.actor ?? null) === null) return OFF;
  const b = parseBody(body, ["id"], true);
  if ("error" in b) return refused(400, b.error);
  const r = await d.store.completeTask(b.id);
  if (!r.ok) return unknown(b.id);
  return { status: 200, value: { task_id: r.task.id, completed: r.completed, next_id: r.next?.id ?? null } };
}

/**
 * POST /api/v1/tasks/reopen with `{ id }`, the store's reopenTask as `factory task reopen` (the Tasks page's ⌘Z): 404 for
 * an unknown task; 409 when a recurring task's next occurrence is done (nothing written); else 200, `reopened` false
 * when it was not done, `removed_next` the open next occurrence it deleted.
 */
export async function writeTaskReopen(d: UiDeps, body: unknown): Promise<ApiResult> {
  if ((d.commands?.actor ?? null) === null) return OFF;
  const b = parseBody(body, ["id"], true);
  if ("error" in b) return refused(400, b.error);
  const r = await d.store.reopenTask(b.id);
  if (r.ok) return { status: 200, value: { task_id: r.task.id, reopened: r.reopened, removed_next: r.removed_next } };
  return r.reason === "next_done" ? refused(409, "its next occurrence is done: undo that one first") : unknown(b.id);
}

/**
 * POST /api/v1/tasks/delete with `{ id }`, the store's deleteTask as `factory task delete`: 404 for an unknown task;
 * 409 naming its open sub-tasks while it has any (nothing written); else 200.
 */
export async function writeTaskDelete(d: UiDeps, body: unknown): Promise<ApiResult> {
  if ((d.commands?.actor ?? null) === null) return OFF;
  const b = parseBody(body, ["id"], true);
  if ("error" in b) return refused(400, b.error);
  const r = await d.store.deleteTask(b.id);
  if (r.ok) return { status: 200, value: { task_id: r.task.id } };
  if (r.reason === "not_found") return unknown(b.id);
  const titles = (await shown(new Withholder(d.scanner), r.sub_tasks)).map((t) => t.title).join(", ");
  return refused(409, `it has open sub-tasks (${titles}): complete or delete them first`);
}

/**
 * POST /api/v1/tasks/sub with `{ parent, id, words }`, the store's addSubTask as `factory task sub`, under the ID the
 * page chose (a resend stores one task): 400 for words the parser refuses; 404 for an unknown parent; 409 when the
 * parent is itself a sub-task (one level); else 200 with the stored sub-task.
 */
export async function writeTaskSub(d: UiDeps, body: unknown): Promise<ApiResult> {
  const actor = d.commands?.actor ?? null;
  if (actor === null) return OFF;
  const b = parseBody(body, ["parent", "id", "words"]);
  if ("error" in b) return refused(400, b.error);
  const parsed = parseQuickAdd(b.words);
  if (!parsed.ok) return refused(400, parsed.reason);
  const r = await d.store.addSubTask(b.parent, { ...parsed.task, id: b.id, created_by: actor });
  if (r.ok) return { status: 200, value: { task: (await shown(new Withholder(d.scanner), [r.task]))[0] } };
  return r.reason === "nested" ? refused(409, "the parent is a sub-task: a sub-task cannot have sub-tasks") : unknown(b.parent);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A schedule body: `{ id, date, time }` and an optional `duration_minutes`, or why it is not one. */
function parseSchedule(body: unknown): { id: string; date: string; time: string; duration_minutes?: number } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !["id", "date", "time", "duration_minutes"].includes(k));
  if (extra) return { error: `unknown field "${extra}"` };
  const id = fieldError("id", b.id, true);
  if (id !== null) return { error: id };
  if (typeof b.date !== "string" || !DATE.test(b.date) || !validDate(b.date)) return { error: "date must be a real date, YYYY-MM-DD" };
  if (typeof b.time !== "string" || !TIME.test(b.time)) return { error: "time must be HH:MM, 24-hour" };
  if (b.duration_minutes !== undefined && durationError(b.duration_minutes) !== null) return { error: durationError(b.duration_minutes)! };
  return b as { id: string; date: string; time: string; duration_minutes?: number };
}

/**
 * POST /api/v1/tasks/schedule with `{ id, date, time }` and an optional `duration_minutes`, the Tasks page's drop on
 * its timeline: the store's updateTask, as `factory task edit <id> <date> <time>` would, so a moved task keeps its
 * stored duration unless one is sent. 400 for a body that is not one; 404 for an unknown task; 409 for a done one;
 * else 200 with the stored task. Every refusal writes nothing.
 */
export async function writeTaskSchedule(d: UiDeps, body: unknown): Promise<ApiResult> {
  if ((d.commands?.actor ?? null) === null) return OFF;
  const b = parseSchedule(body);
  if ("error" in b) return refused(400, b.error);
  const r = await d.store.updateTask(b.id, { due: { date: b.date }, due_time: b.time, ...(b.duration_minutes === undefined ? {} : { duration_minutes: b.duration_minutes }) });
  if (r.ok) return { status: 200, value: { task: (await shown(new Withholder(d.scanner), [r.task]))[0] } };
  return r.reason === "done" ? refused(409, "the task is done: a done task cannot be scheduled") : unknown(b.id);
}

/** Every POST route of this file by path, for server.ts: each after the request guards, with the commands actor's token. */
export const TASK_WRITES: Readonly<Record<string, (d: UiDeps, body: unknown) => Promise<ApiResult>>> = {
  [TASKS_PATH]: writeTask,
  [TASK_BUILD_PATH]: writeTaskBuild,
  [TASK_EDIT_PATH]: writeTaskEdit,
  [TASK_DONE_PATH]: writeTaskDone,
  [TASK_REOPEN_PATH]: writeTaskReopen,
  [TASK_DELETE_PATH]: writeTaskDelete,
  [TASK_SUB_PATH]: writeTaskSub,
  [TASK_SCHEDULE_PATH]: writeTaskSchedule,
};
