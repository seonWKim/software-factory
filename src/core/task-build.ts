import type { FactoryStore } from "../interfaces/factory-store.js";
import type { Task } from "./tasks.js";
import type { UserId, WorkItem } from "./types.js";

/**
 * Build this (design 02-tasks, issue #607): a plain task sent to intake as one local work item, the link stored on
 * the task. The item's source ID is `local-task-<task id>`, so createWorkItem (idempotent on the source) returns the
 * same item on a retry, and the link is set only while unset, so a second build changes nothing.
 */

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
 * Builds task `id` as `user` in `project`. Refused, with nothing written: an unknown task, a done task, and no stored
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
    return { ok: false, reason: "no project is stored yet: start the factory once (`npm run factory -- dev`) so it records the configured repo" };
  }
  const { item, created } = await createLocalItem(store, { source_id: taskSourceId(task.id), title: task.title, body: "", project, user });
  const linked = await store.linkTask(task.id, item.id);
  return { ok: true, task: linked ?? task, item, created };
}
