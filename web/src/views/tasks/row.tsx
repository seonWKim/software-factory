import { useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useContext, useRef, useState } from "react";
import { API, type TaskRow, postTaskBuild } from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { FOCUS } from "../../components/ui/control.js";
import { announceStatus } from "../../components/ui/dialog.js";
import { type MenuItem, OverflowMenu } from "../../components/ui/menu.js";
import { ListRow, ROW_TITLE } from "../../components/ui/list-row.js";
import type { MessageKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";
import { dueText, localDateTime } from "../../lib/format.js";
import { Link } from "../../nav.js";
import { itemPath } from "../../pages.js";
import { TaskItemMenu, WorkState, useWorkItem, waitsOnOwner } from "../task-work.js";
import { DeleteDialog, DescriptionDialog, ProjectsDialog } from "./dialogs.js";
import { RowForm } from "./forms.js";
import type { Nested } from "./groups.js";
import { ALERT, Rows, idFor, useTaskAction } from "./shared.js";
import { Badge } from "../../components/ui/badge.js";
import { SUB_TITLE } from "../../components/ui/card.js";

/** A linked task's item's close reason, as the row says it in its details line, open or done (design 02-tasks). */
const closedKey = (reason: NonNullable<TaskRow["close_reason"]>): MessageKey =>
  reason === "rejected" ? "tasks.closedRejected" : reason === "wont_do" ? "tasks.closedNotPlanned" : "tasks.closedOther";

/** Build this, from the row's menu: one POST; its refusal shows on the row until the next try. */
function useBuild(task: TaskRow, token: string | null) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const build = async () => {
    if (token === null) return;
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
  return { build, busy, error };
}

/**
 * The title. A built task's title links to its work item's page (owner feedback 2026-11-20), quiet like a Needs you
 * row's title; its description dialog is in the row's menu. An open task that is not built opens the description
 * dialog from its title; else plain text.
 */
function Title({ task, className, onOpen }: { task: TaskRow; className: string; onOpen: (() => void) | null }) {
  if (task.work_item_id !== null) {
    return (
      <Link href={itemPath(task.work_item_id)} data-row-title title={task.title} className={cn(className, "text-text-1 hover:underline")}>
        {task.title}
      </Link>
    );
  }
  if (onOpen !== null) {
    return (
      // The title stays the paragraph's text; the shared Button lies over it, so the row keeps its height. The Button
      // reaches 4px above and below the 20px line, so it is 28px tall (responsive rules small-target, button-height);
      // it sits beside the paragraph, whose truncate would clip it.
      <div className="group relative">
        <p data-row-title title={task.title} className={cn(className, "group-hover:underline")}>
          {task.title}
        </p>
        <Button
          variant="ghost"
          aria-haspopup="dialog"
          aria-label={t("tasks.descriptionLabel", { title: task.title })}
          className="absolute inset-x-0 -inset-y-1 min-h-0! px-0! enabled:hover:bg-transparent!"
          onClick={onOpen}
        />
      </div>
    );
  }
  return <p data-row-title title={task.title} className={className}>{task.title}</p>;
}

export function TaskCard({ task, overdue: inOverdue = false, sub = false, date = null }: { task: TaskRow; overdue?: boolean; sub?: boolean; date?: string | null }) {
  const { token, titles, completed } = useContext(Rows);
  const row = useRef<HTMLLIElement>(null);
  const action = useTaskAction(token);
  const done = task.done_at != null;
  // A done task is not late, wherever it is placed.
  const overdue = inOverdue && !done;
  const [mode, setMode] = useState<"view" | "edit" | "sub" | "delete" | "projects" | "description">("view");
  const [checked, setChecked] = useState(false);
  const parent = task.parent_task_id ?? null;
  const due = dueText(task.due_date, task.due_time, date);
  // A timed task's stored duration; none stored: none shown.
  const minutes = task.due_time === null ? null : (task.duration_minutes ?? null);
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
  const reopen = async () => {
    if (await action.run("reopen", { id: task.id })) announceStatus(t("tasks.reopened", { title: task.title }));
  };
  // `e` and Delete act on an open row itself when it has focus, not on a control inside it.
  const onKey = (e: KeyboardEvent<HTMLLIElement>) => {
    if (token === null || done || e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey || mode !== "view") return;
    if (e.key === "e" || e.key === "Delete") {
      e.preventDefault();
      setMode(e.key === "e" ? "edit" : "delete");
    }
  };
  const subAttempt = useRef<{ id: string; words: string } | null>(null);
  const builder = useBuild(task, token);
  const it = useWorkItem(task.work_item_id);
  // Every action is in the row's menu (owner feedback 2026-11-20): Build this and Reopen too, and a waiting work
  // item's commands first (TaskItemMenu).
  const items: MenuItem[] = done
    ? [{ label: t("tasks.reopen"), disabled: action.busy, onSelect: () => void reopen() }]
    : [
        ...(task.work_item_id === null ? [{ label: t("tasks.build"), action: "build", disabled: builder.busy, onSelect: () => void builder.build() }] : []),
        // A built task's title goes to its work item, so its description dialog opens from here.
        ...(task.work_item_id !== null ? [{ label: t("tasks.description"), onSelect: () => setMode("description") }] : []),
        ...(parent === null ? [{ label: t("tasks.addSub"), onSelect: () => setMode("sub") }] : []),
        { label: t("tasks.projectsItem"), onSelect: () => setMode("projects") },
        { label: t("tasks.delete"), danger: true, onSelect: () => setMode("delete") },
      ];
  const menuLabel = t("tasks.more", { title: task.title });
  return (
    <ListRow
      ref={row}
      tabIndex={token === null ? undefined : 0}
      onKeyDown={onKey}
      data-task={task.id}
      data-key={token === null ? undefined : task.id}
      data-overdue={overdue ? "" : undefined}
      data-done={done ? "" : undefined}
      data-sub={sub ? "" : undefined}
      className={cn(FOCUS, "focus-visible:-outline-offset-2", sub && "pl-10")}
      leading={token !== null && (done ? (
        // A done row keeps the checkbox's space, so its title lines up with the open rows' titles.
        <span data-checkbox-space aria-hidden className="min-h-8 min-w-8 shrink-0" />
      ) : (
        <Checkbox
          checked={checked}
          aria-label={t("tasks.complete", { title: task.title })}
          disabled={action.busy}
          onChange={() => void complete()}
        />
      ))}
      title={mode === "edit" ? (
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
        <Title
          task={task}
          className={cn(ROW_TITLE, overdue && "font-medium text-pill-bad-fg", done && "text-text-2 line-through")}
          onOpen={token !== null && !done ? () => setMode("description") : null}
        />
      )}
      details={
        <>
          {overdue && <Badge level="stuck">{t("tasks.overdue")}</Badge>}
          {task.done_at != null && <span className="tabular-nums">{t("tasks.doneAt", { at: localDateTime(task.done_at) })}</span>}
          {task.close_reason != null && <span>{t(closedKey(task.close_reason))}</span>}
          {parent !== null && !sub && titles.has(parent) && <span className="break-words">{t("tasks.subOf", { title: titles.get(parent)! })}</span>}
          {due !== null && <span className={cn("tabular-nums", overdue && "text-pill-bad-fg")}>{t("tasks.due", { due })}</span>}
          {minutes !== null && <span className="tabular-nums">{t("tasks.minutes", { minutes })}</span>}
          {task.priority !== null && <span>!{task.priority}</span>}
          {task.list !== null && <span className="break-all">#{task.list}</span>}
          {(task.projects ?? []).map((p) => (
            <span key={p} className="break-all">
              +{p}
            </span>
          ))}
          {task.recurrence !== null && <span>{t("tasks.every", { recurrence: task.recurrence })}</span>}
          {task.work_item_id !== null && (
            <span data-work className="-my-1 flex flex-wrap items-center gap-2">
              <WorkState id={task.work_item_id} title={task.title} open={!done} />
            </span>
          )}
        </>
      }
      menu={token !== null && (!done && waitsOnOwner(it) ? <TaskItemMenu it={it} extra={items} label={menuLabel} /> : <OverflowMenu label={menuLabel} items={items} />)}
    >
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
      {builder.error !== null && (
        <p role="alert" className={ALERT}>
          {builder.error}
        </p>
      )}
      {action.error !== null && mode !== "delete" && mode !== "projects" && mode !== "description" && (
        <p role="alert" className={ALERT}>
          {action.error}
        </p>
      )}
      {mode === "delete" && token !== null && <DeleteDialog task={task} token={token} returnFocusTo={row} onClose={close} />}
      {mode === "projects" && token !== null && <ProjectsDialog task={task} token={token} returnFocusTo={row} onClose={close} />}
      {mode === "description" && token !== null && <DescriptionDialog task={task} token={token} returnFocusTo={row} onClose={close} />}
    </ListRow>
  );
}

/** One heading and its list; the rows are the page's share of the group. */
export function Group({ title, rows, overdue, date = null }: { title: string; rows: readonly Nested[]; overdue: boolean; date?: string | null }) {
  return (
    <div className="space-y-1">
      <h3 className={SUB_TITLE}>{title}</h3>
      <ul aria-label={title} className="divide-y divide-border rounded-control border border-border">
        {rows.map(({ row, sub }) => (
          <TaskCard key={row.id} task={row} overdue={overdue} sub={sub} date={date} />
        ))}
      </ul>
    </div>
  );
}
