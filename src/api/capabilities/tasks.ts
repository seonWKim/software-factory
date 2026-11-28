// The tasks capabilities (design 02-tasks, 09-api-registry): tasks.list, the Tasks page's views (GET /api/v1/tasks),
// and tasks.create, one plain task from quick-add words (POST /api/v1/tasks: the Tasks page's and the desktop shell's
// quick-add box). The handlers stay in src/ui/tasks-api.ts (readTasks, writeTask); tasks.create stores the task with
// the store's addTask, the method `factory task add` and the chat's add_task call too. The registry's write route
// checks the pauses token, the same per-process token the page reads as csrf_token. The handlers are imported inside
// each run, so scripts/gen-api.mjs never loads them; writeTask still checks the ID and the words itself.

import type { ApiResult } from "../../ui/api.js";
import { type Declared, type Refusal, declare } from "../registry.js";
import { array, boolean, jsonObject, nullable, object, optional, string } from "../schema.js";

const handlers = () => import("../../ui/tasks-api.js");
const answer = async <T>(r: Promise<ApiResult>): Promise<T | Refusal> => (await import("../../ui/api.js")).answerOf<T>(await r);

/** The Tasks page's views, as readTasks answers them: each row and event a JSON object, its strings withheld. */
const TASKS_OUTPUT = object({
  as_of: string(), today_date: string(), today: jsonObject(), upcoming: array(jsonObject()), projects: array(jsonObject()),
  active_projects: array(jsonObject()), calendar: array(jsonObject()), csrf_token: nullable(string()), can_build: boolean(), add_key: string(),
});

export const TASKS: readonly Declared[] = [
  declare({
    id: "tasks.list", area: "tasks",
    description: "The plain tasks' views (Today, Upcoming and Projects by #list): the open tasks and the recently done ones, with the stored calendar events; "
      + "?project=<slug> keeps only that task project's tasks (400 for an archived project, 404 for an unknown one).",
    permission: "read", method: "GET", path: "/api/v1/tasks",
    input: object({ project: optional(string()) }), output: TASKS_OUTPUT,
    run: async (c, i) => answer((await handlers()).readTasks(c.d, i.project ?? null)),
  }),
  declare({
    id: "tasks.create", area: "tasks",
    description: "Add one plain task from quick-add words (today, tomorrow or YYYY-MM-DD, HH:MM, !1 to !3, #list, +project, every day/week/month; the rest is its title) "
      + "under the caller's id (tk_ and 8 to 64 characters), so a retry adds one task; project is the page's tab unless the words name one.",
    permission: "owner", method: "POST", path: "/api/v1/tasks",
    input: object({ id: string(), words: string(), project: optional(string()) }), output: object({ task: jsonObject() }),
    run: async (c, i) => answer((await handlers()).writeTask(c.d, i)),
  }),
];
