import { useQueryClient } from "@tanstack/react-query";
import { type DragEvent, type FormEvent, type KeyboardEvent, type RefObject, createContext, useContext, useEffect, useRef, useState } from "react";
import {
  API, type DayRow, type DoneRow, type EventRow, type ProjectChoice, type TaskAction, type TaskRow, type TasksView, type TimelineRow, isEventRow, postProject, postTaskAction,
  postTaskAdd, postTaskBuild, postTaskProject, useDoneTasks, useTasks,
} from "../api.js";
import { Button } from "../components/ui/button.js";
import { FOCUS } from "../components/ui/control.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { EmptyState, Notice, StatusBadge } from "../components/ui/notice.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Select } from "../components/ui/select.js";
import { t } from "../i18n/index.js";
import { QUICK_ADD_ATTR, QUICK_ADD_KEYS, type QuickAddKey, isQuickAddSubmit, isUndo } from "../keys.js";
import { cn } from "../lib/cn.js";
import { localDateTime } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { FactoryWork, WorkState } from "./task-work.js";

// The Tasks page (design 02-tasks and 09-dashboard-app, issue #607): the owner's open plain tasks, read through GET
// /api/v1/tasks, in four tabs. Inbox: no due date. Today: overdue first, in red, then today's tasks and calendar
// events. Upcoming: today through 7 days ahead, by day, tasks and events. List: every task under its #list. The
// server places each task and event and orders each day (all-day events, then timed items by time, then untimed
// tasks), so the page does no date arithmetic. A source whose last sync failed is named with its last sync time. Build this sends a task to intake once (POST /api/v1/tasks/build); a
// built task links to its work item instead. One list of cards at every width, so no table turns into cards.
// Each row's actions (design 02-tasks) post to the route that calls the CLI command's store method: the checkbox
// completes it, `e` or Edit edits it in place (Enter saves, Esc cancels), and its overflow menu adds a sub-task (top-level
// rows only) or deletes it through the danger Dialog. A sub-task shows indented under its parent, one level.
// Inbox and Today end with today's timeline (design 02-tasks, schedule a task): the server places each timed task, drawn
// its duration (30 minutes when none is stored), and each timed event, read-only. A task row dragged onto a
// half-hour slot is scheduled there (POST /api/v1/tasks/schedule: today's date, the slot's time); typing a time in
// the row's edit (3pm, 45m) does the same from the keyboard.
// ⌘Z outside a field undoes the last completion this page made (POST /api/v1/tasks/reopen, `factory task reopen`), then
// the one before it: the page keeps the completed tasks in memory only, so a reload forgets them, and it never undoes an
// edit or a delete.
// Done, the fifth tab (design 02-tasks, Done view), reads GET /api/v1/tasks/done: the tasks done in the last 30 days, most
// recently done first, one flat list across all lists with each row's list label and done time. Show older reads the 30
// days before the oldest row shown, and is hidden when the server says none is older. Each row's Reopen posts the same
// route as ⌘Z; a refusal (its next occurrence is done) shows above the list. Its read shares the tasks' query key, so a
// completion or a reopen reloads it with the open views.
// The Project switcher (design 09-dashboard-app, task projects) filters Inbox, Today, Upcoming and List to one active
// task project's tasks (GET /api/v1/tasks?project=<slug>); its choice is the page's `project` query parameter, read on
// load and set on change, so a filtered view can be shared and reloaded. Done is not filtered. Factory work above
// the tabs follows it too (GET /api/v1/items?project=<slug>): only the work items built from that project's tasks. Each open row's overflow
// item Projects… opens the project dialog: a checkbox per active project adds or removes the task's link (POST
// /api/v1/tasks/project) and New project creates one (POST /api/v1/projects) and puts the task in it.

const TABS = [
  { id: "inbox", label: t("tasks.inbox") },
  { id: "today", label: t("tasks.today") },
  { id: "upcoming", label: t("tasks.upcoming") },
  { id: "list", label: t("tasks.list") },
  { id: "done", label: t("tasks.done") },
] as const;
type Tab = (typeof TABS)[number]["id"];

const muted = "text-xs text-pretty text-text-2";

