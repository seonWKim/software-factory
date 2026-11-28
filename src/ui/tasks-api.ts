// The plain tasks' handlers (design 02-tasks). readTasks (the Tasks page's views, with the stored calendar events) and
// writeTask (one plain task from quick-add words, the Tasks page's and the desktop shell's quick-add box) run behind the
// tasks.list and tasks.create capabilities (GET and POST /api/v1/tasks, src/api/capabilities/tasks.ts); their routes
// are the API registry's. The routes of this file: POST /api/v1/tasks/edit, /done, /reopen, /delete and /sub, the
// page's row actions, each calling the store method of its CLI command (`factory task edit`, `done`, `reopen`,
// `delete`, `sub`), so the page and the CLI cannot diverge; POST /api/v1/tasks/body, the description dialog (the
// store's setTaskBody); POST /api/v1/tasks/build, its Build this button (task-build.ts, the same action as `factory
// task build`); POST /api/v1/tasks/create, a task in a project built at once (createProjectTask, the same action as
// `factory task create --project`). writeTask's words go through the same parser as `factory task add`
// (src/core/quick-add.ts) and the task through the same store method (addTask), with the ID the caller chose, so a
// retry stores one task, created by the page's commands actor (UiCommands). The request guards (Host, Origin,
// Content-Type, CSRF token, body size, JSON) run before any handler; every refusal comes before the store write. GET
// /api/v1/tasks/preview runs the same parser on the quick-add field's words as the owner types, and writes nothing.

import { readCalendar } from "../calendar/index.js";
import { needsDueDate, parseQuickAdd, parseQuickEdit } from "../core/quick-add.js";
import { buildTask, createProjectTask } from "../core/task-build.js";
import { isProjectSlug } from "../core/projects.js";
import { MAX_TASK_BODY, ProjectRefused, type Task, type TaskStore, doneWindow, dueDate, projectRefusal, taskBody, taskViews } from "../core/tasks.js";
import type { CloseReason } from "../core/types.js";
import { TASK_LIST_LIMIT } from "../core/local-cli.js";
import type { ApiResult } from "./api.js";
import type { UiDeps } from "./deps.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import { TASKS_ADD_KEYS, type TasksAddKey } from "../runtime/settings/tasks-add-key.setting.js";
import { Withholder } from "./withhold.js";
import { PROJECTS_PATH, PROJECT_DELETE_PATH, TASK_PROJECT_PATH, writeProject, writeProjectDelete, writeTaskProject } from "./projects-api.js";

export const TASK_BUILD_PATH = "/api/v1/tasks/build";
export const TASK_CREATE_PATH = "/api/v1/tasks/create";
export const TASK_EDIT_PATH = "/api/v1/tasks/edit";
export const TASK_DONE_PATH = "/api/v1/tasks/done";
export const TASK_REOPEN_PATH = "/api/v1/tasks/reopen";
export const TASK_DELETE_PATH = "/api/v1/tasks/delete";
export const TASK_SUB_PATH = "/api/v1/tasks/sub";
export const TASK_BODY_PATH = "/api/v1/tasks/body";
export const TASK_PREVIEW_PATH = "/api/v1/tasks/preview";

/** A caller-chosen task ID: `tk_` and 8 to 64 URL-safe characters (the CLI's own `tk_<random>`). */
const TASK_ID = /^tk_[A-Za-z0-9_-]{8,64}$/;
/** The longest task ID Build this takes. */
const MAX_ID = 200;
/** The longest quick-add text taken; a task title is a line, not a document. */
export const MAX_WORDS = 1000;

/** Each task's or event's title, and a task's description, through the Withholder, as on the other routes. */
async function shown<T extends { title: string; body?: string | null }>(w: Withholder, rows: readonly T[]): Promise<T[]> {
  return Promise.all(rows.map(async (t) => ({
    ...t, title: (await w.plain(t.title)).text, ...(typeof t.body === "string" ? { body: (await w.plain(t.body)).text } : {}),
  })));
}

