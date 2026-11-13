import type { NewNotice } from "./notifications.js";
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
  /** How long the task takes, in minutes; null or left out: DEFAULT_DURATION_MINUTES. */
  duration_minutes?: number | null;
  recurrence: Recurrence | null;
}

export interface NewTask extends TaskFields {
  /** Chosen by the caller, so a repeated add (a retry, a redelivered chat message) stores nothing more. */
  id: string;
  /** The CLI user's ID from the environment, never a display name. */
  created_by: UserId;
}

export interface Task extends Omit<TaskFields, "due" | "duration_minutes"> {
  id: string;
  /** How long the task takes, in minutes; null: DEFAULT_DURATION_MINUTES (taskDuration). */
  duration_minutes: number | null;
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
  /** When the reminder at the task's time was sent (the sent-marker); null until then, and again once the time changes. */
  reminded_at: Timestamp | null;
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

export type ReopenTaskResult =
  | { ok: false; reason: "not_found" }
  /** The recurring task's next occurrence is done too: reopening it would leave two open occurrences. Nothing written. */
  | { ok: false; reason: "next_done"; next: Task }
  /** `reopened`: false when it was open already (nothing written). `removed_next`: the open next occurrence it deleted. */
  | { ok: true; task: Task; reopened: boolean; removed_next: string | null };

/** The store's task methods, part of FactoryStore; implemented once in the shared SQL store. */
export interface TaskStore {
  /** Inserts the task unless its ID is stored; returns the stored row either way. */
  addTask(t: NewTask): Promise<Task>;
  /** Open tasks (no done_at), oldest first, at most `limit`. Read-only. */
  listTasks(limit: number): Promise<Task[]>;
  /** The Done view's read (design 02-tasks, Done view): the done tasks of `window` (doneWindow), most recently done first. Read-only. */
  listDoneTasks(window: DoneWindow): Promise<DoneTasks>;
  /**
   * Sets done_at, conditional on it being unset, and for a recurring task inserts its next occurrence (parent_id
   * this task, unique) in the same transaction, so a second completion writes nothing.
   */
  completeTask(id: string): Promise<CompleteTaskResult>;
  /**
   * Undoes completeTask (design 02-tasks, undo a completion): sets done_at to NULL, conditional on it being set, and for
   * a recurring task deletes its open next occurrence in the same transaction; refused (next_done) when that one is done.
   */
  reopenTask(id: string): Promise<ReopenTaskResult>;
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
  /** The tasks whose reminder `now` sends (reminderDue), by time. Read-only. */
  listDueReminders(now: Date): Promise<Task[]>;
  /**
   * Sets reminded_at to the notice's time, conditional on the task being open, unreminded and still at `at` (its due
   * date and time), and in the same transaction stores the notice; false (nothing written) when the condition fails.
   */
  remindTask(id: string, at: TaskTime, notice: NewNotice): Promise<boolean>;
}

/** How many days the Done view reads at a time: the last 30 days first, then Show older's 30 days before (owner answer 2). */
export const DONE_WINDOW_DAYS = 30;

/** The done tasks one Done view read takes: `from` <= done_at < `before` (no upper bound when `before` is null). */
export interface DoneWindow {
  from: Timestamp;
  before: Timestamp | null;
}

/** One Done view read: its tasks, most recently done first, and `older`, whether a task was done before the window. */
export interface DoneTasks {
  tasks: Task[];
  older: boolean;
}

/** The window of DONE_WINDOW_DAYS days that ends at `before` (Show older), or at `now` with no upper bound (the first read). Pure. */
export function doneWindow(now: Date, before: Timestamp | null): DoneWindow {
  const end = before === null ? now.getTime() : Date.parse(before);
  return { from: new Date(end - DONE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString() as Timestamp, before };
}

/** A task's time: its due date and due time. */
export interface TaskTime {
  due_date: string;
  due_time: string;
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
  // A new time gets its own reminder.
  if (next.due_date !== task.due_date || next.due_time !== task.due_time) next.reminded_at = null;
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

/** How long a timed task with no stored duration is planned and drawn: 30 minutes. */
export const DEFAULT_DURATION_MINUTES = 30;
/** The longest duration a task takes: one day. */
export const MAX_DURATION_MINUTES = 24 * 60;

/** The task's duration in minutes: the stored one, else DEFAULT_DURATION_MINUTES. */
export const taskDuration = (t: Pick<Task, "duration_minutes">): number => t.duration_minutes ?? DEFAULT_DURATION_MINUTES;

/** Why `n` is not a duration in minutes (a whole number from 1 to MAX_DURATION_MINUTES), or null. */
export function durationError(n: unknown): string | null {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_DURATION_MINUTES
    ? null : `a duration must be 1 to ${MAX_DURATION_MINUTES} minutes (e.g. 45m, 1h or 1h30m)`;
}

/** The poll window: how long after its time a task's reminder may still be sent; a controller down longer sends none for it. */
export const REMINDER_LOOKBACK_MS = 5 * 60 * 1000;

/** `HH:MM` on the local day `date`, as an instant in this process's time zone. */
function localInstant(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, min] = time.split(":").map(Number) as [number, number];
  return new Date(y, m - 1, d, h, min);
}

/** The local days whose tasks a reminder pass at `now` reads: from the lookback's date through today. */
export const reminderDays = (now: Date): { from: string; to: string } => ({ from: localDate(new Date(now.getTime() - REMINDER_LOOKBACK_MS)), to: localDate(now) });

/** Whether `now` sends the task's reminder: open, timed, not yet reminded, its time come and at most REMINDER_LOOKBACK_MS ago. Pure. */
export function reminderDue(t: Task, now: Date): t is Task & TaskTime {
  if (t.done_at !== null || t.reminded_at !== null || t.due_date === null || t.due_time === null) return false;
  const late = now.getTime() - localInstant(t.due_date, t.due_time).getTime();
  return late >= 0 && late <= REMINDER_LOOKBACK_MS;
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
  /** Today's timeline: its timed tasks and events as blocks (planDay). */
  timeline: TimelineBlock[];
}

/**
 * One block on a day's timeline: a timed task (its duration, DEFAULT_DURATION_MINUTES when none is stored) or a timed
 * event (read-only; its length that day). `offset`: minutes after local midnight it starts; `minutes`: how long it is
 * drawn, cut at the day's end. `id`: the task's ID, or `<source>:<id>` for an event.
 */
export interface TimelineBlock {
  kind: "task" | "event";
  id: string;
  title: string;
  start: string;
  end: string;
  offset: number;
  minutes: number;
}

const DAY_MINUTES = 24 * 60;
const hhmm = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const minutesOf = (time: string) => {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

/** The timed entries of the local day `date` as timeline blocks, in the order given. Pure. */
export function planDay(entries: readonly DayEntry[], date: string): TimelineBlock[] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const from = new Date(y, m - 1, d).getTime();
  const to = new Date(y, m - 1, d + 1).getTime();
  const out: TimelineBlock[] = [];
  for (const e of entries) {
    const time = isEvent(e) ? e.time : e.due_time;
    if (time === null) continue;
    const offset = minutesOf(time);
    const length = isEvent(e) ? Math.max(1, Math.round((Math.min(Date.parse(e.ends_at), to) - Math.max(Date.parse(e.starts_at), from)) / 60_000)) : taskDuration(e);
    out.push({
      kind: isEvent(e) ? "event" : "task", id: isEvent(e) ? `${e.source}:${e.id}` : e.id, title: e.title, start: time, end: hhmm(offset + length), offset,
      minutes: Math.min(length, DAY_MINUTES - offset),
    });
  }
  return out;
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
  const todays = day(today);
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
    today: { overdue: sorted.filter((t) => t.due_date !== null && t.due_date < today), due: todays },
    upcoming,
    projects: lists.map((list) => ({ list, tasks: sorted.filter((t) => t.list === list) })),
    timeline: planDay(todays, today),
  };
}
