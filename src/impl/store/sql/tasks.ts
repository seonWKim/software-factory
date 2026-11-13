// Plain tasks (design 02-tasks, issue #606): the store methods of TaskStore over `controller_tasks`, kept out of
// sql-factory-store.ts so that file stays within its line budget. Every write is conditional on the row's current
// state (absent for an insert, done_at unset for a completion or an edit), so applying one twice changes nothing more.
// No CLI or chat logic: the methods take plain arguments, so an HTTP route can call them too.

import {
  type AddSubTaskResult, type CompleteTaskResult, type DeleteTaskResult, type DoneTasks, type DoneWindow, type NewTask, type Recurrence, type ReopenTaskResult, type Task, type TaskEdit, type TaskPriority,
  type TaskTime, type UpdateTaskResult, applyTaskEdit, dueDate, nextDueDate, reminderDays, reminderDue,
} from "../../../core/tasks.js";
import type { NewNotice } from "../../../core/notifications.js";
import type { Timestamp, UserId, WorkItemId } from "../../../core/types.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";
import { recordNotice } from "./notices.js";
import { newId } from "./rows.js";

const COLUMNS =
  "id, title, list, priority, due_date, due_time, recurrence, created_by, created_at, done_at, parent_id, work_item_id, parent_task_id, duration_minutes, reminded_at";

const text = (v: unknown): string | null => (v == null ? null : String(v));

function rowToTask(r: Row): Task {
  return {
    id: String(r.id), title: String(r.title), list: text(r.list), priority: r.priority == null ? null : (Number(r.priority) as TaskPriority),
    due_date: text(r.due_date), due_time: text(r.due_time), recurrence: text(r.recurrence) as Recurrence | null,
    created_by: String(r.created_by) as UserId, created_at: String(r.created_at) as Timestamp, done_at: text(r.done_at) as Timestamp | null,
    parent_id: text(r.parent_id), work_item_id: text(r.work_item_id) as WorkItemId | null, parent_task_id: text(r.parent_task_id),
    duration_minutes: r.duration_minutes == null ? null : Number(r.duration_minutes), reminded_at: text(r.reminded_at) as Timestamp | null,
  };
}

async function select(db: SqlExecutor, column: "id" | "parent_id", value: string): Promise<Task | null> {
  const [row] = await db.all(`SELECT ${COLUMNS} FROM controller_tasks WHERE ${column} = ?`, [value]);
  return row ? rowToTask(row) : null;
}

