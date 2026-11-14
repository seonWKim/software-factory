import { useQueryClient } from "@tanstack/react-query";
import { type DragEvent, type FormEvent, type KeyboardEvent, type RefObject, createContext, useContext, useEffect, useRef, useState } from "react";
import {
  API, type DayRow, type DoneRow, type ProjectChoice, type TaskAction, type TaskRow, type TasksView, type TimelineRow, isEventRow, postProject, postTaskAction,
  postTaskAdd, postTaskBuild, postTaskProject, useDoneTasks, useTasks,
} from "../api.js";
import { Button } from "../components/ui/button.js";
import { FOCUS } from "../components/ui/control.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { EmptyState, StatusBadge } from "../components/ui/notice.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Switch } from "../components/ui/switch.js";
import { Tabs } from "../components/ui/tabs.js";
import { t } from "../i18n/index.js";
import { QUICK_ADD_ATTR, QUICK_ADD_KEYS, type QuickAddKey, isQuickAddSubmit, isUndo } from "../keys.js";
import { cn } from "../lib/cn.js";
import { localDateTime } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { FactoryWork, WorkState } from "./task-work.js";

// The Tasks page (design 02-tasks and 09-dashboard-app, issue #607): the owner's open plain tasks, read through GET
// /api/v1/tasks, in three views. Today: overdue first, in red, then today's tasks. Upcoming: tomorrow through 7 days
// ahead, by day (the server's upcoming days after today_date). All: every open task, undated included, under its #list.
// The server places each task and orders each day, so the page does no date arithmetic. Calendar events are not shown here: the Calendar page (views/
// calendar.tsx) lists them, with the stale-sync notice. Build this sends a task to intake once (POST /api/v1/tasks/build); a
// built task links to its work item instead. One list of cards at every width, so no table turns into cards.
// Each row's actions (design 02-tasks) post to the route that calls the CLI command's store method: the checkbox
// completes it, `e` or Edit edits it in place (Enter saves, Esc cancels), and its overflow menu adds a sub-task (top-level
// rows only) or deletes it through the danger Dialog. A sub-task shows indented under its parent, one level.
// Today ends with today's timeline (design 02-tasks, schedule a task), collapsed until its control (aria-expanded)
// is pressed: the server places each timed task, drawn its duration (30 minutes when none is stored); events are not
// drawn. A task row dragged onto a
// half-hour slot is scheduled there (POST /api/v1/tasks/schedule: today's date, the slot's time); typing a time in
// the row's edit (3pm, 45m) does the same from the keyboard.
// ⌘Z outside a field undoes the last completion this page made (POST /api/v1/tasks/reopen, `factory task reopen`), then
// the one before it: the page keeps the completed tasks in memory only, so a reload forgets them, and it never undoes an
// edit or a delete.
// All's Show done switch (design 02-tasks, Done view), off on load, adds the done list below the open tasks. It reads
// GET /api/v1/tasks/done: the tasks done in the last 30 days, most recently done first, one flat list across all lists with each row's list label and done time. Show older reads the 30
// days before the oldest row shown, and is hidden when the server says none is older. Each row's Reopen posts the same
// route as ⌘Z; a refusal (its next occurrence is done) shows above the list. Its read shares the tasks' query key, so a
// completion or a reopen reloads it with the open views.
// The project tabs (design 09-dashboard-app, task projects) filter Today, Upcoming and All to one active
// task project's tasks (GET /api/v1/tasks?project=<slug>); its choice is the page's `project` query parameter, read on
// load and set on change, so a filtered view can be shared and reloaded. The done list is not filtered. Factory work
// follows it too (GET /api/v1/items?project=<slug>): only the work items built from that project's tasks. Each open row's overflow
// item Projects… opens the project dialog: a checkbox per active project adds or removes the task's link (POST
// /api/v1/tasks/project) and New project creates one (POST /api/v1/projects) and puts the task in it.
// The page's order (design 09-dashboard-app): the project tabs and the view tabs, Quick add, Factory work, the view; the blocks
// are spaced by one flex gap, the Section gap of design-system/patterns.md.

