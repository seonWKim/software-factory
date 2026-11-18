// The Tasks page: GET /api/v1/tasks (useTasks), POST /api/v1/tasks (postTaskAdd), /api/v1/tasks/build (postTaskBuild),
// the row actions under /api/v1/tasks (postTaskAction: edit, done, reopen, delete and sub), POST /api/v1/projects
// (postProject) and POST /api/v1/tasks/project (postTaskProject).

import { useQuery } from "@tanstack/react-query";
import { t } from "../i18n/index.js";
import { POLL_MS, getJson, postJson } from "./client.js";
import { API, type TaskAction } from "./routes.js";

/** One open plain task on the Tasks page (design 02-tasks, issue #607). */
export interface TaskRow {
  id: string;
  title: string;
  /** A free `#label`, without the `#`. */
  list: string | null;
  priority: number | null;
  /** `YYYY-MM-DD`, or null. */
  due_date: string | null;
  due_time: string | null;
  /** How long it takes, in minutes; null: planned as 30 minutes (absent from an older server). */
  duration_minutes?: number | null;
  recurrence: string | null;
  /** The work item Build this made from it, or null. */
  work_item_id: string | null;
  /** The task this is a sub-task of (one level), or null. */
  parent_task_id?: string | null;
  /** The slugs of its active task projects (absent from an older server). */
  projects?: string[];
  /** When it was done (ISO time): a done task of the last 30 days stays in the views, struck through; null or absent: open. */
  done_at?: string | null;
  /**
   * A done task's linked work item's close reason, read from the item when the page is read, when it closed without a
   * merge (design 02-tasks); null or absent otherwise.
   */
  close_reason?: "completed" | "duplicate" | "wont_do" | "failed" | "rejected" | null;
}

/** An active task project, as the Tasks page's switcher and project dialog list it. */
export interface ProjectChoice {
  slug: string;
  name: string;
}

/**
 * A stored calendar event placed on one day beside the tasks (design 02-tasks, calendar views). `time`: the local
 * `HH:MM` it starts that day ("00:00" when it began earlier); null for an all-day event.
 */
export interface EventRow {
  kind: "event";
  source: string;
  id: string;
  title: string;
  all_day: boolean;
  time: string | null;
}

/** One entry of a day in Today and Upcoming: a task, or an event. */
export type DayRow = TaskRow | EventRow;

export const isEventRow = (r: DayRow): r is EventRow => "kind" in r && r.kind === "event";

/** A calendar source's last sync: when it last succeeded (null: never) and whether its last read failed. */
export interface CalendarSync {
  source: string;
  synced_at: string | null;
  failed: boolean;
}

/**
 * `/api/v1/tasks`: the open tasks and the done tasks of the last 30 days placed by due date at the server's local midnight, with the stored calendar events
 * in Today and Upcoming (all-day first, then timed tasks and events by time, then untimed tasks); `calendar`, each
 * source's last sync (absent from an older server); `csrf_token` and `can_build` for Build this (null and false when
 * the page has no commands actor).
 */
export interface TasksView {
  today_date: string;
  today: { overdue: TaskRow[]; due: DayRow[] };
  upcoming: { date: string; tasks: DayRow[] }[];
  /** The All view: every task, open or done, undated included, under its #list. */
  projects: { list: string | null; tasks: TaskRow[] }[];
  /** The active task projects, by slug (absent from an older server). */
  active_projects?: ProjectChoice[];
  calendar?: CalendarSync[];
  csrf_token: string | null;
  can_build: boolean;
}

/**
 * The tasks' read, polled as useApi is; `project` filters it to that task project's tasks. Its key starts with the
 * tasks' key, so a row action's reload of the tasks reloads it whatever the filter.
 */
export function useTasks<T>(project: string | null) {
  const url = API.tasksIn(project);
  return useQuery({
    queryKey: [API.tasks, "open", project],
    queryFn: () => getJson<T>(url),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** POST /api/v1/tasks/build: Build this. The work item's ID; a refusal (409, 503, …) comes back as `{ ok: false, error }`. */
export async function postTaskBuild(token: string, id: string): Promise<{ ok: true; work_item_id: string } | { ok: false; error: string }> {
  const r = await postJson<{ work_item_id?: string; error?: string }>(API.taskBuild, token, { id });
  if (r.ok) return { ok: true, work_item_id: r.value.work_item_id ?? "" };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** POST /api/v1/tasks: quick-add words under the page's own `tk_` ID, with the tab's project slug when one is selected (a resend stores one task). A refusal comes back as `{ ok: false, error }`. */
export async function postTaskAdd(token: string, id: string, words: string, project: string | null = null): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(API.tasks, token, project === null ? { id, words } : { id, words, project });
  return r.ok ? { ok: true } : { ok: false, error: r.value.error ?? `HTTP ${r.status}` };
}

/** POST /api/v1/projects: a new task project under the page's own `pj_` ID (a resend stores nothing more). A refusal comes back as `{ ok: false, error }`. */
export async function postProject(token: string, id: string, name: string): Promise<{ ok: true; project: ProjectChoice } | { ok: false; error: string }> {
  const r = await postJson<{ project?: ProjectChoice; error?: string }>(API.projects, token, { id, name });
  if (r.ok && r.value.project) return { ok: true, project: r.value.project };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** POST /api/v1/tasks/project: adds the task to the project (`add`) or removes it. A refusal comes back as `{ ok: false, error }`. */
export async function postTaskProject(token: string, id: string, project: string, add: boolean): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const r = await postJson<{ changed?: boolean; error?: string }>(API.taskProject, token, { id, project, add });
  return r.ok ? { ok: true, changed: r.value.changed ?? false } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/**
 * POST /api/v1/tasks/<action>: a row action (edit `{ id, words }`, done and delete `{ id }`, sub `{ parent, id, words }`),
 * or ⌘Z's undo of a completion (reopen `{ id }`).
 * A refusal (400, 404, 409, …) comes back as `{ ok: false, error }` with the server's reason.
 */
export async function postTaskAction(token: string, action: TaskAction, body: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(API.taskAction(action), token, body);
  return r.ok ? { ok: true } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}
