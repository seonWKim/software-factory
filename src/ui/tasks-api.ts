// The plain tasks' routes (design 02-tasks): GET /api/v1/tasks, the Tasks page's views; POST /api/v1/tasks/build,
// its Build this button (task-build.ts, the same action as `factory task build`); and POST /api/v1/tasks, which
// stores one plain task from quick-add words, for the desktop shell's quick-add box. The words go through the same parser as `factory task add` (src/core/quick-add.ts)
// and the task through the same store method, with the ID the caller chose, so a retry stores one task. The task is
// created by the page's commands actor (UiCommands), whose per-process token the request carries. The request guards
// (Host, Origin, Content-Type, CSRF token, body size, JSON) run in server.ts before writeTask is reached; every
// refusal comes before the store write.

import { parseQuickAdd } from "../core/quick-add.js";
import { buildTask } from "../core/task-build.js";
import { type Task, type TaskViews, taskViews } from "../core/tasks.js";
import { TASK_LIST_LIMIT } from "../core/local-cli.js";
import type { ApiResult } from "./api.js";
import type { UiDeps } from "./pages.js";
import { Withholder } from "./withhold.js";

export const TASKS_PATH = "/api/v1/tasks";
export const TASK_BUILD_PATH = "/api/v1/tasks/build";

/** A caller-chosen task ID: `tk_` and 8 to 64 URL-safe characters (the CLI's own `tk_<random>`). */
const TASK_ID = /^tk_[A-Za-z0-9_-]{8,64}$/;
/** The longest task ID Build this takes. */
const MAX_ID = 200;
/** The longest quick-add text taken; a task title is a line, not a document. */
export const MAX_WORDS = 1000;

/** Each task's title through the Withholder, as on the other routes. */
async function shown(d: UiDeps, tasks: readonly Task[]): Promise<Task[]> {
  const w = new Withholder(d.scanner);
  return Promise.all(tasks.map(async (t) => ({ ...t, title: (await w.plain(t.title)).text })));
}

/**
 * GET /api/v1/tasks: the open tasks' views (Inbox, Today, Upcoming, Projects; core/tasks.ts taskViews) at the server's
 * clock, in its time zone; `csrf_token` and `can_build` for Build this (null and false when the commands route is off).
 */
export async function readTasks(d: UiDeps): Promise<ApiResult> {
  const now = d.clock.now();
  const open = await shown(d, await d.store.listTasks(TASK_LIST_LIMIT));
  const views: TaskViews = taskViews(open, now);
  const can_build = (d.commands?.actor ?? null) !== null;
  return { status: 200, value: { as_of: now.toISOString(), ...views, csrf_token: d.commands?.token ?? null, can_build } };
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

/** The body as `{ id, words }`, or why it is not one. */
function parseBody(body: unknown): { id: string; words: string } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => k !== "id" && k !== "words");
  if (extra) return { error: `unknown field "${extra}"` };
  if (typeof b.id !== "string" || !TASK_ID.test(b.id)) return { error: "id must be tk_ and 8 to 64 letters, digits, - or _" };
  if (typeof b.words !== "string" || b.words.length > MAX_WORDS) return { error: `words must be a string of at most ${MAX_WORDS} characters` };
  return { id: b.id, words: b.words };
}

/**
 * POST /api/v1/tasks with `{ id, words }`, after the request guards: 400 for a body that is not one or words the
 * parser refuses (its reason); 503 when the page has no actor; else 200 with the stored task (the one already stored
 * under that ID on a retry). The title leaves through the Withholder, as on the other routes.
 */
export async function writeTask(d: UiDeps, body: unknown): Promise<ApiResult> {
  const actor = d.commands?.actor ?? null;
  if (actor === null) return { status: 503, value: { error: "Tasks are off: this server is not on loopback, so it needs ui.user_id." } };
  const b = parseBody(body);
  if ("error" in b) return { status: 400, value: { error: b.error } };
  const parsed = parseQuickAdd(b.words);
  if (!parsed.ok) return { status: 400, value: { error: parsed.reason } };
  const task = await d.store.addTask({ ...parsed.task, id: b.id, created_by: actor });
  const title = (await new Withholder(d.scanner).plain(task.title)).text;
  return { status: 200, value: { task: { ...task, title } } };
}
