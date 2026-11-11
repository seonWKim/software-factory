import type { Timestamp, UserId } from "./types.js";

/**
 * Plain tasks (design 02-tasks, issue #606): a to-do the owner keeps beside the work items, stored in
 * `controller_tasks`, never a work item, so triage never reads one. No repository: `list` is a free label.
 */

export type Recurrence = "day" | "week" | "month";
export type TaskPriority = 1 | 2 | 3;

/** A due day as typed: a calendar date, or today/tomorrow, which the store resolves with its injected Clock. */
export type DueDay = { date: string } | { days_from_today: 0 | 1 };

/** What quick-add words say about a task (src/core/quick-add.ts). */
export interface TaskFields {
  title: string;
  /** A free `#label`, without the `#`; never a repository key. */
  list: string | null;
  /** 1 is the highest. */
  priority: TaskPriority | null;
  due: DueDay | null;
  /** `HH:MM`, 24-hour. */
  due_time: string | null;
  recurrence: Recurrence | null;
}

export interface NewTask extends TaskFields {
  /** Chosen by the caller, so a repeated add (a retry, a redelivered chat message) stores nothing more. */
  id: string;
  /** The CLI user's ID from the environment, never a display name. */
  created_by: UserId;
}

export interface Task extends Omit<TaskFields, "due"> {
  id: string;
  /** `YYYY-MM-DD`, or null. */
  due_date: string | null;
  created_by: UserId;
  created_at: Timestamp;
  done_at: Timestamp | null;
  /** The task a recurring occurrence came from; null for a task someone added. */
  parent_id: string | null;
}

export type CompleteTaskResult =
  | { ok: false; reason: "not_found" }
  /** `completed`: false when it was already done (nothing written). `next`: the stored next occurrence of a recurring task. */
  | { ok: true; task: Task; completed: boolean; next: Task | null };

/** The store's task methods, part of FactoryStore; implemented once in the shared SQL store. */
export interface TaskStore {
  /** Inserts the task unless its ID is stored; returns the stored row either way. */
  addTask(t: NewTask): Promise<Task>;
  /** Open tasks (no done_at), oldest first, at most `limit`. Read-only. */
  listTasks(limit: number): Promise<Task[]>;
  /**
   * Sets done_at, conditional on it being unset, and for a recurring task inserts its next occurrence (parent_id
   * this task, unique) in the same transaction, so a second completion writes nothing.
   */
  completeTask(id: string): Promise<CompleteTaskResult>;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The calendar date of `now` in this process's time zone, `YYYY-MM-DD`; `days` later when given. */
export function localDate(now: Date, days = 0): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The next occurrence's due date: a day or a week later, or a month later on the same day (the month's last day when shorter). */
export function nextDueDate(date: string, every: Recurrence): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  if (every !== "month") {
    const next = new Date(Date.UTC(y, m - 1, d + (every === "day" ? 1 : 7)));
    return next.toISOString().slice(0, 10);
  }
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const next = new Date(Date.UTC(y, m, Math.min(d, last)));
  return next.toISOString().slice(0, 10);
}

/** One line per task: ID, title, due, priority, list and recurrence, `-` for each unset. */
export function taskLine(t: Task): string {
  const due = t.due_date === null ? "-" : t.due_time === null ? t.due_date : `${t.due_date} ${t.due_time}`;
  return [t.id, t.title, due, t.priority === null ? "-" : `!${t.priority}`, t.list === null ? "-" : `#${t.list}`, t.recurrence === null ? "-" : `every ${t.recurrence}`].join("\t");
}
