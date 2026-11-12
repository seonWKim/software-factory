// Plain tasks (design 02-tasks, issue #606): the store methods of TaskStore over `controller_tasks`, kept out of
// sql-factory-store.ts so that file stays within its line budget. Every write is conditional on the row's current
// state (absent for an insert, done_at unset for a completion), so applying one twice changes nothing more.

import { localDate, nextDueDate, type CompleteTaskResult, type NewTask, type Recurrence, type Task, type TaskPriority } from "../../../core/tasks.js";
import type { Timestamp, UserId, WorkItemId } from "../../../core/types.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";
import { newId } from "./rows.js";

const COLUMNS = "id, title, list, priority, due_date, due_time, recurrence, created_by, created_at, done_at, parent_id, work_item_id";

const text = (v: unknown): string | null => (v == null ? null : String(v));

function rowToTask(r: Row): Task {
  return {
    id: String(r.id), title: String(r.title), list: text(r.list), priority: r.priority == null ? null : (Number(r.priority) as TaskPriority),
    due_date: text(r.due_date), due_time: text(r.due_time), recurrence: text(r.recurrence) as Recurrence | null,
    created_by: String(r.created_by) as UserId, created_at: String(r.created_at) as Timestamp, done_at: text(r.done_at) as Timestamp | null,
    parent_id: text(r.parent_id), work_item_id: text(r.work_item_id) as WorkItemId | null,
  };
}

async function select(db: SqlExecutor, column: "id" | "parent_id", value: string): Promise<Task | null> {
  const [row] = await db.all(`SELECT ${COLUMNS} FROM controller_tasks WHERE ${column} = ?`, [value]);
  return row ? rowToTask(row) : null;
}

/** Inserts `t` unless a row has its ID (or, for an occurrence, its parent); false when it inserted nothing. */
async function insert(db: SqlDriver, tx: SqlExecutor, t: Task): Promise<boolean> {
  try {
    await tx.run(`INSERT INTO controller_tasks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      t.id, t.title, t.list, t.priority, t.due_date, t.due_time, t.recurrence, t.created_by, t.created_at, t.done_at, t.parent_id, t.work_item_id,
    ]);
    return true;
  } catch (err) {
    if (db.isDuplicateKey(err)) return false;
    throw err;
  }
}

/** Today and tomorrow resolve against `now`, the store's injected Clock. */
export async function addTask(db: SqlDriver, t: NewTask, now: Date): Promise<Task> {
  const due_date = t.due === null ? null : "date" in t.due ? t.due.date : localDate(now, t.due.days_from_today);
  const row: Task = {
    id: t.id, title: t.title, list: t.list, priority: t.priority, due_date, due_time: t.due_time, recurrence: t.recurrence,
    created_by: t.created_by, created_at: now.toISOString() as Timestamp, done_at: null, parent_id: null, work_item_id: null,
  };
  return db.transaction(async (tx) => {
    await insert(db, tx, row);
    return (await select(tx, "id", t.id))!;
  });
}

export async function listTasks(db: SqlDriver, limit: number): Promise<Task[]> {
  const rows = await db.all(`SELECT ${COLUMNS} FROM controller_tasks WHERE done_at IS NULL ORDER BY created_at, id LIMIT ?`, [limit]);
  return rows.map(rowToTask);
}

/** In `tx`: completeTask's conditional completion and, for a recurring task, its one next occurrence (unlinked). */
async function complete(db: SqlDriver, tx: SqlExecutor, id: string, now: Timestamp): Promise<CompleteTaskResult> {
  const task = await select(tx, "id", id);
  if (task === null) return { ok: false, reason: "not_found" } as const;
  const completed = (await tx.run("UPDATE controller_tasks SET done_at = ? WHERE id = ? AND done_at IS NULL", [now, id])) === 1;
  if (completed && task.recurrence !== null && task.due_date !== null) {
    await insert(db, tx, {
      ...task, id: newId("tk"), due_date: nextDueDate(task.due_date, task.recurrence), created_at: now, done_at: null, parent_id: id, work_item_id: null,
    });
  }
  return { ok: true, task: (await select(tx, "id", id))!, completed, next: await select(tx, "parent_id", id) } as const;
}

export async function completeTask(db: SqlDriver, id: string, now: Timestamp): Promise<CompleteTaskResult> {
  return db.transaction((tx) => complete(db, tx, id, now));
}

export function getTask(db: SqlDriver, id: string): Promise<Task | null> {
  return select(db, "id", id);
}

/** Sets the link only where none is stored, so a retry or a second build changes nothing. */
export async function linkTask(db: SqlDriver, id: string, work_item_id: WorkItemId): Promise<Task | null> {
  await db.run("UPDATE controller_tasks SET work_item_id = ? WHERE id = ? AND work_item_id IS NULL", [work_item_id, id]);
  return select(db, "id", id);
}

/** Completes each open task linked to the item, in one transaction; a second call finds none open. */
export async function closeLinkedTasks(db: SqlDriver, work_item_id: WorkItemId, now: Timestamp): Promise<Task[]> {
  return db.transaction(async (tx) => {
    const open = await tx.all("SELECT id FROM controller_tasks WHERE work_item_id = ? AND done_at IS NULL ORDER BY id", [work_item_id]);
    const closed: Task[] = [];
    for (const { id } of open) {
      const r = await complete(db, tx, String(id), now);
      if (r.ok && r.completed) closed.push(r.task);
    }
    return closed;
  });
}