const TABS = [
  { id: "today", label: t("tasks.today") },
  { id: "upcoming", label: t("tasks.upcoming") },
  { id: "all", label: t("tasks.all") },
] as const;
type Tab = (typeof TABS)[number]["id"];

const muted = "text-xs text-pretty text-text-2";

/** `2026-11-13` as the viewer's short weekday and date, e.g. "Fri, 13 Nov"; the date itself when it is not one. */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/**
 * What every row needs: the CSRF token for its actions (null with no commands actor), each open task's title by ID,
 * and `completed`, which keeps a task the row completed for ⌘Z.
 */
const Rows = createContext<{ token: string | null; titles: ReadonlyMap<string, string>; projects: readonly ProjectChoice[]; completed: (task: TaskRow) => void }>({
  token: null, titles: new Map(), projects: [], completed: () => {},
});

const ALERT = "text-xs text-pretty break-words text-pill-bad-fg";

/** Build this: one POST; its refusal stays beside the button until the next try. */
function BuildButton({ task, token }: { task: TaskRow; token: string }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const build = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postTaskBuild(token, task.id);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      announceStatus(t("tasks.inIntake", { title: task.title, id: r.work_item_id }));
      await client.invalidateQueries({ queryKey: [API.tasks] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-col items-start gap-1">
      <Button variant="secondary" disabled={busy} aria-label={t("tasks.buildLabel", { title: task.title })} onClick={() => void build()}>
        {t("tasks.build")}
      </Button>
      {error !== null && (
        <span role="alert" className={ALERT}>
          {error}
        </span>
      )}
    </span>
  );
}

/** A new ID: the prefix (`tk_` for a task, `pj_` for a project) and 32 hex characters, inside the routes' 8 to 64 URL-safe ones. */
const newId = (prefix: "tk_" | "pj_"): string => `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;

/** The ID for these words: the one kept for them since the last success, so a retry after an error stores one task (or project). */
function idFor(attempt: { current: { id: string; words: string } | null }, words: string, prefix: "tk_" | "pj_" = "tk_"): string {
  if (attempt.current?.words !== words) attempt.current = { id: newId(prefix), words };
  return attempt.current.id;
}

/** One row action at a time: its POST, the error it answered, and a reload of the tasks on success. */
function useTaskAction(token: string | null) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: TaskAction, body: Record<string, string>): Promise<boolean> => {
    if (token === null || busy) return false;
    setBusy(true);
    setError(null);
    try {
      const r = await postTaskAction(token, action, body);
      if (!r.ok) {
        setError(r.error);
        return false;
      }
      await client.invalidateQueries({ queryKey: [API.tasks] });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/**
 * Quick add: the submit key (`addKey`, the owner's `tasks_add_key` setting: Enter, or ⌘Enter with plain Enter adding
 * nothing) or Add posts the words under an ID the page chose. The field keeps that ID, for those words, until the add
 * succeeds, so a retry after an error stores one task. Esc clears the field. The placeholder names the submit key.
 */
function QuickAdd({ token, addKey }: { token: string | null; addKey: QuickAddKey }) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ id: string; words: string } | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const words = text.trim();
    if (token === null || busy || words === "") return;
    const id = idFor(attempt, words);
    setBusy(true);
    setError(null);
    try {
      const r = await postTaskAdd(token, id, words);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      attempt.current = null;
      setText("");
      await client.invalidateQueries({ queryKey: [API.tasks] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-1">
      <div className="flex gap-2">
        <Input
          ref={input}
          {...{ [QUICK_ADD_ATTR]: "" }}
          className="flex-1"
          aria-label={t("tasks.addLabel")}
          placeholder={t("tasks.addPlaceholder", { key: QUICK_ADD_KEYS[addKey].label })}
          aria-keyshortcuts={QUICK_ADD_KEYS[addKey].aria}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setText("");
              setError(null);
            } else if (e.key === "Enter") {
              // The form's own submit on Enter is replaced by the chosen key's.
              e.preventDefault();
              if (isQuickAddSubmit(e.nativeEvent, addKey)) void submit();
            }
          }}
        />
        <Button type="submit" disabled={token === null || busy}>
          {t("tasks.add")}
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * A one-line form in a row (edit, add sub-task): Enter or Save sends the words, Esc or Cancel closes it with no write.
 * `onSave` answers whether the words were stored; on a refusal the form stays open with the words.
 */
function RowForm({ label, initial = "", placeholder, hint, busy, onSave, onClose }: {
  label: string;
  initial?: string;
  placeholder?: string;
  hint?: string;
  busy: boolean;
  onSave: (words: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (await onSave(text.trim())) onClose();
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <Input
          autoFocus
          className="min-w-0 flex-1"
          aria-label={label}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <Button type="submit" disabled={busy}>
          {t("tasks.save")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
      {hint !== undefined && <p className={muted}>{hint}</p>}
    </form>
  );
}

/** The delete confirm: the shared Dialog with danger set; it deletes only on confirm, and a refusal stays in it with its reason. */
function DeleteDialog({ task, token, returnFocusTo, onClose }: { task: TaskRow; token: string; returnFocusTo: RefObject<HTMLElement | null>; onClose: () => void }) {
  const action = useTaskAction(token);
  const confirm = async () => {
    if (await action.run("delete", { id: task.id })) {
      announceStatus(t("tasks.deleted", { title: task.title }));
      onClose();
    }
  };
  return (
    <Dialog
      danger
      title={t("tasks.deleteTitle", { title: task.title })}
      consequence={t("tasks.deleteConsequence")}
      confirmLabel={t("tasks.delete")}
      confirmDisabled={action.busy}
      error={action.error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => void confirm()}
      onClose={onClose}
    />
  );
}

/**
 * The project dialog: the shared Dialog with a checkbox per active project (checked: the task is in it), each change
 * posted at once, and a New project field whose Create project (or Enter) creates the project under an ID kept for that
 * name, so a retry stores one project, then puts the task in it. A refusal stays in the dialog with its reason. It
 * renders into document.body, so the row keeps its height.
 */
function ProjectsDialog({ task, token, returnFocusTo, onClose }: { task: TaskRow; token: string; returnFocusTo: RefObject<HTMLElement | null>; onClose: () => void }) {
  const { projects } = useContext(Rows);
  const client = useQueryClient();
  const attempt = useRef<{ id: string; words: string } | null>(null);
  const [linked, setLinked] = useState<ReadonlySet<string>>(() => new Set(task.projects ?? []));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** One write at a time; its refusal or failure stays in the dialog. */
  const send = async (write: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await write()) await client.invalidateQueries({ queryKey: [API.tasks] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const link = async (p: ProjectChoice, add: boolean): Promise<boolean> => {
    const r = await postTaskProject(token, task.id, p.slug, add);
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    setLinked((now) => {
      const next = new Set(now);
      if (add) next.add(p.slug);
      else next.delete(p.slug);
      return next;
    });
    announceStatus(t(add ? "tasks.addedToProject" : "tasks.removedFromProject", { title: task.title, name: p.name }));
    return true;
  };
  const create = () =>
    send(async () => {
      const words = name.trim();
      const r = await postProject(token, idFor(attempt, words, "pj_"), words);
      if (!r.ok) {
        setError(r.error);
        return false;
      }
      attempt.current = null;
      setName("");
      await link(r.project, true);
      return true;
    });
  return (
    <Dialog
      title={t("tasks.projectsTitle", { title: task.title })}
      consequence={t("tasks.projectsHint")}
      confirmLabel={t("tasks.createProject")}
      confirmDisabled={busy || name.trim() === ""}
      cancelLabel={t("tasks.projectsClose")}
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => void create()}
      onClose={onClose}
    >
      {projects.length === 0 ? (
        <p className={muted}>{t("tasks.noProjects")}</p>
      ) : (
        <ul aria-label={t("tasks.project")} className="max-h-64 divide-y divide-border overflow-y-auto rounded-control border border-border">
          {projects.map((p) => {
            const checked = linked.has(p.slug);
            return (
              <li key={p.slug} data-project={p.slug} className="flex items-center gap-3 px-3 py-2">
                {/* The shared Button as a checkbox, as on the task row: components/ui has no checkbox. */}
                <Button size="icon" role="checkbox" aria-checked={checked} aria-label={p.name} disabled={busy} onClick={() => void send(() => link(p, !checked))}>
                  <span aria-hidden>{checked ? "✓" : ""}</span>
                </Button>
                <span className="min-w-0 flex-1 text-sm break-words">{p.name}</span>
                <span className={cn(muted, "break-all")}>+{p.slug}</span>
              </li>
            );
          })}
        </ul>
      )}
      <Field label={t("tasks.newProject")} htmlFor={`new-project-${task.id}`} help={t("tasks.newProjectHint")}>
        <Input id={`new-project-${task.id}`} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function TaskCard({ task, overdue = false, sub = false }: { task: TaskRow; overdue?: boolean; sub?: boolean }) {
  const { token, titles, completed } = useContext(Rows);
  const row = useRef<HTMLLIElement>(null);
  const action = useTaskAction(token);
  const [mode, setMode] = useState<"view" | "edit" | "sub" | "delete" | "projects">("view");
  const [checked, setChecked] = useState(false);
  const parent = task.parent_task_id ?? null;
  const due = task.due_date === null ? null : task.due_time === null ? task.due_date : `${task.due_date} ${task.due_time}`;
  const minutes = task.due_time === null ? null : (task.duration_minutes ?? DEFAULT_MINUTES);
  const close = () => {
    setMode("view");
    action.setError(null);
    row.current?.focus();
  };
  const complete = async () => {
    setChecked(true);
    if (await action.run("done", { id: task.id })) {
      completed(task);
      announceStatus(t("tasks.completed", { title: task.title }));
    } else setChecked(false);
  };
  // `e` and Delete act on the row itself when it has focus, not on a control inside it.
  const onKey = (e: KeyboardEvent<HTMLLIElement>) => {
    if (token === null || e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey || mode !== "view") return;
    if (e.key === "e" || e.key === "Delete") {
      e.preventDefault();
      setMode(e.key === "e" ? "edit" : "delete");
    }
  };
  const subAttempt = useRef<{ id: string; words: string } | null>(null);
  const items = [
    ...(parent === null ? [{ label: t("tasks.addSub"), onSelect: () => setMode("sub") }] : []),
    { label: t("tasks.projectsItem"), onSelect: () => setMode("projects") },
    { label: t("tasks.delete"), danger: true, onSelect: () => setMode("delete") },
  ];
  return (
    <li
      ref={row}
      tabIndex={token === null ? undefined : 0}
      onKeyDown={onKey}
      data-task={task.id}
      data-key={token === null ? undefined : task.id}
      data-overdue={overdue ? "" : undefined}
      data-sub={sub ? "" : undefined}
      draggable={token !== null && mode === "view"}
      onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, task.id)}
      className={cn("flex flex-wrap items-start justify-between gap-x-3 gap-y-2 p-3", FOCUS, "focus-visible:-outline-offset-2", sub && "pl-10")}
    >
      {token !== null && (
        // The shared Button as a checkbox: components/ui has no checkbox, and a raw input is not used outside it.
        <Button
          size="icon"
          role="checkbox"
          aria-checked={checked}
          aria-label={t("tasks.complete", { title: task.title })}
          disabled={action.busy}
          onClick={() => void complete()}
        >
          <span aria-hidden>{checked ? "✓" : ""}</span>
        </Button>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        {mode === "edit" ? (
          <RowForm
            label={t("tasks.edit", { title: task.title })}
            initial={task.title}
            hint={t("tasks.editHint")}
            busy={action.busy}
            // The title as shown, unchanged: nothing to write.
            onSave={async (words) => words === task.title || (await action.run("edit", { id: task.id, words }))}
            onClose={close}
          />
        ) : (
          <p className={cn("text-sm text-pretty break-words", overdue && "font-medium text-pill-bad-fg")}>{task.title}</p>
        )}
        <p className={cn(muted, "flex flex-wrap gap-x-3 gap-y-1")}>
          {overdue && <StatusBadge level="stuck" size="sm">{t("tasks.overdue")}</StatusBadge>}
          {parent !== null && !sub && titles.has(parent) && <span className="break-words">{t("tasks.subOf", { title: titles.get(parent)! })}</span>}
          {due !== null && <span className={cn("tabular-nums", overdue && "text-pill-bad-fg")}>{t("tasks.due", { due })}</span>}
          {minutes !== null && <span className="tabular-nums">{t("tasks.minutes", { minutes })}</span>}
          {task.priority !== null && <span>!{task.priority}</span>}
          {task.list !== null && <span className="break-all">#{task.list}</span>}
          {task.recurrence !== null && <span>{t("tasks.every", { recurrence: task.recurrence })}</span>}
        </p>
        {mode === "sub" && (
          <RowForm
            label={t("tasks.subLabel", { title: task.title })}
            placeholder={t("tasks.subPlaceholder")}
            busy={action.busy}
            onSave={async (words) => {
              const ok = await action.run("sub", { parent: task.id, id: idFor(subAttempt, words), words });
              if (ok) subAttempt.current = null;
              return ok;
            }}
            onClose={close}
          />
        )}
        {action.error !== null && mode !== "delete" && mode !== "projects" && (
          <p role="alert" className={ALERT}>
            {action.error}
          </p>
        )}
      </div>
      <div className="flex items-start gap-2">
        {task.work_item_id !== null ? (
          <>
            <WorkState id={task.work_item_id} title={task.title} />
            <Link href={itemPath(task.work_item_id)} className={cn(LINK_CLASS, "font-mono text-xs break-all")}>
              {task.work_item_id}
            </Link>
          </>
        ) : (
          token !== null && <BuildButton task={task} token={token} />
        )}
        {token !== null && <OverflowMenu label={t("tasks.more", { title: task.title })} items={items} />}
      </div>
      {mode === "delete" && token !== null && <DeleteDialog task={task} token={token} returnFocusTo={row} onClose={close} />}
      {mode === "projects" && token !== null && <ProjectsDialog task={task} token={token} returnFocusTo={row} onClose={close} />}
    </li>
  );
}

/**
 * The list's rows with each sub-task right after its parent when both are in the list, so it shows indented under
 * it; a sub-task whose parent is in another list stays in place and names its parent.
 */
function nest(tasks: readonly TaskRow[]): { row: TaskRow; sub: boolean }[] {
  const here = new Set(tasks.map((x) => x.id));
  const under = (x: TaskRow) => x.parent_task_id != null && here.has(x.parent_task_id);
  return tasks.filter((x) => !under(x)).flatMap((x) => [{ row: x, sub: false }, ...tasks.filter((s) => s.parent_task_id === x.id).map((s) => ({ row: s, sub: true }))]);
}

/** The tasks among a day's rows: the server also places calendar events there, which the Calendar page shows. */
const tasksOf = (rows: readonly DayRow[]): TaskRow[] => rows.filter((x): x is TaskRow => !isEventRow(x));

function TaskList({ label, tasks, overdue = false }: { label: string; tasks: readonly TaskRow[]; overdue?: boolean }) {
  return (
    <ul aria-label={label} className="divide-y divide-border rounded-control border border-border">
      {nest(tasks).map(({ row, sub }) => (
        <TaskCard key={row.id} task={row} overdue={overdue} sub={sub} />
      ))}
    </ul>
  );
}

/** One heading and its list, for the groups of Today, Upcoming and All. */
function Group({ title, tasks, overdue = false }: { title: string; tasks: readonly TaskRow[]; overdue?: boolean }) {
  return (
    <div className="space-y-1">
      <h3 className={cn("text-xs font-medium", overdue ? "text-pill-bad-fg" : "text-text-2")}>{title}</h3>
      <TaskList label={title} tasks={tasks} overdue={overdue} />
    </div>
  );
}

/** What a task row carries when dragged: its ID. */
const DRAG_TYPE = "text/plain";
/** A timed task with no stored duration is drawn this long (the server plans it so too). */
const DEFAULT_MINUTES = 30;
/** The timeline's slots: one per half hour; each is h-6 (1.5rem) high, so a minute is 1.5/30 rem. */
const SLOT_MINUTES = 30;
const REM_PER_MINUTE = 1.5 / SLOT_MINUTES;
const SLOTS = Array.from({ length: (24 * 60) / SLOT_MINUTES }, (_, i) => i * SLOT_MINUTES);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * Today's timeline: collapsed until its control is pressed; then a half-hour slot per row, each a drop target for a task
 * row, and the server's scheduled tasks drawn over it at their time and length. A drop schedules the task at the slot; its
 * refusal shows above the timeline.
 */
function Timeline({ date, blocks }: { date: string; blocks: readonly TimelineRow[] }) {
  const { token } = useContext(Rows);
  const action = useTaskAction(token);
  const [over, setOver] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const label = t("tasks.timeline", { day: dayLabel(date) });
  const drop = async (e: DragEvent<HTMLLIElement>, time: string) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    if (id === "") return;
    if (await action.run("schedule", { id, date, time })) announceStatus(t("tasks.scheduled", { time }));
  };
  const body = `timeline-${date}`;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-text-2">{label}</h3>
        <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)}>
          {open ? t("tasks.timelineHide") : t("tasks.timelineShow")}
        </Button>
      </div>
      <div id={body} hidden={!open} className="space-y-1">
      {open && token !== null && <p className={muted}>{t("tasks.timelineHint")}</p>}
      {open && action.error !== null && (
        <p role="alert" className={ALERT}>
          {action.error}
        </p>
      )}
      {open && <div className="max-h-96 overflow-y-auto rounded-control border border-border">
        <div className="relative">
          <ol aria-label={label}>
            {SLOTS.map((m) => {
              const time = hhmm(m);
              return (
                <li
                  key={time}
                  data-slot={time}
                  aria-label={time}
                  onDragOver={token === null ? undefined : (e) => {
                    e.preventDefault();
                    setOver(time);
                  }}
                  onDragLeave={() => setOver((o) => (o === time ? null : o))}
                  onDrop={token === null ? undefined : (e) => void drop(e, time)}
                  className={cn("h-6 border-border pl-2 text-xs text-text-2 tabular-nums", m > 0 && "border-t", m % 60 !== 0 && "border-dashed", over === time && "bg-surface-2")}
                >
                  {m % 60 === 0 ? time : null}
                </li>
              );
            })}
          </ol>
          <ul aria-label={t("tasks.timelineBlocks")}>
            {blocks.filter((b) => b.kind === "task").map((b) => (
              <li
                key={`${b.kind}:${b.id}`}
                data-block={b.id}
                data-minutes={b.minutes}
                className="pointer-events-none absolute right-2 left-16 overflow-hidden rounded-control border border-border-strong bg-surface-2 px-2 text-xs text-text-1"
                style={{ top: `${b.offset * REM_PER_MINUTE}rem`, height: `${b.minutes * REM_PER_MINUTE}rem` }}
              >
                <span className="tabular-nums">{t("tasks.span", { start: b.start, end: b.end })}</span> <span className="break-words">{b.title}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>}
      </div>
    </div>
  );
}

/** How many days one Done read covers: the server's window (DONE_WINDOW_DAYS in src/core/tasks.ts). */
const DONE_DAYS = 30;

/** A done task: its title, its list label and the time it was done; Reopen with the commands actor. Read-only otherwise. */
function DoneCard({ task, busy, onReopen }: { task: DoneRow; busy: boolean; onReopen: () => void }) {
  const { token } = useContext(Rows);
  return (
    <li data-done={task.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm text-pretty break-words">{task.title}</p>
        <p className={cn(muted, "flex flex-wrap gap-x-3 gap-y-1")}>
          <span className="tabular-nums">{t("tasks.doneAt", { at: localDateTime(task.done_at) })}</span>
          <span className="break-all">{task.list === null ? t("tasks.noList") : `#${task.list}`}</span>
        </p>
      </div>
      {token !== null && (
        <Button variant="secondary" disabled={busy} aria-label={t("tasks.reopenLabel", { title: task.title })} onClick={onReopen}>
          {t("tasks.reopen")}
        </Button>
      )}
    </li>
  );
}

