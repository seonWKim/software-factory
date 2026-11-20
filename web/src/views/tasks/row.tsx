import { useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useContext, useRef, useState } from "react";
import { API, type TaskRow, postTaskBuild } from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { FOCUS } from "../../components/ui/control.js";
import { announceStatus } from "../../components/ui/dialog.js";
import { ID_CLASS, LINK_CLASS } from "../../components/ui/link-style.js";
import { OverflowMenu } from "../../components/ui/menu.js";
import type { MessageKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";
import { localDateTime } from "../../lib/format.js";
import { Link } from "../../nav.js";
import { itemPath } from "../../pages.js";
import { WorkState } from "../task-work.js";
import { DeleteDialog, DescriptionDialog, ProjectsDialog } from "./dialogs.js";
import { RowForm } from "./forms.js";
import type { Nested } from "./groups.js";
import { ALERT, Rows, idFor, muted, useTaskAction } from "./shared.js";
import { Badge } from "../../components/ui/badge.js";

/** A linked task's item's close reason, as the row says it in its details line, open or done (design 02-tasks). */
const closedKey = (reason: NonNullable<TaskRow["close_reason"]>): MessageKey =>
  reason === "rejected" ? "tasks.closedRejected" : reason === "wont_do" ? "tasks.closedNotPlanned" : "tasks.closedOther";

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

/**
 * The title. On an open task the page can write, a button that opens the description dialog (a built task's item link
 * stays on its state and ID); else a link to the built task's item, or plain text when it is not built.
 */
function Title({ task, className, onOpen }: { task: TaskRow; className: string; onOpen: (() => void) | null }) {
  if (onOpen !== null) {
    return (
      // The title stays the paragraph's text; the shared Button lies over it, so the row keeps its height.
      <p className={cn(className, "relative hover:underline")}>
        {task.title}
        <Button
          variant="ghost"
          aria-haspopup="dialog"
          aria-label={t("tasks.descriptionLabel", { title: task.title })}
          className="absolute inset-0 min-h-0! px-0! enabled:hover:bg-transparent!"
          onClick={onOpen}
        />
      </p>
    );
  }
  const title = <p className={className}>{task.title}</p>;
  return task.work_item_id === null ? title : (
    <Link href={itemPath(task.work_item_id)} className={cn("block", LINK_CLASS)}>
      {title}
    </Link>
  );
}

export function TaskCard({ task, overdue: inOverdue = false, sub = false }: { task: TaskRow; overdue?: boolean; sub?: boolean }) {
  const { token, titles, completed } = useContext(Rows);
  const row = useRef<HTMLLIElement>(null);
  const action = useTaskAction(token);
  const done = task.done_at != null;
  // A done task is not late, wherever it is placed.
  const overdue = inOverdue && !done;
  const [mode, setMode] = useState<"view" | "edit" | "sub" | "delete" | "projects" | "description">("view");
  const [checked, setChecked] = useState(false);
  const parent = task.parent_task_id ?? null;
  const due = task.due_date === null ? null : task.due_time === null ? task.due_date : `${task.due_date} ${task.due_time}`;
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
      data-done={done ? "" : undefined}
      data-sub={sub ? "" : undefined}
      className={cn("flex flex-wrap items-start justify-between gap-x-3 gap-y-2 p-3", FOCUS, "focus-visible:-outline-offset-2", sub && "pl-10")}
    >
      {token !== null && !done && (
        <Checkbox
          checked={checked}
          aria-label={t("tasks.complete", { title: task.title })}
          disabled={action.busy}
          onChange={() => void complete()}
        />
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
          <Title
            task={task}
            className={cn("text-sm text-pretty break-words", overdue && "font-medium text-pill-bad-fg", done && "text-text-2 line-through")}
            onOpen={token !== null && !done ? () => setMode("description") : null}
          />
        )}
        <p className={cn(muted, "flex flex-wrap gap-x-3 gap-y-1")}>
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
        {action.error !== null && mode !== "delete" && mode !== "projects" && mode !== "description" && (
          <p role="alert" className={ALERT}>
            {action.error}
          </p>
        )}
      </div>
      <div className="flex items-start gap-2">
        {task.work_item_id !== null ? (
          <>
            <WorkState id={task.work_item_id} title={task.title} open={!done} />
            <Link href={itemPath(task.work_item_id)} className={cn(ID_CLASS, "text-xs break-all")}>
              {task.work_item_id}
            </Link>
          </>
        ) : (
          token !== null && !done && <BuildButton task={task} token={token} />
        )}
        {token !== null && (done ? (
          <Button variant="secondary" disabled={action.busy} aria-label={t("tasks.reopenLabel", { title: task.title })} onClick={() => void reopen()}>
            {t("tasks.reopen")}
          </Button>
        ) : (
          <OverflowMenu label={t("tasks.more", { title: task.title })} items={items} />
        ))}
      </div>
      {mode === "delete" && token !== null && <DeleteDialog task={task} token={token} returnFocusTo={row} onClose={close} />}
      {mode === "projects" && token !== null && <ProjectsDialog task={task} token={token} returnFocusTo={row} onClose={close} />}
      {mode === "description" && token !== null && <DescriptionDialog task={task} token={token} returnFocusTo={row} onClose={close} />}
    </li>
  );
}

/** One heading and its list; the rows are the page's share of the group. */
export function Group({ title, rows, overdue }: { title: string; rows: readonly Nested[]; overdue: boolean }) {
  return (
    <div className="space-y-1">
      <h3 className={cn("text-xs font-medium", overdue ? "text-pill-bad-fg" : "text-text-2")}>{title}</h3>
      <ul aria-label={title} className="divide-y divide-border rounded-control border border-border">
        {rows.map(({ row, sub }) => (
          <TaskCard key={row.id} task={row} overdue={overdue} sub={sub} />
        ))}
      </ul>
    </div>
  );
}