/**
 * tasks.list (GET /api/v1/tasks): the views (Today, Upcoming, Projects (the All view, by #list); core/tasks.ts taskViews) of the open
 * tasks and the done tasks of the last DONE_WINDOW_DAYS days (doneWindow; each with its done_at, design 02-tasks, done
 * tasks stay) at the server's clock, in its time zone, with the calendar events stored by the last syncs placed in Today
 * and Upcoming, and `calendar`, each source's last sync time and whether its last sync failed. Each task row carries
 * `projects`, the slugs of its active task projects, and `active_projects` lists the active projects (slug and name)
 * for the page's project switcher, and `close_reason`, a linked task's item's close reason (open or done) when it closed without a merge
 * (closeReasons; else null), `reject_reason` (an open task whose item was rejected with no replacement, closeReasons), `link_note`
 * (`Moved from wi_…` on a task that followed its rejected item's replacement; else null), and `open_sub_tasks`, how many open sub-tasks it has over every stored task (counted before the
 * project filter), so the delete dialog knows before it opens. With `project` (a slug, `?project=`) the views hold only the tasks, open or done, linked to
 * that project: 400 for a value that is not a slug or an archived project, 404 for an unknown one. Reads the stored
 * copy only: no source is called and nothing is written. `csrf_token` and `can_build` for Build this (null and false
 * when the commands route is off). `add_key`, the quick-add field's submit key: the `tasks_add_key` setting's stored
 * global value.
 */
export async function readTasks(d: UiDeps, project: string | null = null): Promise<ApiResult> {
  const refusal = await projectFilterRefusal(d.store, project);
  if (refusal !== null) return refusal;
  const now = d.clock.now();
  const w = new Withholder(d.scanner);
  const done = (await d.store.listDoneTasks(doneWindow(now, null))).tasks;
  const listed = await shown(w, [...await d.store.listTasks(TASK_LIST_LIMIT), ...done]);
  const slugs = await d.store.listTaskProjectSlugs(listed.map((t) => t.id));
  const reasons = await closeReasons(d, w, listed);
  const subs = await d.store.countOpenSubTasks();
  const rows = listed.map((t) => ({
    ...t, projects: slugs[t.id] ?? [], close_reason: reasons.get(t.id)?.close_reason ?? null, reject_reason: reasons.get(t.id)?.reject_reason ?? null,
    link_note: (t as Task & { link_note?: string | null }).link_note ?? null, open_sub_tasks: subs[t.id] ?? 0,
  }));
  const kept = project === null ? rows : rows.filter((t) => t.projects.includes(project));
  const active_projects = await Promise.all((await d.store.listProjects("active")).map(async (p) => ({ slug: p.slug, name: (await w.plain(p.name)).text })));
  const calendar = await readCalendar(storeSql(d.store));
  // The Tasks views show an event's title and time only; its details are the Calendar page's (calendar-events-api.ts).
  const events = await shown(w, calendar.events.map(({ details: _, ...e }) => e));
  const can_build = (d.commands?.actor ?? null) !== null;
  const add_key = await readAddKey(d);
  return {
    status: 200,
    value: {
      as_of: now.toISOString(), ...taskViews(kept, now, events), active_projects, calendar: calendar.sources, csrf_token: d.commands?.token ?? null, can_build, add_key,
    },
  };
}

/**
 * The close reason of each linked task's work item, open or done, read from the item now (design 02-tasks), only for an
 * item closed without a merge; a merged item's row shows its state instead. An open task's item closed as rejected or
 * wont_do says so on the row. An open task still linked to an item closed as rejected (no replacement took it, design
 * 02-tasks-build) also gets `reject_reason`, the item's reject reason through the Withholder (`no reason given` when
 * none was stored); else null.
 */
async function closeReasons(d: UiDeps, w: Withholder, tasks: readonly Task[]): Promise<Map<string, { close_reason: CloseReason; reject_reason: string | null }>> {
  const out = new Map<string, { close_reason: CloseReason; reject_reason: string | null }>();
  for (const t of tasks) {
    if (t.work_item_id === null) continue;
    const item = await d.store.getWorkItem(t.work_item_id);
    if (item?.stage !== "CLOSED" || item.close_reason === null || item.merge_sha !== null) continue;
    const rejected = item.close_reason === "rejected" && t.done_at === null;
    const reason = item.spec_feedback?.trim() || NO_REASON;
    out.set(t.id, { close_reason: item.close_reason, reject_reason: rejected ? (await w.plain(reason)).text : null });
  }
  return out;
}

/** `reject_reason` of a task whose item was rejected with an empty reason. */
const NO_REASON = "no reason given";

