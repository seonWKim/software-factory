import type { FactoryStore } from "../interfaces/factory-store.js";
import { dependsOnLines } from "./coordination.js";
export { LOCAL_ID, dependsOnId, localItemOf } from "./coordination.js";
import { ProjectRefused, type Task, projectRefusal, taskBody } from "./tasks.js";
import type { UserId, WorkItem, WorkItemId } from "./types.js";

/**
 * The dependency edge of a local item (design 05-dependencies): a `Depends on: <id>` line in its problem, naming a
 * wi_ (work item) or tk_ (task) id. `task create --depends-on`, an approved yes to triage's "Depends on wi_X? yes/no"
 * and `/hold <id>` all write this one line; the local source reads it.
 */
export const dependsOnLine = (id: string): string => `Depends on: ${id}`;

/**
 * Records `item`'s edge to `dep` (the local item a `--depends-on` id names, by its source id) as soon as the item is
 * created (design 05-dependencies, 2026-11-27): the claim holds a queued implement run on an unmerged edge, and the
 * coordination pass, which otherwise writes the edge from the `Depends on:` line, may come only after a free worker
 * has claimed the run that the spec's approval queued. The links stay unread, so that pass still reads them.
 */
export async function recordDependsOn(
  store: Pick<FactoryStore, "replaceDependencyEdges">, item: Pick<WorkItem, "id">, dep: Pick<WorkItem, "source">,
): Promise<void> {
  await store.replaceDependencyEdges(item.id, [{ depends_on: dep.source.id, kind: "depends_on" }]);
}

/** `task create --help`: its flags, `--depends-on` among them. */
export const CREATE_HELP = "--title <t> --body-file <f> [--project <project_slug>] [--depends-on <id>]. `--depends-on <id>` writes a " +
  "`Depends on: <id>` line in the item's problem, so its implement run (and every phase's, if it is split) waits until that local item (wi_… or its short ID, `wi_` optional, or a built task tk_…) merges";


/** The wi_ and tk_ ids on the `Depends on:` lines of `text`, in order, each once. */
export function dependsOnIds(text: string): string[] {
  return [...new Set(dependsOnLines(text).flatMap((l) => [...l.matchAll(/\b(?:wi|tk)_[\w-]+/g)].map((m) => m[0])))];
}

/** `text` with a `Depends on:` line for each of `ids` it does not name yet, after a blank line; `text` itself when none is missing. */
export function withDependsOn(text: string, ids: readonly string[]): string {
  const have = dependsOnIds(text);
  const missing = [...new Set(ids)].filter((id) => !have.includes(id));
  return missing.length === 0 ? text : [text.trimEnd(), missing.map(dependsOnLine).join("\n")].filter((t) => t !== "").join("\n\n");
}

/**
 * Triage's dependency proposal (design 04-triage): a request that says it runs after another local item is asked as
 * this yes/no decision, never as free text; an approved yes writes the item's `Depends on: <id>` line.
 */
export const dependencyQuestion = (id: string): string => `Depends on ${id}? yes/no`;
const DEPENDENCY_QUESTION = /^\s*Depends on ((?:wi|tk)_[\w-]+)\?\s*yes\/no\s*$/i;
/** The options of a dependency proposal, whatever triage wrote. */
export const DEPENDENCY_OPTIONS: readonly string[] = ["yes", "no"];

/** The wi_ or tk_ id a dependency proposal's question names; null for any other question. */
export function proposedDependency(question: string): string | null {
  return DEPENDENCY_QUESTION.exec(question)?.[1] ?? null;
}

/** Whether an answer to a dependency proposal is yes (`yes`, `Yes, wait`); anything else is no. */
export const answersYes = (answer: string | null): boolean => /^\s*yes\b/i.test(answer ?? "");

/**
 * The ids a local item's `Depends on:` lines must name (design 05-dependencies, 2026-11-20): each item the owner
 * answered yes to in a dependency proposal (`answers`, the approval's), then each line of the request as filed
 * (`task create --depends-on`), which triage's spec replaces; never the item itself. None for an item of another source.
 */
export function wantedDependsOn(
  it: Pick<WorkItem, "id" | "source" | "issue_text">, answers: readonly { question: string; answer: string | null }[],
): string[] {
  if (it.source.type !== "local") return [];
  const yes = answers.flatMap((a) => {
    const id = proposedDependency(a.question);
    return id !== null && answersYes(a.answer) ? [id] : [];
  });
  return [...new Set([...yes, ...dependsOnIds(it.issue_text ?? "")])].filter((id) => id !== it.id);
}


