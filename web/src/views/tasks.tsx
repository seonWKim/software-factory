import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { API, type TaskRow, type TasksView, postTaskAdd, postTaskBuild, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { announceStatus } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { Badge, Empty, ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { QUICK_ADD_ATTR } from "../keys.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";

// The Tasks page (design 02-tasks and 09-dashboard-app, issue #607): the owner's open plain tasks, read through GET
// /api/v1/tasks, in four tabs. Inbox: no due date. Today: overdue first, in red, then due today. Upcoming: the next 7
// days, by day. Project: every task under its #list. The server places each task by its due date at its own local
// midnight, so the page does no date arithmetic. Build this sends a task to intake once (POST /api/v1/tasks/build); a
// built task links to its work item instead. One list of cards at every width, so no table turns into cards.

const TABS = [
  { id: "inbox", label: "Inbox" },
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "project", label: "Project" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const muted = "text-xs text-pretty text-text-2";

/** `2026-11-13` as the viewer's short weekday and date, e.g. "Fri, 13 Nov"; the date itself when it is not one. */
function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

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
      announceStatus(`${task.title} is in intake as ${r.work_item_id}.`);
      await client.invalidateQueries({ queryKey: [API.tasks] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-col items-start gap-1">
      <Button variant="secondary" disabled={busy} aria-label={`Build this: ${task.title}`} onClick={() => void build()}>
        Build this
      </Button>
      {error !== null && (
        <span role="alert" className="text-xs text-pretty break-words text-pill-bad-fg">
          {error}
        </span>
      )}
    </span>
  );
}

/** A new task ID: `tk_` and 32 hex characters, inside the route's 8 to 64 URL-safe ones. */
const newTaskId = (): string => `tk_${crypto.randomUUID().replaceAll("-", "")}`;

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
    if (attempt.current?.words !== words) attempt.current = { id: newTaskId(), words };
    setBusy(true);
    setError(null);
    try {
      const r = await postTaskAdd(token, attempt.current.id, words);
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
          aria-label="Add a task"
          placeholder="Add a task, e.g. pay rent friday p1 #home"
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
          Add
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-pretty break-words text-pill-bad-fg">
          {error}
        </p>
      )}
    </form>
  );
}

function TaskCard({ task, overdue = false, token }: { task: TaskRow; overdue?: boolean; token: string | null }) {
  const due = task.due_date === null ? null : task.due_time === null ? task.due_date : `${task.due_date} ${task.due_time}`;
  return (
    <li data-task={task.id} data-overdue={overdue ? "" : undefined} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className={cn("text-sm text-pretty break-words", overdue && "font-medium text-pill-bad-fg")}>{task.title}</p>
        <p className={cn(muted, "flex flex-wrap gap-x-3 gap-y-1")}>
          {overdue && <Badge level="stuck">Overdue</Badge>}
          {due !== null && <span className={cn("tabular-nums", overdue && "text-pill-bad-fg")}>due {due}</span>}
          {task.priority !== null && <span>!{task.priority}</span>}
          {task.list !== null && <span className="break-all">#{task.list}</span>}
          {task.recurrence !== null && <span>every {task.recurrence}</span>}
        </p>
      </div>
      {task.work_item_id !== null ? (
        <Link href={itemPath(task.work_item_id)} className={cn(LINK_CLASS, "font-mono text-xs break-all")}>
          {task.work_item_id}
        </Link>
      ) : (
        token !== null && <BuildButton task={task} token={token} />
      )}
    </li>
  );
}

function TaskList({ label, tasks, token, overdue = false }: { label: string; tasks: readonly TaskRow[]; token: string | null; overdue?: boolean }) {
  return (
    <ul aria-label={label} className="divide-y divide-border rounded-control border border-border">
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} overdue={overdue} token={token} />
      ))}
    </ul>
  );
}

/** One heading and its list, for the groups of Today, Upcoming and Project. */
function Group({ title, tasks, token, overdue = false }: { title: string; tasks: readonly TaskRow[]; token: string | null; overdue?: boolean }) {
  return (
    <div className="space-y-1">
      <h3 className={cn("text-xs font-medium", overdue ? "text-pill-bad-fg" : "text-text-2")}>{title}</h3>
      <TaskList label={title} tasks={tasks} token={token} overdue={overdue} />
    </div>
  );
}

function TabBody({ tab, v, token }: { tab: Tab; v: TasksView; token: string | null }) {
  if (tab === "inbox") {
    return v.inbox.length === 0 ? <Empty>No open task without a due date.</Empty> : <TaskList label="Inbox" tasks={v.inbox} token={token} />;
  }
  if (tab === "today") {
    if (v.today.overdue.length + v.today.due.length === 0) return <Empty>Nothing is due today or overdue.</Empty>;
    return (
      <div className="space-y-3">
        {v.today.overdue.length > 0 && <Group title="Overdue" tasks={v.today.overdue} token={token} overdue />}
        {v.today.due.length > 0 && <Group title={`Today, ${dayLabel(v.today_date)}`} tasks={v.today.due} token={token} />}
      </div>
    );
  }
  if (tab === "upcoming") {
    if (v.upcoming.length === 0) return <Empty>Nothing is due in the next 7 days.</Empty>;
    return (
      <div className="space-y-3">
        {v.upcoming.map((d) => (
          <Group key={d.date} title={dayLabel(d.date)} tasks={d.tasks} token={token} />
        ))}
      </div>
    );
  }
  if (v.projects.length === 0) return <Empty>No open task.</Empty>;
  return (
    <div className="space-y-3">
      {v.projects.map((p) => (
        <Group key={p.list ?? ""} title={p.list === null ? "No list" : `#${p.list}`} tasks={p.tasks} token={token} />
      ))}
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
  return (
    <>
      <QuickAdd token={v?.csrf_token ?? null} />
      <SegmentedControl label="Task view" options={TABS} value={tab} onChange={setTab} className="mb-6" />
      <Section title={TABS.find((t) => t.id === tab)!.label} count={v ? count(v, tab) : undefined}>
        {q.isError ? <ErrorNote error={q.error} /> : !v ? <Loading rows={3} /> : <TabBody tab={tab} v={v} token={token} />}
        <p className={`mt-3 ${muted}`}>
          Build this sends a task to the factory.
        </p>
      </Section>
    </>
  );
}
