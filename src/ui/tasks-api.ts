// POST /api/v1/tasks (design 02-tasks and 09-desktop-app): stores one plain task from quick-add words, for the
// desktop shell's quick-add box. The words go through the same parser as `factory task add` (src/core/quick-add.ts)
// and the task through the same store method, with the ID the caller chose, so a retry stores one task. The task is
// created by the page's commands actor (UiCommands), whose per-process token the request carries. The request guards
// (Host, Origin, Content-Type, CSRF token, body size, JSON) run in server.ts before writeTask is reached; every
// refusal comes before the store write.

import { parseQuickAdd } from "../core/quick-add.js";
import type { ApiResult } from "./api.js";
import type { UiDeps } from "./pages.js";
import { Withholder } from "./withhold.js";

export const TASKS_PATH = "/api/v1/tasks";

/** A caller-chosen task ID: `tk_` and 8 to 64 URL-safe characters (the CLI's own `tk_<random>`). */
const TASK_ID = /^tk_[A-Za-z0-9_-]{8,64}$/;
/** The longest quick-add text taken; a task title is a line, not a document. */
export const MAX_WORDS = 1000;

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