/** Inserts `t` unless a row has its ID (or, for an occurrence, its parent); false when it inserted nothing. */
async function insert(db: SqlDriver, tx: SqlExecutor, t: Task): Promise<boolean> {
  try {
    await tx.run(`INSERT INTO controller_tasks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      t.id, t.title, t.list, t.priority, t.due_date, t.due_time, t.recurrence, t.created_by, t.created_at, t.done_at, t.parent_id, t.work_item_id,
      t.parent_task_id, t.duration_minutes, t.reminded_at,
    ]);
    return true;
  } catch (err) {
    if (db.isDuplicateKey(err)) return false;
    throw err;
  }
}

/** The row a new task gets; today and tomorrow resolve against `now`, the store's injected Clock. */
function newRow(t: NewTask, now: Date, parent_task_id: string | null): Task {
  return {
    id: t.id, title: t.title, list: t.list, priority: t.priority, due_date: t.due === null ? null : dueDate(t.due, now), due_time: t.due_time,
    recurrence: t.recurrence, created_by: t.created_by, created_at: now.toISOString() as Timestamp, done_at: null, parent_id: null,
    work_item_id: null, parent_task_id, duration_minutes: t.duration_minutes ?? null, reminded_at: null,
  };
}

export async function addTask(db: SqlDriver, t: NewTask, now: Date): Promise<Task> {
  return db.transaction(async (tx) => {
    await insert(db, tx, newRow(t, now, null));
    return (await select(tx, "id", t.id))!;
  });
}

/** One level: refused under a sub-task. A stored ID is answered as stored, so a resend inserts nothing. */
export async function addSubTask(db: SqlDriver, parent_task_id: string, t: NewTask, now: Date): Promise<AddSubTaskResult> {
  return db.transaction(async (tx) => {
    const stored = await select(tx, "id", t.id);
    if (stored !== null) return { ok: true, task: stored } as const;
    const parent = await select(tx, "id", parent_task_id);
    if (parent === null) return { ok: false, reason: "not_found" } as const;
    if (parent.parent_task_id !== null) return { ok: false, reason: "nested" } as const;
    await insert(db, tx, newRow(t, now, parent_task_id));
    return { ok: true, task: (await select(tx, "id", t.id))! } as const;
  });
}

/** Writes the edited fields where the task is still open; the same edit again writes the same values. */
export async function updateTask(db: SqlDriver, id: string, edit: TaskEdit, now: Date): Promise<UpdateTaskResult> {
  return db.transaction(async (tx) => {
    const task = await select(tx, "id", id);
    if (task === null) return { ok: false, reason: "not_found" } as const;
    if (task.done_at !== null) return { ok: false, reason: "done" } as const;
    const next = applyTaskEdit(task, edit, now);
    if ("refused" in next) return { ok: false, reason: next.refused, recurrence: next.recurrence } as const;
    await tx.run(
      `UPDATE controller_tasks SET title = ?, list = ?, priority = ?, due_date = ?, due_time = ?, recurrence = ?, duration_minutes = ?, reminded_at = ?
        WHERE id = ? AND done_at IS NULL`,
      [next.title, next.list, next.priority, next.due_date, next.due_time, next.recurrence, next.duration_minutes, next.reminded_at, id],
    );
    return { ok: true, task: (await select(tx, "id", id))! } as const;
  });
}

/** In one transaction: refused while a sub-task is open; else detaches the done ones and deletes the row. */
export async function deleteTask(db: SqlDriver, id: string): Promise<DeleteTaskResult> {
  return db.transaction(async (tx) => {
    const task = await select(tx, "id", id);
    if (task === null) return { ok: false, reason: "not_found" } as const;
    const subs = (await tx.all(`SELECT ${COLUMNS} FROM controller_tasks WHERE parent_task_id = ? ORDER BY id`, [id])).map(rowToTask);
    const open = subs.filter((s) => s.done_at === null);
    if (open.length > 0) return { ok: false, reason: "open_sub_tasks", sub_tasks: open } as const;
    if (subs.length > 0) await tx.run("UPDATE controller_tasks SET parent_task_id = NULL WHERE parent_task_id = ? AND done_at IS NOT NULL", [id]);
    await tx.run("DELETE FROM controller_tasks WHERE id = ?", [id]);
    return { ok: true, task, detached: subs.map((s) => ({ ...s, parent_task_id: null })) } as const;
  });
}

export async function listTasks(db: SqlDriver, limit: number): Promise<Task[]> {
  const rows = await db.all(`SELECT ${COLUMNS} FROM controller_tasks WHERE done_at IS NULL ORDER BY created_at, id LIMIT ?`, [limit]);
  return rows.map(rowToTask);
}

/** Read-only: the window's done tasks, most recently done first, and whether one was done before it. */
export async function listDoneTasks(db: SqlDriver, w: DoneWindow): Promise<DoneTasks> {
  const [upper, args] = w.before === null ? ["", [w.from]] : [" AND done_at < ?", [w.from, w.before]];
  const rows = await db.all(`SELECT ${COLUMNS} FROM controller_tasks WHERE done_at >= ?${upper} ORDER BY done_at DESC, id DESC`, args);
  const older = await db.all("SELECT id FROM controller_tasks WHERE done_at < ? LIMIT 1", [w.from]);
  return { tasks: rows.map(rowToTask), older: older.length > 0 };
}

/** In `tx`: completeTask's conditional completion and, for a recurring task, its one next occurrence (unlinked). */
async function complete(db: SqlDriver, tx: SqlExecutor, id: string, now: Timestamp): Promise<CompleteTaskResult> {
  const task = await select(tx, "id", id);
  if (task === null) return { ok: false, reason: "not_found" } as const;
  const completed = (await tx.run("UPDATE controller_tasks SET done_at = ? WHERE id = ? AND done_at IS NULL", [now, id])) === 1;
  if (completed && task.recurrence !== null && task.due_date !== null) {
    await insert(db, tx, {
      ...task, id: newId("tk"), due_date: nextDueDate(task.due_date, task.recurrence), created_at: now, done_at: null, parent_id: id, work_item_id: null,
      reminded_at: null,
    });
  }
  return { ok: true, task: (await select(tx, "id", id))!, completed, next: await select(tx, "parent_id", id) } as const;
}

export async function completeTask(db: SqlDriver, id: string, now: Timestamp): Promise<CompleteTaskResult> {
  return db.transaction((tx) => complete(db, tx, id, now));
}

/**
 * In one transaction: done_at back to NULL where it is set, after deleting the recurring task's next occurrence (its
 * sub-tasks moved under this task, the same series) while that one is open; a done next occurrence refuses it, writing
 * nothing. A second reopen finds the task open and writes nothing.
 */
export async function reopenTask(db: SqlDriver, id: string): Promise<ReopenTaskResult> {
  return db.transaction(async (tx) => {
    const task = await select(tx, "id", id);
    if (task === null) return { ok: false, reason: "not_found" } as const;
    if (task.done_at === null) return { ok: true, task, reopened: false, removed_next: null } as const;
    const next = await select(tx, "parent_id", id);
    if (next !== null && next.done_at !== null) return { ok: false, reason: "next_done", next } as const;
    if (next !== null) {
      await tx.run("UPDATE controller_tasks SET parent_task_id = ? WHERE parent_task_id = ?", [id, next.id]);
      await tx.run("DELETE FROM controller_tasks WHERE id = ? AND done_at IS NULL", [next.id]);
    }
    const reopened = (await tx.run("UPDATE controller_tasks SET done_at = NULL WHERE id = ? AND done_at IS NOT NULL", [id])) === 1;
    return { ok: true, task: (await select(tx, "id", id))!, reopened, removed_next: next?.id ?? null } as const;
  });
}

/** Read-only: the open, timed, unreminded tasks of the lookback's days, then those whose time has come (reminderDue). */
export async function listDueReminders(db: SqlDriver, now: Date): Promise<Task[]> {
  const { from, to } = reminderDays(now);
  const rows = await db.all(
    `SELECT ${COLUMNS} FROM controller_tasks WHERE done_at IS NULL AND reminded_at IS NULL AND due_time IS NOT NULL AND due_date >= ? AND due_date <= ?
      ORDER BY due_date, due_time, id`,
    [from, to],
  );
  return rows.map(rowToTask).filter((t) => reminderDue(t, now));
}

/**
 * The sent-marker's conditional write, then the notice, in one transaction: a second pass, another replica, a done,
 * deleted or moved task changes no row, so stores no notice either.
 */
export async function remindTask(db: SqlDriver, id: string, at: TaskTime, notice: NewNotice): Promise<boolean> {
  return db.transaction(async (tx) => {
    const marked = await tx.run(
      "UPDATE controller_tasks SET reminded_at = ? WHERE id = ? AND done_at IS NULL AND reminded_at IS NULL AND due_date = ? AND due_time = ?",
      [notice.created_at, id, at.due_date, at.due_time],
    );
    if (marked !== 1) return false;
    // A task moved back to a time it was reminded at already has that notice: it is not stored twice.
    await recordNotice(db, notice, tx);
    return true;
  });
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
