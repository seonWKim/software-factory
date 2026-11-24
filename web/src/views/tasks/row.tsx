import { AlignLeft, Folder, ListPlus, RotateCcw, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useContext, useRef, useState } from "react";
import { API, type TaskRow, postTaskBuild } from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { FOCUS } from "../../components/ui/control.js";
import { announceStatus } from "../../components/ui/dialog.js";
import type { MenuItem } from "../../components/ui/menu.js";
import type { MessageKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";
import { dueText, localDateTime } from "../../lib/format.js";
import { itemPath } from "../../pages.js";
import { copyCliEntry } from "../item-commands.js";
import { ItemRow, copyIdItem } from "../item-row.js";
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

/**
 * The Tasks read's fields for a task whose item was rejected (design 02-tasks-build): `reject_reason`, on an open task no
 * replacement took, and `link_note`, on a task that followed its item's replacement; null or absent otherwise.
 */
type Followed = TaskRow & { reject_reason?: string | null; link_note?: string | null };

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

export function TaskCard({ task, overdue: inOverdue = false, sub = false, date = null }: { task: TaskRow; overdue?: boolean; sub?: boolean; date?: string | null }) {
  const { token, titles, completed } = useContext(Rows);
  const row = useRef<HTMLLIElement>(null);
  const action = useTaskAction(token);
  const done = task.done_at != null;
  const { reject_reason = null, link_note = null } = task as Followed;
  // An open task whose item was rejected with no replacement says it was not built, and why, instead of `Rejected`.
  const notBuilt = done ? null : reject_reason;
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
  const unbuilt = task.work_item_id === null;
  // The row's one primary action: Build this on an open task with no work item (design 09-dashboard-tasks). A done
  // task has none: Reopen is in its menu, as is every other action, and a waiting work item's commands come first.
  // Each menu entry that acts carries `data-action` (its `factory task` verb) and `data-item` (the task's ID).
  const items: MenuItem[] = done
    ? [{ label: t("tasks.reopen"), icon: RotateCcw, action: "reopen", item: task.id, disabled: action.busy, onSelect: () => void reopen() }]
    : [
        { label: t("tasks.description"), icon: AlignLeft, onSelect: () => setMode("description") },
        ...(parent === null ? [{ label: t("tasks.addSub"), icon: ListPlus, onSelect: () => setMode("sub") }] : []),
        { label: t("tasks.projectsItem"), icon: Folder, onSelect: () => setMode("projects") },
        { label: t("tasks.delete"), icon: Trash2, shortcut: "Delete", danger: true, onSelect: () => setMode("delete") },
      ];
  const menuLabel = t("tasks.more", { title: task.title });
  const waiting = !done && waitsOnOwner(it);
  const error = builder.error ?? (mode !== "delete" && mode !== "projects" && mode !== "description" ? action.error : null);
  // Copy as CLI command on an open row (a waiting item's menu has its own, for the item's command): Build this, else
  // Complete. A done row's menu holds Reopen, then Copy ID for a built task.
  const own = done ? items : [...items, copyCliEntry(unbuilt ? "build" : "done", task.id)];
  return (
    <ItemRow
      variant="comfortable"
      ref={row}
      tabIndex={token === null ? undefined : 0}
      onKeyDown={onKey}
      itemId={task.work_item_id ?? undefined}
      data-task={task.id}
      data-key={token === null ? undefined : task.id}
      data-overdue={overdue ? "" : undefined}
      data-done={done ? "" : undefined}
      data-sub={sub ? "" : undefined}
      className={cn(FOCUS, "focus-visible:-outline-offset-2", sub && "pl-10", done && "text-text-2")}
      lead={token !== null && (done ? (
        // A done row keeps the checkbox's space, so its title lines up with the open rows' titles.
        <span data-checkbox-space aria-hidden className="min-h-8 min-w-8 shrink-0" />
      ) : (
        <Checkbox
          checked={checked}
          aria-label={t("tasks.complete", { title: task.title })}
          data-action="done"
          data-item={task.id}
          disabled={action.busy}
          onChange={() => void complete()}
        />
      ))}
      badge={(overdue || task.work_item_id !== null) && (
        <>
          {overdue && <Badge level="stuck">{t("tasks.overdue")}</Badge>}
          {task.work_item_id !== null && (
            <span data-work className="-my-1 flex flex-wrap items-center gap-2">
              <WorkState id={task.work_item_id} title={task.title} open={!done} />
            </span>
          )}
        </>
      )}
      title={task.title}
      href={task.work_item_id === null ? null : itemPath(task.work_item_id)}
      titleClassName={cn(overdue && "font-medium text-pill-bad-fg", done && "text-text-2")}
      editing={mode === "edit" && (
        <RowForm
          label={t("tasks.edit", { title: task.title })}
          initial={task.title}
          hint={t("tasks.editHint")}
          busy={action.busy}
          // The title as shown, unchanged: nothing to write.
          onSave={async (words) => words === task.title || (await action.run("edit", { id: task.id, words }))}
          onClose={close}
        />
      )}
      why={due !== null && <span className={cn("tabular-nums", overdue && "text-pill-bad-fg")}>{t("tasks.due", { due })}</span>}
      project={task.list !== null && `#${task.list}`}
      details={
        <>
          {task.done_at != null && <span className="tabular-nums">{t("tasks.doneAt", { at: localDateTime(task.done_at) })}</span>}
          {notBuilt !== null ? (
            <span data-not-built className="break-words">{t("tasks.notBuilt", { reason: notBuilt })}</span>
          ) : (
            task.close_reason != null && <span>{t(closedKey(task.close_reason))}</span>
          )}
          {!done && link_note !== null && <span data-link-note className="break-words">{link_note}</span>}
          {parent !== null && !sub && titles.has(parent) && <span className="break-words">{t("tasks.subOf", { title: titles.get(parent)! })}</span>}
          {minutes !== null && <span className="tabular-nums">{t("tasks.minutes", { minutes })}</span>}
          {task.priority !== null && <span>!{task.priority}</span>}
          {(task.projects ?? []).map((p) => (
            <span key={p} className="break-all">
              +{p}
            </span>
          ))}
          {task.recurrence !== null && <span>{t("tasks.every", { recurrence: task.recurrence })}</span>}
        </>
      }
      action={token !== null && !done && unbuilt && (
        <Button size="sm" variant="secondary" data-action="build" data-item={task.id} disabled={builder.busy} onClick={() => void builder.build()}>
          {t("tasks.build")}
        </Button>
      )}
      menu={token !== null && waiting ? <TaskItemMenu it={it} extra={[...items, ...(task.work_item_id ? [copyIdItem(task.work_item_id)] : [])]} label={menuLabel} /> : undefined}
      menuItems={token === null ? undefined : own}
      menuLabel={menuLabel}
      copyId={token === null ? undefined : (task.work_item_id ?? undefined)}
      second={error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
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
      {mode === "delete" && token !== null && <DeleteDialog task={task} token={token} returnFocusTo={row} onClose={close} />}
      {mode === "projects" && token !== null && <ProjectsDialog task={task} token={token} returnFocusTo={row} onClose={close} />}
      {mode === "description" && token !== null && <DescriptionDialog task={task} token={token} returnFocusTo={row} onClose={close} />}
    </ItemRow>
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
