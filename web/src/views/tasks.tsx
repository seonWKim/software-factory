import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type KeyboardEvent, type RefObject, createContext, useContext, useRef, useState } from "react";
import { API, type DayRow, type EventRow, type TaskAction, type TaskRow, type TasksView, isEventRow, postTaskAction, postTaskAdd, postTaskBuild, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { FOCUS } from "../components/ui/control.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Notice } from "../components/ui/notice.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { Badge, Empty, ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { t } from "../i18n/index.js";
import { QUICK_ADD_ATTR } from "../keys.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";

// The Tasks page (design 02-tasks and 09-dashboard-app, issue #607): the owner's open plain tasks, read through GET
// /api/v1/tasks, in four tabs. Inbox: no due date. Today: overdue first, in red, then today's tasks and calendar
// events. Upcoming: today through 7 days ahead, by day, tasks and events. Project: every task under its #list. The
// server places each task and event and orders each day (all-day events, then timed items by time, then untimed
// tasks), so the page does no date arithmetic. A source whose last sync failed is named with its last sync time. Build this sends a task to intake once (POST /api/v1/tasks/build); a
// built task links to its work item instead. One list of cards at every width, so no table turns into cards.
// Each row's actions (design 02-tasks) post to the route that calls the CLI command's store method: the checkbox
// completes it, `e` or Edit edits it in place (Enter saves, Esc cancels), and its overflow menu adds a sub-task (top-level
// rows only) or deletes it through the danger Dialog. A sub-task shows indented under its parent, one level.

const TABS = [
  { id: "inbox", label: t("tasks.inbox") },
  { id: "today", label: t("tasks.today") },
  { id: "upcoming", label: t("tasks.upcoming") },
  { id: "project", label: t("tasks.project") },
] as const;
type Tab = (typeof TABS)[number]["id"];

const muted = "text-xs text-pretty text-text-2";

/** `2026-11-13` as the viewer's short weekday and date, e.g. "Fri, 13 Nov"; the date itself when it is not one. */
function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** What every row needs: the CSRF token for its actions (null with no commands actor) and each open task's title by ID. */
const Rows = createContext<{ token: string | null; titles: ReadonlyMap<string, string> }>({ token: null, titles: new Map() });

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

/** A new task ID: `tk_` and 32 hex characters, inside the route's 8 to 64 URL-safe ones. */
const newTaskId = (): string => `tk_${crypto.randomUUID().replaceAll("-", "")}`;

/** The ID for these words: the one kept for them since the last success, so a retry after an error stores one task. */
function idFor(attempt: { current: { id: string; words: string } | null }, words: string): string {
  if (attempt.current?.words !== words) attempt.current = { id: newTaskId(), words };
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
 * Quick add: Enter or Add posts the words under an ID the page chose. The field keeps that ID, for those words, until
 * the add succeeds, so a retry after an error stores one task. Esc clears the field.
 */
function QuickAdd({ token }: { token: string | null }) {
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
          placeholder={t("tasks.addPlaceholder")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setText("");
              setError(null);
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

function TaskCard({ task, overdue = false, sub = false }: { task: TaskRow; overdue?: boolean; sub?: boolean }) {
  const { token, titles } = useContext(Rows);
  const row = useRef<HTMLLIElement>(null);
  const action = useTaskAction(token);
  const [mode, setMode] = useState<"view" | "edit" | "sub" | "delete">("view");
  const [checked, setChecked] = useState(false);
  const parent = task.parent_task_id ?? null;
  const due = task.due_date === null ? null : task.due_time === null ? task.due_date : `${task.due_date} ${task.due_time}`;
  const close = () => {
    setMode("view");
    action.setError(null);
    row.current?.focus();
  };
  const complete = async () => {
    setChecked(true);
    if (await action.run("done", { id: task.id })) announceStatus(t("tasks.completed", { title: task.title }));
    else setChecked(false);
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
          {overdue && <Badge level="stuck">{t("tasks.overdue")}</Badge>}
          {parent !== null && !sub && titles.has(parent) && <span className="break-words">{t("tasks.subOf", { title: titles.get(parent)! })}</span>}
          {due !== null && <span className={cn("tabular-nums", overdue && "text-pill-bad-fg")}>{t("tasks.due", { due })}</span>}
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
        {action.error !== null && mode !== "delete" && (
          <p role="alert" className={ALERT}>
            {action.error}
          </p>
        )}
      </div>
      <div className="flex items-start gap-2">
        {task.work_item_id !== null ? (
          <Link href={itemPath(task.work_item_id)} className={cn(LINK_CLASS, "font-mono text-xs break-all")}>
            {task.work_item_id}
          </Link>
        ) : (
          token !== null && <BuildButton task={task} token={token} />
        )}
        {token !== null && <OverflowMenu label={t("tasks.more", { title: task.title })} items={items} />}
      </div>
      {mode === "delete" && token !== null && <DeleteDialog task={task} token={token} returnFocusTo={row} onClose={close} />}
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
          <Badge>{t("tasks.event")}</Badge>
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

/** One heading and its list, for the groups of Today, Upcoming and Project. */
function Group({ title, tasks, overdue = false }: { title: string; tasks: readonly DayRow[]; overdue?: boolean }) {
  return (
    <div className="space-y-1">
      <h3 className={cn("text-xs font-medium", overdue ? "text-pill-bad-fg" : "text-text-2")}>{title}</h3>
      <TaskList label={title} tasks={tasks} overdue={overdue} />
    </div>
  );
}

function TabBody({ tab, v }: { tab: Tab; v: TasksView }) {
  if (tab === "inbox") {
    return v.inbox.length === 0 ? <Empty>{t("tasks.emptyInbox")}</Empty> : <TaskList label={t("tasks.inbox")} tasks={v.inbox} />;
  }
  if (tab === "today") {
    if (v.today.overdue.length + v.today.due.length === 0) return <Empty>{t("tasks.emptyToday")}</Empty>;
    return (
      <div className="space-y-3">
        {v.today.overdue.length > 0 && <Group title={t("tasks.overdue")} tasks={v.today.overdue} overdue />}
        {v.today.due.length > 0 && <Group title={t("tasks.todayDay", { day: dayLabel(v.today_date) })} tasks={v.today.due} />}
      </div>
    );
  }
  if (tab === "upcoming") {
    if (v.upcoming.length === 0) return <Empty>{t("tasks.emptyUpcoming")}</Empty>;
    return (
      <div className="space-y-3">
        {v.upcoming.map((d) => (
          <Group key={d.date} title={dayLabel(d.date)} tasks={d.tasks} />
        ))}
      </div>
    );
  }
  if (v.projects.length === 0) return <Empty>{t("tasks.emptyProject")}</Empty>;
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

const count = (v: TasksView, tab: Tab): number =>
  tab === "inbox" ? v.inbox.length
  : tab === "today" ? v.today.overdue.length + v.today.due.length
  : tab === "upcoming" ? v.upcoming.reduce((n, d) => n + d.tasks.length, 0)
  : v.projects.reduce((n, p) => n + p.tasks.length, 0);

export function TasksPage() {
  const [tab, setTab] = useState<Tab>("today");
  const q = useApi<TasksView>(API.tasks);
  const v = q.data;
  const token = v?.can_build ? v.csrf_token : null;
  // Every open task is in Projects, so its titles name each sub-task's parent.
  const titles = new Map(v?.projects.flatMap((p) => p.tasks.map((x) => [x.id, x.title] as const)) ?? []);
  return (
    <>
      <QuickAdd token={v?.csrf_token ?? null} />
      <SegmentedControl label={t("tasks.viewLabel")} options={TABS} value={tab} onChange={setTab} className="mb-6" />
      <Section title={TABS.find((t) => t.id === tab)!.label} count={v ? count(v, tab) : undefined}>
        {v && (tab === "today" || tab === "upcoming") && <StaleCalendars v={v} />}
        {q.isError ? <ErrorNote error={q.error} /> : !v ? <Loading rows={3} /> : <Rows.Provider value={{ token, titles }}>
            <TabBody tab={tab} v={v} />
          </Rows.Provider>}
        <p className={`mt-3 ${muted}`}>
          {t("tasks.buildNote")}
        </p>
      </Section>
    </>
  );
}
