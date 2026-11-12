import type { Timestamp, UserId, WorkItemId } from "./types.js";

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
  /** The work item `task build` made from it (design 02-tasks, issue #607); null until then. Set once. */
  work_item_id: WorkItemId | null;
  /** The task this is a sub-task of (one level: never itself a sub-task); null for a top-level task. */
  parent_task_id: string | null;
}

/** The fields an edit names (`parseQuickEdit`); every field left out keeps its stored value. */
export type TaskEdit = Partial<TaskFields>;

export type UpdateTaskResult =
  | { ok: true; task: Task }
  | { ok: false; reason: "not_found" | "done" }
  /** The edit leaves a recurring task with no due date, which quick-add refuses too. */
  | { ok: false; reason: "needs_due_date"; recurrence: Recurrence };

export type DeleteTaskResult =
  /** `detached`: its done sub-tasks, now plain tasks (parent_task_id null). */
  | { ok: true; task: Task; detached: Task[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "open_sub_tasks"; sub_tasks: Task[] };

export type AddSubTaskResult = { ok: true; task: Task } | { ok: false; reason: "not_found" | "nested" };

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
  getTask(id: string): Promise<Task | null>;
  /** Sets work_item_id, conditional on it being unset; returns the stored row (null: no such task). */
  linkTask(id: string, work_item_id: WorkItemId): Promise<Task | null>;
  /** Completes every open task linked to `work_item_id`, as completeTask does each; the tasks it completed. */
  closeLinkedTasks(work_item_id: WorkItemId): Promise<Task[]>;
  /** Sets the fields `edit` names on an open task, conditional on done_at unset; a refusal writes nothing. */
  updateTask(id: string, edit: TaskEdit): Promise<UpdateTaskResult>;
  /**
   * Deletes the row. Refused while it has open sub-tasks; its done sub-tasks are detached (parent_task_id null) in the
   * same transaction. A work item linked to it is not touched.
   */
  deleteTask(id: string): Promise<DeleteTaskResult>;
  /** Inserts `t` as a sub-task of `parent_task_id` unless its ID is stored; refused under a sub-task (one level). */
  addSubTask(parent_task_id: string, t: NewTask): Promise<AddSubTaskResult>;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The calendar date of `now` in this process's time zone, `YYYY-MM-DD`; `days` later when given. */
export function localDate(now: Date, days = 0): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A due day as a date: today and tomorrow against `now`, the store's injected Clock. */
export function dueDate(due: DueDay, now: Date): string {
  return "date" in due ? due.date : localDate(now, due.days_from_today);
}

/**
 * `task` with the fields `edit` names (today and tomorrow against `now`), as quick-add would store them: a due time
 * on an undated task makes it due today; a recurrence needs a due date. Pure.
 */
export function applyTaskEdit(task: Task, edit: TaskEdit, now: Date): Task | { refused: "needs_due_date"; recurrence: Recurrence } {
  const { due, ...fields } = edit;
  const named = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  const next: Task = { ...task, ...named, due_date: due === undefined ? task.due_date : due === null ? null : dueDate(due, now) };
  if (next.due_date === null && next.due_time !== null) next.due_date = localDate(now);
  return next.recurrence !== null && next.due_date === null ? { refused: "needs_due_date", recurrence: next.recurrence } : next;
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

/** One line per task: ID, title, due, priority, list (as `#label`) and recurrence, `-` for each unset; a sub-task's parent last. */
export function taskLine(t: Task): string {
  const due = t.due_date === null ? "-" : t.due_time === null ? t.due_date : `${t.due_date} ${t.due_time}`;
  const list = t.list === null ? "-" : "#" + t.list;
  return [t.id, t.title, due, t.priority === null ? "-" : `!${t.priority}`, list, t.recurrence === null ? "-" : `every ${t.recurrence}`,
    ...(t.parent_task_id === null ? [] : [`sub of ${t.parent_task_id}`])].join("\t");
}

/** How many days after today the Upcoming view runs to; it starts today. */
export const UPCOMING_DAYS = 7;

/** A stored calendar event as the views take it (the calendar component's read, design 02-tasks). Times are ISO instants. */
export interface CalendarEventInput {
  source: string;
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
}

/** An event placed on one day beside the tasks. `time`: local `HH:MM` it starts that day ("00:00" when it began on an earlier day); null all day. */
export interface DayEvent extends CalendarEventInput {
  kind: "event";
  time: string | null;
}

/** One entry of a day: a task, or an event (`kind: "event"`). */
export type DayEntry = Task | DayEvent;

export const isEvent = (e: DayEntry): e is DayEvent => "kind" in e && e.kind === "event";

export interface TaskDay {
  date: string;
  /** The day's tasks and events, in the order dayEntries gives. */
  tasks: DayEntry[];
}

/**
 * The dashboard's views of the open tasks and the stored calendar events (design 02-tasks), each task placed by its
 * due date and each event by the local days it overlaps, against `now`'s calendar date in this process's time zone,
 * so the day ends at local midnight. Inbox: no due date. Today: overdue tasks (due before today) first, then today's
 * tasks and events. Upcoming: today through UPCOMING_DAYS days after it, one entry per day that has a task or an
 * event. Projects: every open task by its list label (unlabelled last), each by due date (undated last).
 */
export interface TaskViews {
  today_date: string;
  inbox: Task[];
  today: { overdue: Task[]; due: DayEntry[] };
  upcoming: TaskDay[];
  projects: { list: string | null; tasks: Task[] }[];
}

/** Due date, then due time (untimed last in its day), then priority (unset last), then age. Undated sorts last. */
function byDue(a: Task, b: Task): number {
  const key = (t: Task) => [t.due_date ?? "9999-99-99", t.due_time ?? "99:99", String(t.priority ?? 9), t.created_at, t.id].join(" ");
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

/** The events that overlap the local day `date`, in the given order, each with its start time on that day. */
function eventsOn(events: readonly CalendarEventInput[], date: string): DayEvent[] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const from = new Date(y, m - 1, d).getTime();
  const to = new Date(y, m - 1, d + 1).getTime();
  const out: DayEvent[] = [];
  for (const e of events) {
    const start = Date.parse(e.starts_at);
    const end = Date.parse(e.ends_at);
    if (!(start < to && (end > from || start >= from))) continue;
    const s = new Date(Math.max(start, from));
    out.push({ ...e, kind: "event", time: e.all_day ? null : `${pad(s.getHours())}:${pad(s.getMinutes())}` });
  }
  return out;
}

/**
 * One day's entries: all-day events first, then timed tasks and events by time (a task before an event at the same
 * minute), then the untimed tasks in the order given. `tasks` comes sorted by byDue.
 */
function dayEntries(tasks: readonly Task[], events: readonly DayEvent[]): DayEntry[] {
  const time = (e: DayEntry) => (isEvent(e) ? e.time : e.due_time) ?? "";
  const timed = [...tasks.filter((t) => t.due_time !== null), ...events.filter((e) => e.time !== null)].sort((a, b) => time(a).localeCompare(time(b)));
  return [...events.filter((e) => e.time === null), ...timed, ...tasks.filter((t) => t.due_time === null)];
}

export function taskViews(open: readonly Task[], now: Date, events: readonly CalendarEventInput[] = []): TaskViews {
  const today = localDate(now);
  const sorted = [...open].sort(byDue);
  const day = (date: string) => dayEntries(sorted.filter((t) => t.due_date === date), eventsOn(events, date));
  const upcoming: TaskDay[] = [];
  for (let n = 0; n <= UPCOMING_DAYS; n++) {
    const date = localDate(now, n);
    const entries = day(date);
    if (entries.length > 0) upcoming.push({ date, tasks: entries });
  }
  const lists = [...new Set(sorted.map((t) => t.list))].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
  return {
    today_date: today,
    inbox: sorted.filter((t) => t.due_date === null),
    today: { overdue: sorted.filter((t) => t.due_date !== null && t.due_date < today), due: day(today) },
    upcoming,
    projects: lists.map((list) => ({ list, tasks: sorted.filter((t) => t.list === list) })),
  };
}
