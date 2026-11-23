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
export interface TaskGroup { key: string; title: string; /** The ISO date the heading names (a day or Today); null for Overdue, No date and Done. */ date: string | null; overdue: boolean; rows: Nested[] }

/** Tasks per page of the list (design 02-tasks, one list). */
export const PAGE_SIZE = 20;

/**
 * Every task the read returned as the list's groups, in order: overdue, today, each later day by date, no date, done. The
 * server places overdue and today; a task it did not place there (one of a later day) is put by its due date, which
 * compares as the ISO date text it is, so the page does no date arithmetic. Every done task is under Done, whatever its
 * due date (design 02-tasks-page, 2026-11-22). A sub-task whose parent is in the list goes in its parent's group, dated
 * or not, so it shows under it, unless one of the two is done; otherwise it stays in its own. Empty groups are left out.
 */
export function groupsOf(v: TasksView): TaskGroup[] {
  const placed = new Set<string>();
  const done: TaskRow[] = [];
  // Each task once; a done one goes to Done as it is taken, so no other group holds one.
  const take = (tasks: readonly TaskRow[]): TaskRow[] => {
    const open: TaskRow[] = [];
    for (const x of tasks) {
      if (placed.has(x.id)) continue;
      placed.add(x.id);
      (x.done_at == null ? open : done).push(x);
    }
    return open;
  };
  const overdue = take(v.today.overdue);
  const today = take(tasksOf(v.today.due));
  const days = new Map<string, TaskRow[]>();
  const noDate: TaskRow[] = [];
  for (const x of take(v.projects.flatMap((p) => p.tasks))) {
    if (x.due_date === null) noDate.push(x);
    else if (x.due_date < v.today_date) overdue.push(x);
    else if (x.due_date === v.today_date) today.push(x);
    else days.set(x.due_date, [...(days.get(x.due_date) ?? []), x]);
  }
  const groups = [
    { key: "overdue", title: t("tasks.overdue"), date: null, overdue: true, tasks: overdue },
    { key: "today", title: t("tasks.todayDay", { day: dayLabel(v.today_date) }), date: v.today_date, overdue: false, tasks: today },
    ...[...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, tasks]) => ({ key: date, title: dayLabel(date), date, overdue: false, tasks })),
    { key: "none", title: t("tasks.noDate"), date: null, overdue: false, tasks: noDate },
    { key: "done", title: t("tasks.doneGroup"), date: null, overdue: false, tasks: done },
  ];
  const groupOf = new Map(groups.flatMap((g, i) => g.tasks.map((x) => [x.id, i] as const)));
  const DONE = groups.length - 1;
  // A sub-task joins its parent's group only when both are open or both are done: an open one never hides under Done.
  const home = (x: TaskRow, own: number) => {
    const parent = x.parent_task_id == null ? undefined : groupOf.get(x.parent_task_id);
    return parent !== undefined && (parent === DONE) === (own === DONE) ? parent : own;
  };
  return groups
    .map((g, i) => ({ ...g, tasks: groups.flatMap((h, j) => h.tasks.filter((x) => home(x, j) === i)) }))
    .filter((g) => g.tasks.length > 0)
    .map((g) => ({ ...g, rows: nest(g.tasks) }));
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