/**
 * Why a `?project=` filter is refused, or null for none or an active project: 400 for a value that is not a slug or an
 * archived project, 404 for an unknown one. GET /api/v1/tasks and GET /api/v1/items both answer with it.
 */
export async function projectFilterRefusal(store: Pick<TaskStore, "getProjectBySlug">, project: string | null): Promise<ApiResult | null> {
  if (project === null) return null;
  if (!isProjectSlug(project)) return refused(400, "project must be a project slug, e.g. home-repairs");
  const p = await store.getProjectBySlug(project);
  if (p === null) return refused(404, projectRefusal(project, "not_found"));
  if (p.archived_at !== null) return refused(400, projectRefusal(project, "archived"));
  return null;
}

/**
 * GET /api/v1/items?project=<slug> (the Tasks page's Factory work, design 09-dashboard-app): only the rows whose source
 * task is in that active project, from one store read for every listed row; all of them with no project.
 */
export async function inProject<T extends { item: { id: string } }>(store: Pick<TaskStore, "listWorkItemProjectSlugs">, project: string | null, rows: T[]): Promise<T[]> {
  if (project === null) return rows;
  const slugs = await store.listWorkItemProjectSlugs(rows.map((r) => r.item.id));
  return rows.filter((r) => slugs[r.item.id]?.includes(project) ?? false);
}

/**
 * GET /api/v1/tasks/preview?words=<text>: what tasks.create would store for these words, from the same parser
 * (parseQuickAdd), with the due day resolved at the server's clock: `ok`, the title, `due_date`, `due_time`,
 * `recurrence`, `projects` (the `+slug`s typed), `priority`, `list`, `duration_minutes` and `unread`, the title words
 * that look like quick-add words but were not read (an `every …` that does not end the text). Words the parser refuses
 * answer 200 with `ok` false and its reason; no `words` or more than MAX_WORDS characters answer 400. Reads no store
 * row and writes nothing; the title and unread words leave through the Withholder.
 */