/** The done list under All's Show done: its pages of done tasks as one list, Show older while the server says one is older, and Reopen's refusal above the list. */
function DoneList() {
  const { token } = useContext(Rows);
  const q = useDoneTasks();
  const action = useTaskAction(token);
  if (q.isError) return <ErrorNote error={q.error} />;
  const pages = q.data?.pages ?? [];
  if (pages.length === 0) return <Loading rows={3} />;
  const rows = pages.flatMap((p) => p.tasks);
  const reopen = async (task: DoneRow) => {
    if (await action.run("reopen", { id: task.id })) announceStatus(t("tasks.reopened", { title: task.title }));
  };
  return (
    <div className="space-y-3">
      {action.error !== null && (
        <p role="alert" className={ALERT}>
          {action.error}
        </p>
      )}
      {rows.length === 0 ? (
        <EmptyState title={t("tasks.emptyDone", { days: pages.length * DONE_DAYS })} />
      ) : (
        <ul aria-label={t("tasks.done")} className="divide-y divide-border rounded-control border border-border">
          {rows.map((task) => (
            <DoneCard key={task.id} task={task} busy={action.busy} onReopen={() => void reopen(task)} />
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <Button variant="secondary" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {t("tasks.showOlder")}
        </Button>
      )}
    </div>
  );
}

/** Upcoming's days: the server's upcoming days after today (today's tasks are in Today), each with its tasks only. */
const upcomingDays = (v: TasksView) =>
  v.upcoming.filter((d) => d.date !== v.today_date).map((d) => ({ date: d.date, tasks: tasksOf(d.tasks) })).filter((d) => d.tasks.length > 0);

/** All: every open task under its #list, then the Show done switch and, when on, the done list. */
function AllView({ v, showDone, setShowDone }: { v: TasksView; showDone: boolean; setShowDone: (on: boolean) => void }) {
  return (
    <div className="space-y-3">
      {v.projects.length === 0 ? (
        <EmptyState title={t("tasks.emptyAll")} />
      ) : (
        v.projects.map((p) => <Group key={p.list ?? ""} title={p.list === null ? t("tasks.noList") : `#${p.list}`} tasks={p.tasks} />)
      )}
      <label className="flex items-center gap-2 text-sm text-text-2">
        <Switch checked={showDone} onCheckedChange={setShowDone} />
        {t("tasks.showDone")}
      </label>
      {showDone && <DoneList />}
    </div>
  );
}

function TabBody({ tab, v, showDone, setShowDone }: { tab: Tab; v: TasksView; showDone: boolean; setShowDone: (on: boolean) => void }) {
  if (tab === "all") return <AllView v={v} showDone={showDone} setShowDone={setShowDone} />;
  if (tab === "today") {
    const today = tasksOf(v.today.due);
    return (
      <div className="space-y-3">
        {today.length + v.today.overdue.length === 0 && <EmptyState title={t("tasks.emptyToday")} />}
        {v.today.overdue.length > 0 && <Group title={t("tasks.overdue")} tasks={v.today.overdue} overdue />}
        {today.length > 0 && <Group title={t("tasks.todayDay", { day: dayLabel(v.today_date) })} tasks={today} />}
        <Timeline date={v.today_date} blocks={v.timeline ?? []} />
      </div>
    );
  }
  const upcoming = upcomingDays(v);
  if (upcoming.length === 0) return <EmptyState title={t("tasks.emptyUpcoming")} />;
  return (
    <div className="space-y-3">
      {upcoming.map((d) => (
        <Group key={d.date} title={dayLabel(d.date)} tasks={d.tasks} />
      ))}
    </div>
  );
}

/** True when the view lists at least one open task. */
const hasTasks = (v: TasksView, tab: Tab): boolean =>
  (tab === "today" ? [...v.today.overdue, ...tasksOf(v.today.due)]
  : tab === "upcoming" ? upcomingDays(v).flatMap((d) => d.tasks)
  : v.projects.flatMap((p) => p.tasks)
  ).length > 0;

/**
 * ⌘Z: the tasks this page completed, newest last, in memory only (a reload clears them). Each press outside a field
 * reopens the newest one and reloads the tasks; with none kept it does nothing and sends nothing. A refusal (its next
 * occurrence is done, say) shows beside the quick-add field.
 */
function useUndoDone(token: string | null) {
  const client = useQueryClient();
  const done = useRef<TaskRow[]>([]);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const on = async (e: globalThis.KeyboardEvent) => {
      if (!isUndo(e) || tokenRef.current === null) return;
      const task = done.current.pop();
      if (task === undefined) return;
      e.preventDefault();
      setError(null);
      try {
        const r = await postTaskAction(tokenRef.current, "reopen", { id: task.id });
        if (!r.ok) {
          setError(r.error);
          return;
        }
        announceStatus(t("tasks.reopened", { title: task.title }));
        await client.invalidateQueries({ queryKey: [API.tasks] });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    const listener = (e: globalThis.KeyboardEvent) => void on(e);
    addEventListener("keydown", listener);
    return () => removeEventListener("keydown", listener);
  }, [client]);
  return { error, completed: (task: TaskRow) => void done.current.push(task) };
}

/** The `project` query parameter: the project tab's choice, null for All projects. */
const urlProject = (): string | null => new URLSearchParams(location.search).get("project") || null;

/** The project tab's choice, read from the URL on load and written to it (in place, no new history entry) on change. */
function useProjectParam(): [string | null, (slug: string | null) => void] {
  const [project, setProject] = useState(urlProject);
  const choose = (slug: string | null) => {
    const url = new URL(location.href);
    if (slug === null) url.searchParams.delete("project");
    else url.searchParams.set("project", slug);
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    setProject(slug);
  };
  return [project, choose];
}

/** The project tabs: All projects (id ""), then the active projects; a slug the URL names that is not among them stays listed by its slug. */
function ProjectTabs({ projects, value, onChange }: { projects: readonly ProjectChoice[]; value: string | null; onChange: (slug: string | null) => void }) {
  const choices = value === null || projects.some((p) => p.slug === value) ? projects : [...projects, { slug: value, name: `+${value}` }];
  const options = [{ id: "", label: t("tasks.allProjects") }, ...choices.map((p) => ({ id: p.slug, label: p.name }))];
  return <Tabs label={t("tasks.project")} options={options} value={value ?? ""} onChange={(id) => onChange(id === "" ? null : id)} />;
}

export function TasksPage() {
  const [tab, setTab] = useState<Tab>("today");
  // All's Show done: off on load, kept while the owner moves between views.
  const [showDone, setShowDone] = useState(false);
  const [project, setProject] = useProjectParam();
  const q = useTasks<TasksView & { add_key?: QuickAddKey }>(project);
  const v = q.data;
  const token = v?.can_build ? v.csrf_token : null;
  const undo = useUndoDone(token);
  // All's groups hold every open task the read returned, so its titles name each sub-task's parent.
  const titles = new Map(v?.projects.flatMap((p) => p.tasks.map((x) => [x.id, x.title] as const)) ?? []);
  // Kept from the last read, so the tabs keep their choices while a new filter loads.
  const known = useRef<readonly ProjectChoice[]>([]);
  if (v?.active_projects !== undefined) known.current = v.active_projects;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-start gap-3">
        <ProjectTabs projects={known.current} value={project} onChange={setProject} />
        <SegmentedControl label={t("tasks.viewLabel")} options={TABS} value={tab} onChange={setTab} />
      </div>
      <div className="space-y-1">
        <QuickAdd token={v?.csrf_token ?? null} addKey={v?.add_key ?? "enter"} />
        {undo.error !== null && (
          <p role="alert" className={ALERT}>
            {undo.error}
          </p>
        )}
      </div>
      <div className="empty:hidden">
        <FactoryWork project={project} />
      </div>
      <div>
        <Section label={TABS.find((x) => x.id === tab)!.label}>
          <div className="space-y-3">
            {q.isError ? <ErrorNote error={q.error} /> : !v ? <Loading rows={3} /> : <Rows.Provider value={{ token, titles, projects: known.current, completed: undo.completed }}>
                <TabBody tab={tab} v={v} showDone={showDone} setShowDone={setShowDone} />
              </Rows.Provider>}
            {v?.can_build && hasTasks(v, tab) && <p className={muted}>{t("tasks.buildNote")}</p>}
          </div>
        </Section>
      </div>
    </div>
  );
}
