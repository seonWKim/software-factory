// Design 02-tasks (2026-11-14): the key that adds a task from the Tasks page quick-add field. A dashboard setting:
// only GET /api/v1/tasks reads it (src/ui/tasks-api.ts), from its stored global override, else this default. The
// desktop quick-add box is not affected.

import { defineSetting } from "../../shared/setting.js";

/** The choices, the default first: `enter` adds on Enter; `cmd-enter` adds on ⌘Enter only, and plain Enter does nothing. */
export const TASKS_ADD_KEYS = ["enter", "cmd-enter"] as const;
export type TasksAddKey = (typeof TASKS_ADD_KEYS)[number];

export default defineSetting<TasksAddKey>({
  key: "tasks_add_key",
  owner: "runtime",
  type: "enum",
  default: TASKS_ADD_KEYS[0],
  description: "Which key adds a task from the Tasks page quick-add field: enter or cmd-enter.",
  applies: "the next load of the Tasks page",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
