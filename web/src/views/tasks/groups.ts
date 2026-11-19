import { type DayRow, type TaskRow, type TasksView, isEventRow } from "../../api.js";
import { t } from "../../i18n/index.js";

/** `2026-11-13` as the viewer's short weekday and date, e.g. "Fri, 13 Nov"; the date itself when it is not one. */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/**
 * The list's rows with each sub-task right after its parent when both are in the list, so it shows indented under
 * it; a sub-task whose parent is in another list stays in place and names its parent.
 */
export function nest(tasks: readonly TaskRow[]): { row: TaskRow; sub: boolean }[] {
  const here = new Set(tasks.map((x) => x.id));
  const under = (x: TaskRow) => x.parent_task_id != null && here.has(x.parent_task_id);
  return tasks.filter((x) => !under(x)).flatMap((x) => [{ row: x, sub: false }, ...tasks.filter((s) => s.parent_task_id === x.id).map((s) => ({ row: s, sub: true }))]);
}

/** The tasks among a day's rows: the server also places calendar events there, which the Calendar page shows. */
export const tasksOf = (rows: readonly DayRow[]): TaskRow[] => rows.filter((x): x is TaskRow => !isEventRow(x));

export type Nested = { row: TaskRow; sub: boolean };
/** One group of the list: its heading and its rows, each sub-task right after its parent. */
export interface TaskGroup { key: string; title: string; overdue: boolean; rows: Nested[] }

/** Tasks per page of the list (design 02-tasks, one list). */
export const PAGE_SIZE = 20;

/**
 * Every task the read returned as the list's groups, in order: overdue, today, each later day by date, no date, done. The
 * server places overdue and today; a task it did not place there (a done one, or one of a later day) is put by its due date,
 * which compares as the ISO date text it is, so the page does no date arithmetic. A done task due before today is under
 * Done, never Overdue; one due today or later stays in its day (design 02-tasks-page). Empty groups are left out.
 */
export function groupsOf(v: TasksView): TaskGroup[] {
  const placed = new Set<string>();
  const take = (tasks: readonly TaskRow[]) => tasks.filter((x) => !placed.has(x.id) && placed.add(x.id));
  const overdue: TaskRow[] = [];
  const done: TaskRow[] = [];
  const past = (x: TaskRow) => (x.done_at != null ? done : overdue).push(x);
  take(v.today.overdue).forEach(past);
  const today = take(tasksOf(v.today.due));
  const days = new Map<string, TaskRow[]>();
  const noDate: TaskRow[] = [];
  for (const x of take(v.projects.flatMap((p) => p.tasks))) {
    if (x.due_date === null) noDate.push(x);
    else if (x.due_date < v.today_date) past(x);
    else if (x.due_date === v.today_date) today.push(x);
    else days.set(x.due_date, [...(days.get(x.due_date) ?? []), x]);
  }
  const groups = [
    { key: "overdue", title: t("tasks.overdue"), overdue: true, tasks: overdue },
    { key: "today", title: t("tasks.todayDay", { day: dayLabel(v.today_date) }), overdue: false, tasks: today },
    ...[...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, tasks]) => ({ key: date, title: dayLabel(date), overdue: false, tasks })),
    { key: "none", title: t("tasks.noDate"), overdue: false, tasks: noDate },
    { key: "done", title: t("tasks.doneGroup"), overdue: false, tasks: done },
  ];
  return groups.filter((g) => g.tasks.length > 0).map((g) => ({ ...g, rows: nest(g.tasks) }));
}

/** The groups' rows of one page (the rows past the page size go to the next), regrouped under their headings. */
export function pageOf(groups: readonly TaskGroup[], page: number): TaskGroup[] {
  const from = (page - 1) * PAGE_SIZE;
  let seen = 0;
  const out: TaskGroup[] = [];
  for (const g of groups) {
    const rows = g.rows.slice(Math.max(0, from - seen), Math.max(0, from + PAGE_SIZE - seen));
    seen += g.rows.length;
    if (rows.length > 0) out.push({ ...g, rows });
  }
  return out;
}

/** True when the list holds at least one open task. */
export const hasTasks = (v: TasksView): boolean => groupsOf(v).some((g) => g.rows.some((r) => r.row.done_at == null));
