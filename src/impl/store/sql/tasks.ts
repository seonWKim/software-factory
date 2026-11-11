// Plain tasks (design 02-tasks, issue #606): the store methods of TaskStore over `controller_tasks`, kept out of
// sql-factory-store.ts so that file stays within its line budget. Every write is conditional on the row's current
// state (absent for an insert, done_at unset for a completion), so applying one twice changes nothing more.

import { localDate, nextDueDate, type CompleteTaskResult, type NewTask, type Recurrence, type Task, type TaskPriority } from "../../../core/tasks.js";
import type { Timestamp, UserId } from "../../../core/types.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";
import { newId } from "./rows.js";

const COLUMNS = "id, title, list, priority, due_date, due_time, recurrence, created_by, created_at, done_at, parent_id";

const text = (v: unknown): string | null => (v == null ? null : String(v));

function rowToTask(r: Row): Task {
  return {
    id: String(r.id), title: String(r.title), list: text(r.list), priority: r.priority == null ? null : (Number(r.priority) as TaskPriority),
    due_date: text(r.due_date), due_time: text(r.due_time), recurrence: text(r.recurrence) as Recurrence | null,
    created_by: String(r.created_by) as UserId, created_at: String(r.created_at) as Timestamp, done_at: text(r.done_at) as Timestamp | null,
    parent_id: text(r.parent_id),
  };
}

async function select(db: SqlExecutor, column: "id" | "parent_id", value: string): Promise<Task | null> {
  const [row] = await db.all(`SELECT ${COLUMNS} FROM controller_tasks WHERE ${column} = ?`, [value]);
  return row ? rowToTask(row) : null;
}

/** Inserts `t` unless a row has its ID (or, for an occurrence, its parent); false when it inserted nothing. */
async function insert(db: SqlDriver, tx: SqlExecutor, t: Task): Promise<boolean> {
  try {
    await tx.run(`INSERT INTO controller_tasks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      t.id, t.title, t.list, t.priority, t.due_date, t.due_time, t.recurrence, t.created_by, t.created_at, t.done_at, t.parent_id,
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
    created_by: t.created_by, created_at: now.toISOString() as Timestamp, done_at: null, parent_id: null,
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

export async function completeTask(db: SqlDriver, id: string, now: Timestamp): Promise<CompleteTaskResult> {
  return db.transaction(async (tx) => {
    const task = await select(tx, "id", id);
    if (task === null) return { ok: false, reason: "not_found" } as const;
    const completed = (await tx.run("UPDATE controller_tasks SET done_at = ? WHERE id = ? AND done_at IS NULL", [now, id])) === 1;
    if (completed && task.recurrence !== null && task.due_date !== null) {
      await insert(db, tx, {
        ...task, id: newId("tk"), due_date: nextDueDate(task.due_date, task.recurrence), created_at: now, done_at: null, parent_id: id,
      });
    }
    return { ok: true, task: (await select(tx, "id", id))!, completed, next: await select(tx, "parent_id", id) } as const;
  });
}