export async function readTaskPreview(d: UiDeps, words: string | null): Promise<ApiResult> {
  if (words === null || words.length > MAX_WORDS) return refused(400, `words must be a string of at most ${MAX_WORDS} characters`);
  const parsed = parseQuickAdd(words);
  if (!parsed.ok) return { status: 200, value: { ok: false, reason: parsed.reason } };
  const w = new Withholder(d.scanner);
  const { task } = parsed;
  return {
    status: 200,
    value: {
      ok: true,
      title: (await w.plain(task.title)).text,
      due_date: task.due === null ? null : dueDate(task.due, d.clock.now()),
      due_time: task.due_time,
      recurrence: task.recurrence,
      projects: task.projects ?? [],
      priority: task.priority,
      list: task.list,
      duration_minutes: task.duration_minutes ?? null,
      unread: await Promise.all(parsed.unread.map(async (u) => (await w.plain(u)).text)),
    },
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

/**
 * POST /api/v1/tasks/create with `{ id, title, body, project }`, after the request guards: the same action as `factory
 * task create --title <t> --body-file <f> --project <slug>` (createProjectTask): a task under the caller's ID in task
 * project `project`, built at once as a local work item whose problem holds `body`. 400 for a body that is not one;
 * 503 with no actor; 409 for an unknown or archived project or no stored project key (nothing written); else 200 with
 * the task's and the work item's IDs. A retry with the same ID adds nothing and answers the same item.
 */
export async function writeTaskCreate(d: UiDeps, body: unknown): Promise<ApiResult> {
  const actor = d.commands?.actor ?? null;
  if (actor === null) return OFF;
  const b = parseBody(body, ["id", "title", "body", "project"]);
  if ("error" in b) return refused(400, b.error);
  const project = (await d.settings?.resolveProject())?.key ?? null;
  const r = await createProjectTask(d.store, { task_id: b.id, title: b.title.trim(), body: b.body.trim(), slug: b.project, project, user: actor });
  if (!r.ok) return refused(409, r.reason);
  return { status: 200, value: { task_id: r.task.id, work_item_id: r.item.id, created: r.created } };
}

type Field = "id" | "words" | "parent" | "title" | "body" | "project";

/** Why `v` is not a valid value for the field, or null. `id` is a new task's ID; `parent` (and `id` with `stored`) any stored one. */
function fieldError(k: Field, v: unknown, stored: boolean): string | null {
  if (k === "words") return typeof v === "string" && v.length <= MAX_WORDS ? null : `words must be a string of at most ${MAX_WORDS} characters`;
  if (k === "title") return typeof v === "string" && v.trim() !== "" && v.length <= MAX_WORDS ? null : `title must be a non-empty string of at most ${MAX_WORDS} characters`;
  if (k === "body") return typeof v === "string" && v.length <= MAX_TASK_BODY ? null : `body must be a string of at most ${MAX_TASK_BODY} characters`;
  if (k === "project") return typeof v === "string" && isProjectSlug(v) ? null : "project must be a project slug, e.g. home-repairs";
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

/** A store write whose `+slug` names an unknown or archived project: 400 with its reason; the store wrote nothing. */
async function orProjectRefused(write: () => Promise<ApiResult>): Promise<ApiResult> {
  try {
    return await write();
  } catch (err) {
    if (err instanceof ProjectRefused) return refused(400, err.message);
    throw err;
  }
}

/**
 * tasks.create (POST /api/v1/tasks) with `{ id, words }` and optionally `project` (a slug: the Tasks page's tab, the task's project unless
 * the words name one with `+slug`), after the request guards: 400 for a body that is not one, words the
 * parser refuses (its reason) or a project, typed or sent, that is unknown or archived; 503 when the page has no actor; else 200 with the stored task (the one already stored
 * under that ID on a retry). The title leaves through the Withholder, as on the other routes.
 */
export async function writeTask(d: UiDeps, body: unknown): Promise<ApiResult> {
  const actor = d.commands?.actor ?? null;
  if (actor === null) return OFF;
  // `project` is optional: the Tasks page's tab. A `+slug` in the words replaces it.
  const tabbed = typeof body === "object" && body !== null && "project" in body;
  const b = parseBody(body, tabbed ? ["id", "words", "project"] : ["id", "words"]);
  if ("error" in b) return refused(400, b.error);
  const parsed = parseQuickAdd(b.words);
  if (!parsed.ok) return { status: 400, value: { error: parsed.reason } };
  const projects = parsed.task.projects ?? (tabbed ? [(b as { project: string }).project] : undefined);
  return orProjectRefused(async () => {
    const task = await d.store.addTask({ ...parsed.task, ...(projects ? { projects } : {}), id: b.id, created_by: actor });
    const title = (await new Withholder(d.scanner).plain(task.title)).text;
    return { status: 200, value: { task: { ...task, title } } };
  });
}

/**
 * POST /api/v1/tasks/edit with `{ id, words }`, the store's updateTask as `factory task edit`: the title and the
 * quick-add words for date, time, duration, priority and list, each field named by the words and only those; recurrence is not
 * edited here; `+slug` adds the task to that project. 400 for words the parser refuses, a recurrence, or an unknown or archived project; 404 for an unknown task; 409 for a done one; else
 * 200 with the stored task. Every refusal writes nothing.
 */
export async function writeTaskEdit(d: UiDeps, body: unknown): Promise<ApiResult> {
  if ((d.commands?.actor ?? null) === null) return OFF;
  const b = parseBody(body, ["id", "words"], true);
  if ("error" in b) return refused(400, b.error);
  const parsed = parseQuickEdit(b.words);
  if (!parsed.ok) return refused(400, parsed.reason);
  if (parsed.edit.recurrence !== undefined) return refused(400, "a task's recurrence is not edited here: leave out every day, every week or every month");
  return orProjectRefused(async () => {
    const r = await d.store.updateTask(b.id, parsed.edit);
    if (r.ok) return { status: 200, value: { task: (await shown(new Withholder(d.scanner), [r.task]))[0] } };
    if (r.reason === "needs_due_date") return refused(409, needsDueDate(r.recurrence));
    return r.reason === "done" ? refused(409, "the task is done: a done task cannot be edited") : unknown(b.id);
  });
}

/**
 * POST /api/v1/tasks/body with `{ id, body }`, the store's setTaskBody: the task's description, trimmed, an empty one
 * stored as none (taskBody). A built task's work item keeps the text it was built with. 400 for a body that is not one
 * or a description over MAX_TASK_BODY; 404 for an unknown task; 409 for a done one; else 200 with the stored task.
 * Every refusal writes nothing.
 */
export async function writeTaskBody(d: UiDeps, body: unknown): Promise<ApiResult> {
  if ((d.commands?.actor ?? null) === null) return OFF;
  const b = parseBody(body, ["id", "body"], true);
  if ("error" in b) return refused(400, b.error);
  const text = taskBody(b.body);
  if (!text.ok) return refused(400, text.reason);
  const r = await d.store.setTaskBody(b.id, text.body);
  if (r.ok) return { status: 200, value: { task: (await shown(new Withholder(d.scanner), [r.task]))[0] } };
  return r.reason === "done" ? refused(409, "the task is done: a done task's description cannot be edited") : unknown(b.id);
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
 * 409 naming its open sub-tasks while it has any (nothing written); else 200. With `with_sub_tasks: true` (the delete
 * dialog's "delete with sub-tasks") every sub-task, open and done, is deleted with it in one transaction, and the 200
 * names them in `deleted_sub_tasks`; a `with_sub_tasks` that is not a boolean is 400.
 */
export async function writeTaskDelete(d: UiDeps, body: unknown): Promise<ApiResult> {
  if ((d.commands?.actor ?? null) === null) return OFF;
  const flagged = typeof body === "object" && body !== null && "with_sub_tasks" in body;
  const with_sub_tasks = flagged ? (body as { with_sub_tasks: unknown }).with_sub_tasks : false;
  if (typeof with_sub_tasks !== "boolean") return refused(400, "with_sub_tasks must be true or false");
  const b = parseBody(flagged ? Object.fromEntries(Object.entries(body).filter(([k]) => k !== "with_sub_tasks")) : body, ["id"], true);
  if ("error" in b) return refused(400, b.error);
  const r = await d.store.deleteTask(b.id, { with_sub_tasks });
  if (r.ok) return { status: 200, value: { task_id: r.task.id, deleted_sub_tasks: r.deleted.map((t) => t.id) } };
  if (r.reason === "not_found") return unknown(b.id);
  const titles = (await shown(new Withholder(d.scanner), r.sub_tasks)).map((t) => t.title).join(", ");
  return refused(409, `it has open sub-tasks (${titles}): complete or delete them first`);
}

/**
 * POST /api/v1/tasks/sub with `{ parent, id, words }`, the store's addSubTask as `factory task sub`, under the ID the
 * page chose (a resend stores one task): 400 for words the parser refuses or an unknown or archived `+slug` project; 404 for an unknown parent; 409 when the
 * parent is itself a sub-task (one level); else 200 with the stored sub-task.
 */
export async function writeTaskSub(d: UiDeps, body: unknown): Promise<ApiResult> {
  const actor = d.commands?.actor ?? null;
  if (actor === null) return OFF;
  const b = parseBody(body, ["parent", "id", "words"]);
  if ("error" in b) return refused(400, b.error);
  const parsed = parseQuickAdd(b.words);
  if (!parsed.ok) return refused(400, parsed.reason);
  return orProjectRefused(async () => {
    const r = await d.store.addSubTask(b.parent, { ...parsed.task, id: b.id, created_by: actor });
    if (r.ok) return { status: 200, value: { task: (await shown(new Withholder(d.scanner), [r.task]))[0] } };
    return r.reason === "nested" ? refused(409, "the parent is a sub-task: a sub-task cannot have sub-tasks") : unknown(b.parent);
  });
}

/** Every POST route of this file and projects-api.ts by path, for server.ts: each after the request guards, with the commands actor's token. */
export const TASK_WRITES: Readonly<Record<string, (d: UiDeps, body: unknown) => Promise<ApiResult>>> = {
  [TASK_BUILD_PATH]: writeTaskBuild,
  [TASK_CREATE_PATH]: writeTaskCreate,
  [TASK_EDIT_PATH]: writeTaskEdit,
  [TASK_DONE_PATH]: writeTaskDone,
  [TASK_REOPEN_PATH]: writeTaskReopen,
  [TASK_DELETE_PATH]: writeTaskDelete,
  [TASK_SUB_PATH]: writeTaskSub,
  [TASK_BODY_PATH]: writeTaskBody,
  [TASK_PROJECT_PATH]: writeTaskProject,
  [PROJECTS_PATH]: writeProject,
  [PROJECT_DELETE_PATH]: writeProjectDelete,
};
