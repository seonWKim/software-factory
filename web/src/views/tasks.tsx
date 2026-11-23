import { CalendarCheck } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { API, type ItemRow, type ProjectChoice, type TaskRow, type TasksView, postTaskAction, useItems, useTasks } from "../api.js";
import { Button } from "../components/ui/button.js";
import { announceStatus } from "../components/ui/dialog.js";
import { EmptyState, PageHeader, PageToolbar } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { Pagination } from "../components/ui/pagination.js";
import { Tabs } from "../components/ui/tabs.js";
import { useUrlParam } from "../lib/url-param.js";
import { t } from "../i18n/index.js";
import { type QuickAddKey, isUndo } from "../keys.js";
import { NeedsYou } from "./task-work.js";
import { needGroup, needsYou } from "./common.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { shortSource } from "../lib/format.js";
import { ProjectFiles } from "./project-files.js";
import { AddProjectDialog, DeleteProjectDialog } from "./tasks/dialogs.js";
import { QuickAdd } from "./tasks/forms.js";
import { PAGE_SIZE, groupsOf, hasTasks, pageOf } from "./tasks/groups.js";
import { Group } from "./tasks/row.js";
import { ALERT, Rows, muted } from "./tasks/shared.js";
import { Card } from "../components/ui/card.js";
import { Disclosure } from "../components/ui/disclosure.js";

// The Tasks page (design 02-tasks and 09-dashboard-app, issue #607): the owner's plain tasks, read through GET
// /api/v1/tasks, as one list with no view tabs (design 02-tasks, one list): every task in the groups overdue (in red),
// today, each later day by date, and no date, in that order, 20 rows to a page (the shared Pagination, paged here from the one
// read). Page 1 holds the overdue and today groups, so the list opens on today.
// A done task of the last 30 days (design 02-tasks, done tasks stay) sits in the Done group below the list, closed on load
// (design 02-tasks-page, 2026-11-22): its title struck through and muted, its done time, its linked item's close reason when the item closed without a merge, and only Reopen (the same route as ⌘Z); no checkbox, edit, sub-task, projects, delete or Build this.
// The server places overdue and today and orders each day; the page only compares ISO date text. Calendar events are not shown here: the Calendar page (views/
// calendar.tsx) lists them, with the stale-sync notice. Build this sends a task to intake once (POST /api/v1/tasks/build); a
// built task links to its work item instead. One list of cards at every width, so no table turns into cards.
// Each row's actions (design 02-tasks) post to the route that calls the CLI command's store method: the checkbox
// completes it, `e` or Edit edits it in place (Enter saves, Esc cancels), and its overflow menu adds a sub-task (top-level
// rows only) or deletes it through the danger Dialog. A sub-task shows indented under its parent, one level.
// ⌘Z outside a field undoes the last completion this page made (POST /api/v1/tasks/reopen, `factory task reopen`), then
// the one before it: the page keeps the completed tasks in memory only, so a reload forgets them, and it never undoes an
// edit or a delete.
// The project tabs (design 09-dashboard-app, task projects) filter the list to one active
// task project's tasks, open and done (GET /api/v1/tasks?project=<slug>); its choice is the page's `project` query parameter, read on
// load and set on change, so a filtered view can be shared and reloaded. Needs you
// follows it too (GET /api/v1/items?project=<slug>): only the work items built from that project's tasks. Each open row's overflow
// item Projects… opens the project dialog: a checkbox per active project adds or removes the task's link (POST
// /api/v1/tasks/project) and New project creates one (POST /api/v1/projects) and puts the task in it. A selected
// project's "⋯" menu, after the tabs, holds Delete: the danger Dialog names the project and its task count (from the
// loaded read) and says the tasks are kept; confirm posts POST /api/v1/projects/delete (`factory project delete`), the
// tab goes at once and the filter falls back to All projects (design 09-dashboard-tasks).
// On a project tab the row ends with Files (design 09-dashboard-tasks, the Files tab), a pressed-state Button in the row's
// action slot kept in `?view=files` beside `?project=`: it shows that project's folder tree and editor (project-files.tsx)
// in place of Needs you, Quick add and the list; pressing it again, or choosing any project tab, goes back to the tasks.
// The page's order (design 09-dashboard-app): the project tabs, Needs you, Merged without you, Worth sampling, Quick add, the list; the blocks
// are spaced by one flex gap, the Section gap of design-system/patterns.md.