/**
 * Build this (design 02-tasks, issue #607): a plain task sent to intake as one local work item, the link stored on
 * the task. The item's source ID is `local-task-<task id>`, so createWorkItem (idempotent on the source) returns the
 * same item on a retry, and the link is set only while unset, so a second build changes nothing.
 *
 * Create under a project (createProjectTask): `factory task create --project <slug>` and POST /api/v1/tasks/create
 * store a plain task in that project, the request's body as its description, and build it, as above.
 */

/** Why a local item cannot be made yet: the configured repo's project key is not stored. */
export const NO_PROJECT_KEY = "no project is stored yet: start the factory once (`npm run factory -- dev`) so it records the configured repo";

/** A local work item with its triage run queued: `task create` and `task build` both make one. */
export function createLocalItem(
  store: Pick<FactoryStore, "createWorkItem">,
  i: { source_id: string; title: string; body: string; project: string; user: UserId },
): Promise<{ item: WorkItem; created: boolean }> {
  const source = { type: "local" as const, id: i.source_id, link: `local:${i.source_id}` };
  return store.createWorkItem(
    { source, title: i.title, requester_id: i.user, project: i.project, problem: `${i.title}\n\n${i.body}`.trim(), resources: [source.link] },
    { kind: "user", id: i.user },
    { enqueue: { kind: "triage", idempotency_key: `${source.type}:${source.id}:triage` } },
  );
}

export type BuildTaskResult =
  | { ok: false; reason: string }
  /** `created`: false when the task already had its item (nothing written). */
  | { ok: true; task: Task; item: WorkItem; created: boolean };

export const taskSourceId = (taskId: string) => `local-task-${taskId}`;

/**
 * Builds task `id` as `user` in `project`, its stored description below the title in the item's problem (a later edit
 * of the description changes the task, not the item). Refused, with nothing written: an unknown task, a done task, and no stored
 * project key (null). A task already linked answers its item and writes nothing.
 */
export async function buildTask(
  store: Pick<FactoryStore, "getTask" | "linkTask" | "createWorkItem" | "getWorkItem">,
  id: string,
  project: string | null,
  user: UserId,
): Promise<BuildTaskResult> {
  const task = await store.getTask(id);
  if (task === null) return { ok: false, reason: `no task ${id}` };
  if (task.done_at !== null) return { ok: false, reason: `${id} is done: only an open task can be built` };
  if (task.work_item_id !== null) {
    const item = await store.getWorkItem(task.work_item_id);
    if (item) return { ok: true, task, item, created: false };
  }
  if (project === null) {
    return { ok: false, reason: NO_PROJECT_KEY };
  }
  const { item, created } = await createLocalItem(store, { source_id: taskSourceId(task.id), title: task.title, body: task.body ?? "", project, user });
  const linked = await store.linkTask(task.id, item.id);
  return { ok: true, task: linked ?? task, item, created };
}

/**
 * A new task `task_id` titled `title` in task project `slug`, `body` its description (taskBody), built at once as a
 * local work item whose problem holds it (buildTask). Refused, with nothing written: no stored project key (null), a
 * description over MAX_TASK_BODY, and an unknown or archived project.
 * A retry with the same task ID adds nothing and answers the same item.
 */
export async function createProjectTask(
  store: Pick<FactoryStore, "getProjectBySlug" | "addTask" | "getTask" | "linkTask" | "createWorkItem" | "getWorkItem">,
  i: { task_id: string; title: string; body: string; slug: string; project: string | null; user: UserId },
): Promise<BuildTaskResult> {
  if (i.project === null) return { ok: false, reason: NO_PROJECT_KEY };
  const p = await store.getProjectBySlug(i.slug);
  if (p === null) return { ok: false, reason: projectRefusal(i.slug, "not_found") };
  if (p.archived_at !== null) return { ok: false, reason: projectRefusal(p.slug, "archived") };
  const body = taskBody(i.body);
  if (!body.ok) return body;
  try {
    await store.addTask({ id: i.task_id, title: i.title, body: body.body, list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: i.user, projects: [p.slug] });
  } catch (err) {
    // Archived or deleted since the read above: the store rolled the task back.
    if (err instanceof ProjectRefused) return { ok: false, reason: err.message };
    throw err;
  }
  return buildTask(store, i.task_id, i.project, i.user);
}
