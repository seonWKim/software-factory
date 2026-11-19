import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useContext, useRef, useState } from "react";
import { API, type ProjectChoice, type TaskRow, postTaskProject } from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, announceStatus } from "../../components/ui/dialog.js";
import { Field } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";
import { Rows, createProject, muted, useTaskAction } from "./shared.js";

/**
 * The delete confirm: the shared Dialog with danger set; it deletes only on confirm, and a refusal stays in it with its
 * reason. It reads the row's open sub-task count before it opens: with any, it says how many and its confirm is "Delete
 * with sub-tasks", which deletes them with the task (design 02-tasks-page), so no confirm leads to the store's refusal.
 */
export function DeleteDialog({ task, token, returnFocusTo, onClose }: { task: TaskRow; token: string; returnFocusTo: RefObject<HTMLElement | null>; onClose: () => void }) {
  const action = useTaskAction(token);
  const subs = task.open_sub_tasks ?? 0;
  const confirm = async () => {
    if (await action.run("delete", subs > 0 ? { id: task.id, with_sub_tasks: true } : { id: task.id })) {
      announceStatus(t("tasks.deleted", { title: task.title }));
      onClose();
    }
  };
  return (
    <Dialog
      danger
      title={t("tasks.deleteTitle", { title: task.title })}
      consequence={t("tasks.deleteConsequence")}
      confirmLabel={t(subs > 0 ? "tasks.deleteWithSubs" : "tasks.delete")}
      confirmDisabled={action.busy}
      error={action.error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      {subs > 0 && <p data-open-sub-tasks={subs}>{t(subs === 1 ? "tasks.deleteSubsOne" : "tasks.deleteSubsMany", { count: subs })}</p>}
    </Dialog>
  );
}

/**
 * The project dialog: the shared Dialog with a checkbox per active project (checked: the task is in it), each change
 * posted at once, and a New project field whose Create project (or Enter) creates the project under an ID kept for that
 * name, so a retry stores one project, then puts the task in it. A refusal stays in the dialog with its reason. It
 * renders into document.body, so the row keeps its height.
 */
export function ProjectsDialog({ task, token, returnFocusTo, onClose }: { task: TaskRow; token: string; returnFocusTo: RefObject<HTMLElement | null>; onClose: () => void }) {
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
      const r = await createProject(token, attempt, words);
      if (!r.ok) {
        setError(r.error);
        return false;
      }
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

/** The Add project dialog: one name field; a refusal stays in the dialog with its reason, and a created project's tab is selected. */
export function AddProjectDialog({ token, returnFocusTo, onCreated, onClose }: { token: string; returnFocusTo: RefObject<HTMLElement | null>; onCreated: (slug: string) => void; onClose: () => void }) {
  const client = useQueryClient();
  const attempt = useRef<{ id: string; words: string } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await createProject(token, attempt, name.trim());
      if (!r.ok) {
        setError(r.error);
        return;
      }
      await client.invalidateQueries({ queryKey: [API.tasks] });
      onCreated(r.project.slug);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t("tasks.addProject")}
      consequence={t("tasks.addProjectHint")}
      confirmLabel={t("tasks.createProject")}
      confirmDisabled={busy || name.trim() === ""}
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => void create()}
      onClose={onClose}
    >
      <Field label={t("tasks.projectName")} htmlFor="add-project-name">
        <Input id="add-project-name" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
      </Field>
    </Dialog>
  );
}