/**
 * The one paginated list of open tasks; page 1 opens on the overdue and today groups. The Done group sits below it,
 * closed on load: its rows (and their Reopen) are drawn only once it is opened (design 02-tasks-page, 2026-11-22).
 */
function OpenTasks({ v }: { v: TasksView }) {
  const [wanted, setPage] = useState(1);
  const all = groupsOf(v);
  const groups = all.filter((g) => g.key !== "done");
  const done = all.find((g) => g.key === "done");
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // A reload can leave fewer pages than the one on view.
  const page = Math.min(wanted, pages);
  return (
    <div className="space-y-3">
      {total === 0 && <EmptyState icon={CalendarCheck} title={t("tasks.emptyAll")} />}
      {pageOf(groups, page).map((g) => <Group key={g.key} title={g.title} rows={g.rows} overdue={g.overdue} date={g.date} />)}
      <Pagination page={page} pages={pages} onChange={setPage} />
      {done && (
        <Disclosure lazy data-done-group summary={t("tasks.doneCount", { count: done.rows.length })}>
          <div className="mt-2">
            <Group title={done.title} rows={done.rows} overdue={false} />
          </div>
        </Disclosure>
      )}
    </div>
  );
}

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

/** An item's name in a sentence: its title, else its short source number. */
const itemName = (it: Pick<ItemRow, "title" | "source">): string => it.title ?? shortSource(it.source.id);

/**
 * Needs you's overlap note (design 09-dashboard-tasks): each ready-to-merge row whose stored changed files share an exact
 * path with another ready-to-merge item (the items API's `overlaps`) names the first shared path and the other item. Read
 * from the same items read as Needs you, so it follows the project tabs; nothing when no ready item overlaps.
 */
function OverlapNotes({ project, linked }: { project: string | null; linked: ReadonlySet<string> | null }) {
  const rows = needsYou(useItems(project).data?.items ?? []).filter((it) => needGroup(it) === "merge" && (it.overlaps?.length ?? 0) > 0);
  if (linked === null || rows.length === 0) return null;
  return (
    <Card title={t("tasks.overlaps")}>
      <ul aria-label={t("tasks.overlaps")} className="space-y-1 text-sm">
        {rows.flatMap((it) => it.overlaps!.map((o) => {
          const vars = { item: itemName(it), other: o.title ?? shortSource(o.source_id), path: o.paths[0] ?? "", count: o.paths.length };
          return (
            <li key={`${it.id}:${o.id}`} data-overlap={it.id} className="text-pretty break-words">
              <Link href={itemPath(it.id)} className={LINK_CLASS}>{t(o.paths.length > 1 ? "tasks.overlapMore" : "tasks.overlap", vars)}</Link>
            </li>
          );
        }))}
      </ul>
    </Card>
  );
}

/** The project tab's choice (the `project` query parameter): null for All projects. */
const useProjectParam = (): [string | null, (slug: string | null) => void] => useUrlParam("project");

/** The project tabs: All projects (id ""), then the active projects; a slug the URL names that is not among them stays listed by its slug. */
function ProjectTabs({ projects, value, onChange, action }: { projects: readonly ProjectChoice[]; value: string | null; onChange: (slug: string | null) => void; action: ReactNode }) {
  const choices = value === null || projects.some((p) => p.slug === value) ? projects : [...projects, { slug: value, name: `+${value}` }];
  const options = [{ id: "", label: t("tasks.allProjects") }, ...choices.map((p) => ({ id: p.slug, label: p.name }))];
  return <Tabs label={t("tasks.project")} options={options} value={value ?? ""} onChange={(id) => onChange(id === "" ? null : id)} action={action} />;
}