/** `2026-11-13` as the viewer's short weekday and date, e.g. "Fri, 13 Nov"; the date itself when it is not one. */
function dayLabel(date: string): string {
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
    <form onSubmit={(e) => void submit(e)} className="mb-6 space-y-1">
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
 * it; a sub-task whose parent is in another list stays in place and names its parent. Events are never nested.
 */
function nest(rows: readonly DayRow[]): { row: DayRow; sub: boolean }[] {
  const tasks = rows.filter((x): x is TaskRow => !isEventRow(x));
  const here = new Set(tasks.map((x) => x.id));
  const under = (x: DayRow) => !isEventRow(x) && x.parent_task_id != null && here.has(x.parent_task_id);
  const subs = (x: DayRow) => (isEventRow(x) ? [] : tasks.filter((s) => s.parent_task_id === x.id).map((s) => ({ row: s, sub: true })));
  return rows.filter((x) => !under(x)).flatMap((x) => [{ row: x, sub: false }, ...subs(x)]);
}

/** A calendar event: its title, its time that day or "all day", and its source's name. Read-only. */
function EventCard({ event }: { event: EventRow }) {
  return (
    <li data-event={`${event.source}:${event.id}`} className="flex flex-wrap items-start gap-x-3 gap-y-2 p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm text-pretty break-words">{event.title}</p>
        <p className={cn(muted, "flex flex-wrap gap-x-3 gap-y-1")}>
          <StatusBadge size="sm">{t("tasks.event")}</StatusBadge>
          <span className="tabular-nums">{event.time ?? t("tasks.allDay")}</span>
          <span className="break-all">{event.source}</span>
        </p>
      </div>
    </li>
  );
}

function TaskList({ label, tasks, overdue = false }: { label: string; tasks: readonly DayRow[]; overdue?: boolean }) {
  return (
    <ul aria-label={label} className="divide-y divide-border rounded-control border border-border">
      {nest(tasks).map(({ row, sub }) =>
        isEventRow(row) ? <EventCard key={`event:${row.source}:${row.id}`} event={row} /> : <TaskCard key={row.id} task={row} overdue={overdue} sub={sub} />,
      )}
    </ul>
  );
}

/** One heading and its list, for the groups of Today, Upcoming and List. */
function Group({ title, tasks, overdue = false }: { title: string; tasks: readonly DayRow[]; overdue?: boolean }) {
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
 * Today's timeline: a half-hour slot per row, each a drop target for a task row, and the server's blocks drawn over
 * it at their time and length. A drop schedules the task at the slot; its refusal shows above the timeline.
 */
function Timeline({ date, blocks }: { date: string; blocks: readonly TimelineRow[] }) {
  const { token } = useContext(Rows);
  const action = useTaskAction(token);
  const [over, setOver] = useState<string | null>(null);
  const label = t("tasks.timeline", { day: dayLabel(date) });
  const drop = async (e: DragEvent<HTMLLIElement>, time: string) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    if (id === "") return;
    if (await action.run("schedule", { id, date, time })) announceStatus(t("tasks.scheduled", { time }));
  };
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium text-text-2">{label}</h3>
      {token !== null && <p className={muted}>{t("tasks.timelineHint")}</p>}
      {action.error !== null && (
        <p role="alert" className={ALERT}>
          {action.error}
        </p>
      )}
      <div className="max-h-96 overflow-y-auto rounded-control border border-border">
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
            {blocks.map((b) => (
              <li
                key={`${b.kind}:${b.id}`}
                data-block={b.id}
                data-minutes={b.minutes}
                className={cn(
                  "pointer-events-none absolute right-2 left-16 overflow-hidden rounded-control border px-2 text-xs text-text-1",
                  b.kind === "event" ? "border-dashed border-border bg-surface" : "border-border-strong bg-surface-2",
                )}
                style={{ top: `${b.offset * REM_PER_MINUTE}rem`, height: `${b.minutes * REM_PER_MINUTE}rem` }}
              >
                <span className="tabular-nums">{t("tasks.span", { start: b.start, end: b.end })}</span> <span className="break-words">{b.title}</span>
              </li>
            ))}
          </ul>
        </div>
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

/** The Done tab: its pages of done tasks as one list, Show older while the server says one is older, and Reopen's refusal above the list. */
function DoneTab() {
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

/** An empty tab: its message and one next step, which puts the cursor in the quick-add field. */
function EmptyTab({ title }: { title: string }) {
  const focus = () => document.querySelector<HTMLElement>(`[${QUICK_ADD_ATTR}]`)?.focus();
  return (
    <EmptyState
      title={title}
      action={
        <Button variant="secondary" onClick={focus}>
          {t("tasks.emptyAction")}
        </Button>
      }
    />
  );
}

function TabBody({ tab, v }: { tab: Tab; v: TasksView }) {
  if (tab === "done") return <DoneTab />;
  const timeline = <Timeline date={v.today_date} blocks={v.timeline ?? []} />;
  if (tab === "inbox") {
    return (
      <div className="space-y-3">
        {v.inbox.length === 0 ? <EmptyTab title={t("tasks.emptyInbox")} /> : <TaskList label={t("tasks.inbox")} tasks={v.inbox} />}
        {timeline}
      </div>
    );
  }
  if (tab === "today") {
    return (
      <div className="space-y-3">
        {v.today.overdue.length + v.today.due.length === 0 && <EmptyTab title={t("tasks.emptyToday")} />}
        {v.today.overdue.length > 0 && <Group title={t("tasks.overdue")} tasks={v.today.overdue} overdue />}
        {v.today.due.length > 0 && <Group title={t("tasks.todayDay", { day: dayLabel(v.today_date) })} tasks={v.today.due} />}
        {timeline}
      </div>
    );
  }
  if (tab === "upcoming") {
    if (v.upcoming.length === 0) return <EmptyTab title={t("tasks.emptyUpcoming")} />;
    return (
      <div className="space-y-3">
        {v.upcoming.map((d) => (
          <Group key={d.date} title={dayLabel(d.date)} tasks={d.tasks} />
        ))}
      </div>
    );
  }
  if (v.projects.length === 0) return <EmptyTab title={t("tasks.emptyList")} />;
  return (
    <div className="space-y-3">
      {v.projects.map((p) => (
        <Group key={p.list ?? ""} title={p.list === null ? t("tasks.noList") : `#${p.list}`} tasks={p.tasks} />
      ))}
    </div>
  );
}

/** The sources whose last sync failed, each with its last sync time: their events shown are the last stored ones. */
function StaleCalendars({ v }: { v: TasksView }) {
  const failed = (v.calendar ?? []).filter((c) => c.failed);
  if (failed.length === 0) return null;
  const when = (at: string | null) => (at === null ? t("tasks.neverSynced") : t("tasks.lastSynced", { at: new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) }));
  return (
    <div className="mb-3">
      <Notice tone="warn" title={t("tasks.calendarSyncFailed")}>
        {failed.map((c) => (
          <p key={c.source} data-calendar-stale={c.source} className="text-pretty break-words">
            {t("tasks.staleCalendar", { source: c.source, when: when(c.synced_at) })}
          </p>
        ))}
      </Notice>
    </div>
  );
}

/** The open tasks a tab lists; none for Done, whose rows come from their own read. */
const count = (v: TasksView, tab: Tab): number | undefined =>
  tab === "done" ? undefined
  : tab === "inbox" ? v.inbox.length
  : tab === "today" ? v.today.overdue.length + v.today.due.length
  : tab === "upcoming" ? v.upcoming.reduce((n, d) => n + d.tasks.length, 0)
  : v.projects.reduce((n, p) => n + p.tasks.length, 0);

/** True when the tab lists at least one task; calendar events alone do not count. */
const hasTasks = (v: TasksView, tab: Tab): boolean =>
  tab !== "done" && (tab === "inbox" ? v.inbox
  : tab === "today" ? [...v.today.overdue, ...v.today.due]
  : tab === "upcoming" ? v.upcoming.flatMap((d) => d.tasks)
  : v.projects.flatMap((p) => p.tasks)
  ).some((x) => !isEventRow(x));

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

/** The `project` query parameter: the switcher's choice, null for All projects. */
const urlProject = (): string | null => new URLSearchParams(location.search).get("project") || null;

/** The switcher's choice, read from the URL on load and written to it (in place, no new history entry) on change. */
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

/** The Project switcher: All projects, then the active projects; a slug the URL names that is not among them stays listed by its slug. */
function ProjectSwitcher({ projects, value, onChange }: { projects: readonly ProjectChoice[]; value: string | null; onChange: (slug: string | null) => void }) {
  const choices = value === null || projects.some((p) => p.slug === value) ? projects : [...projects, { slug: value, name: `+${value}` }];
  return (
    <Select aria-label={t("tasks.project")} wrapperClassName="w-48 max-w-full" value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}>
      <option value="">{t("tasks.allProjects")}</option>
      {choices.map((p) => (
        <option key={p.slug} value={p.slug}>
          {p.name}
        </option>
      ))}
    </Select>
  );
}

export function TasksPage() {
  const [tab, setTab] = useState<Tab>("today");
  const [project, setProject] = useProjectParam();
  const q = useTasks<TasksView & { add_key?: QuickAddKey }>(project);
  const v = q.data;
  const token = v?.can_build ? v.csrf_token : null;
  const undo = useUndoDone(token);
  // The List tab holds every open task the read returned, so its titles name each sub-task's parent.
  const titles = new Map(v?.projects.flatMap((p) => p.tasks.map((x) => [x.id, x.title] as const)) ?? []);
  // Kept from the last read, so the switcher keeps its choices while a new filter loads.
  const known = useRef<readonly ProjectChoice[]>([]);
  if (v?.active_projects !== undefined) known.current = v.active_projects;
  return (
    <>
      <FactoryWork project={project} />
      <QuickAdd token={v?.csrf_token ?? null} addKey={v?.add_key ?? "enter"} />
      {undo.error !== null && (
        <p role="alert" className={ALERT}>
          {undo.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl label={t("tasks.viewLabel")} options={TABS} value={tab} onChange={setTab} />
        <ProjectSwitcher projects={known.current} value={project} onChange={setProject} />
      </div>
      <Section label={TABS.find((x) => x.id === tab)!.label} count={v ? count(v, tab) : undefined}>
        {v && (tab === "today" || tab === "upcoming") && <StaleCalendars v={v} />}
        {q.isError ? <ErrorNote error={q.error} /> : !v ? <Loading rows={3} /> : <Rows.Provider value={{ token, titles, projects: known.current, completed: undo.completed }}>
            <TabBody tab={tab} v={v} />
          </Rows.Provider>}
        {v?.can_build && hasTasks(v, tab) && <p className={`mt-3 ${muted}`}>{t("tasks.buildNote")}</p>}
      </Section>
    </>
  );
}