export function TasksPage() {
  const [project, setProject] = useProjectParam();
  const [view, setView] = useUrlParam("view", (v) => v === "files");
  const files = view !== null && project !== null;
  const chooseProject = (slug: string | null) => {
    setView(null);
    setProject(slug);
  };
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ProjectChoice | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const q = useTasks<TasksView & { add_key?: QuickAddKey }>(project);
  const v = q.data;
  const token = v?.can_build ? v.csrf_token : null;
  const undo = useUndoDone(token);
  // `projects` holds every task the read returned, so its titles name each sub-task's parent.
  const titles = new Map(v?.projects.flatMap((p) => p.tasks.map((x) => [x.id, x.title] as const)) ?? []);
  // The items of the open tasks: each shows its need on its own row, so Needs you leaves it out. Null while the read loads.
  const linked = v ? new Set(v.projects.flatMap((p) => p.tasks.flatMap((x) => (x.work_item_id !== null && x.done_at == null ? [x.work_item_id] : [])))) : q.isError ? new Set<string>() : null;
  // Kept from the last read, so the tabs keep their choices while a new filter loads.
  const known = useRef<readonly ProjectChoice[]>([]);
  if (v?.active_projects !== undefined) known.current = v.active_projects;
  const selected = known.current.find((p) => p.slug === project) ?? null;
  // The selected project's tasks, open or done, as the filtered read holds them: each task once.
  const held = selected === null || !v ? 0 : new Set(v.projects.flatMap((g) => g.tasks.filter((x) => x.projects?.includes(selected.slug) ?? true).map((x) => x.id))).size;
  return (
    <>
    <PageHeader title={t("page.tasks")} description={t("tasks.pageDescription")} />
    <PageToolbar
      tabs={
        <ProjectTabs
          projects={known.current}
          value={project}
          onChange={chooseProject}
          action={
            <>
              <Button ref={addButton} variant="ghost" size="icon" aria-label={t("tasks.addProject")} disabled={token === null} onClick={() => setAdding(true)}>
                +
              </Button>
              {selected !== null && token !== null && (
                <OverflowMenu label={t("tasks.projectMore", { name: selected.name })} items={[{ label: t("tasks.delete"), danger: true, onSelect: () => setDeleting(selected) }]} />
              )}
              {project !== null && (
                <Button variant="ghost" size="sm" aria-pressed={files} className="ml-auto" onClick={() => setView(files ? null : "files")}>
                  {t("tasks.files")}
                </Button>
              )}
            </>
          }
        />
      }
    />
    {adding && token !== null && <AddProjectDialog token={token} returnFocusTo={addButton} onCreated={chooseProject} onClose={() => setAdding(false)} />}
    {deleting !== null && token !== null && (
      <DeleteProjectDialog
        project={deleting}
        tasks={held}
        token={token}
        returnFocusTo={addButton}
        onDeleted={() => {
          known.current = known.current.filter((p) => p.slug !== deleting.slug);
          if (project === deleting.slug) chooseProject(null);
        }}
        onClose={() => setDeleting(null)}
      />
    )}
    <div className="flex flex-col gap-6">
      {files ? (
        !v ? <Loading rows={3} label="loading.tasks" onRetry={() => void q.refetch()} /> : <ProjectFiles project={project} name={selected?.name ?? `+${project}`} token={v.csrf_token} canWrite={v.can_build} />
      ) : (
      <>
      <div>
        <NeedsYou project={project} linked={linked} />
        <OverlapNotes project={project} linked={linked} />
      </div>
      <div className="space-y-1">
        <QuickAdd token={v?.csrf_token ?? null} addKey={v?.add_key ?? "enter"} project={project} />
        {undo.error !== null && (
          <p role="alert" className={ALERT}>
            {undo.error}
          </p>
        )}
      </div>
      <div>
        <Card label={t("tasks.listLabel")}>
          <div className="space-y-3">
            {q.isError ? <ErrorNote error={q.error} /> : !v ? <Loading rows={3} label="loading.tasks" onRetry={() => void q.refetch()} /> : <Rows.Provider value={{ token, titles, projects: known.current, completed: undo.completed }}>
                <OpenTasks key={project ?? ""} v={v} />
              </Rows.Provider>}
            {v?.can_build && hasTasks(v) && <p className={muted}>{t("tasks.buildNote")}</p>}
          </div>
        </Card>
      </div>
      </>
      )}
    </div>
    </>
  );
}
