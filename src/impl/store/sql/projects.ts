// Task projects (phase 1 of 3): the store methods of ProjectStore over `controller_projects` and
// `controller_task_projects`, as SqlProjectStore, which SqlFactoryStore extends. Every write is conditional on the row's
// current state, so applying one twice changes nothing more. No task row is ever written here. linkTaskProjects runs
// inside the task store's add and edit transactions (phase 2), so a refused `+slug` rolls the task write back.

import {
  type AddTaskToProjectResult, type ArchiveProjectResult, type CreateProjectResult, type DeleteProjectResult, type NewProject, type Project,
  type ProjectStore, type RenameProjectResult, projectName,
} from "../../../core/projects.js";
import { ProjectRefused } from "../../../core/tasks.js";
import type { Timestamp, UserId } from "../../../core/types.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";

const COLUMNS = "id, slug, name, created_by, created_at, archived_at";

function rowToProject(r: Row): Project {
  return {
    id: String(r.id), slug: String(r.slug), name: String(r.name), created_by: String(r.created_by) as UserId,
    created_at: String(r.created_at) as Timestamp, archived_at: r.archived_at == null ? null : (String(r.archived_at) as Timestamp),
  };
}

async function select(db: SqlExecutor, column: "id" | "slug", value: string): Promise<Project | null> {
  const [row] = await db.all(`SELECT ${COLUMNS} FROM controller_projects WHERE ${column} = ?`, [value]);
  return row ? rowToProject(row) : null;
}

/** A stored ID is answered as stored, so a resend inserts nothing; a slug another project holds refuses it. */
async function createProject(db: SqlDriver, p: NewProject, now: Timestamp): Promise<CreateProjectResult> {
  return db.transaction(async (tx) => {
    const stored = await select(tx, "id", p.id);
    if (stored !== null) return { ok: true, project: stored } as const;
    const named = projectName(p.name);
    if (!named.ok) return { ok: false, reason: "invalid_name", error: named.error } as const;
    const holder = await select(tx, "slug", named.slug);
    if (holder !== null) return { ok: false, reason: "slug_taken", project: holder } as const;
    await tx.run(`INSERT INTO controller_projects (${COLUMNS}) VALUES (?, ?, ?, ?, ?, NULL)`, [p.id, named.slug, named.name, p.created_by, now]);
    return { ok: true, project: (await select(tx, "id", p.id))! } as const;
  });
}

async function renameProject(db: SqlDriver, id: string, name: string): Promise<RenameProjectResult> {
  return db.transaction(async (tx) => {
    const project = await select(tx, "id", id);
    if (project === null) return { ok: false, reason: "not_found" } as const;
    const named = projectName(name);
    if (!named.ok) return { ok: false, reason: "invalid_name", error: named.error } as const;
    const holder = await select(tx, "slug", named.slug);
    if (holder !== null && holder.id !== id) return { ok: false, reason: "slug_taken", project: holder } as const;
    await tx.run("UPDATE controller_projects SET name = ?, slug = ? WHERE id = ?", [named.name, named.slug, id]);
    return { ok: true, project: (await select(tx, "id", id))! } as const;
  });
}

/** Archives (`at` set) or restores (`at` null), conditional on the project being in the other state. Links stay. */
async function setArchived(db: SqlDriver, id: string, at: Timestamp | null): Promise<ArchiveProjectResult> {
  return db.transaction(async (tx) => {
    if ((await select(tx, "id", id)) === null) return { ok: false, reason: "not_found" } as const;
    const changed = at === null
      ? await tx.run("UPDATE controller_projects SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL", [id])
      : await tx.run("UPDATE controller_projects SET archived_at = ? WHERE id = ? AND archived_at IS NULL", [at, id]);
    return { ok: true, project: (await select(tx, "id", id))!, changed: changed === 1 } as const;
  });
}

/** In one transaction: the project's link rows, then the project. No task row changes. */
async function deleteProject(db: SqlDriver, id: string): Promise<DeleteProjectResult> {
  return db.transaction(async (tx) => {
    const project = await select(tx, "id", id);
    if (project === null) return { ok: false, reason: "not_found" } as const;
    const linked = await tx.all("SELECT task_id FROM controller_task_projects WHERE project_id = ? ORDER BY task_id", [id]);
    await tx.run("DELETE FROM controller_task_projects WHERE project_id = ?", [id]);
    await tx.run("DELETE FROM controller_projects WHERE id = ?", [id]);
    return { ok: true, project, unlinked: linked.map((r) => String(r.task_id)) } as const;
  });
}

async function addTaskToProject(db: SqlDriver, project_id: string, task_id: string, now: Timestamp): Promise<AddTaskToProjectResult> {
  return db.transaction(async (tx) => {
    const project = await select(tx, "id", project_id);
    if (project === null) return { ok: false, reason: "project_not_found" } as const;
    if (project.archived_at !== null) return { ok: false, reason: "archived" } as const;
    if ((await tx.all("SELECT id FROM controller_tasks WHERE id = ?", [task_id])).length === 0) return { ok: false, reason: "task_not_found" } as const;
    try {
      await tx.run("INSERT INTO controller_task_projects (task_id, project_id, added_at) VALUES (?, ?, ?)", [task_id, project_id, now]);
      return { ok: true, changed: true } as const;
    } catch (err) {
      if (db.isDuplicateKey(err)) return { ok: true, changed: false } as const;
      throw err;
    }
  });
}

async function removeTaskFromProject(db: SqlDriver, project_id: string, task_id: string): Promise<boolean> {
  return (await db.run("DELETE FROM controller_task_projects WHERE project_id = ? AND task_id = ?", [project_id, task_id])) === 1;
}

/**
 * In `tx`: links the task to the project of each slug it is not linked to yet. Throws ProjectRefused for an unknown
 * or archived project, so the caller's transaction (the task's add or edit) writes nothing.
 */
export async function linkTaskProjects(tx: SqlExecutor, task_id: string, slugs: readonly string[], now: Timestamp): Promise<void> {
  for (const slug of new Set(slugs)) {
    const project = await select(tx, "slug", slug);
    if (project === null) throw new ProjectRefused(slug, "not_found");
    if (project.archived_at !== null) throw new ProjectRefused(slug, "archived");
    const linked = await tx.all("SELECT task_id FROM controller_task_projects WHERE task_id = ? AND project_id = ?", [task_id, project.id]);
    if (linked.length === 0) await tx.run("INSERT INTO controller_task_projects (task_id, project_id, added_at) VALUES (?, ?, ?)", [task_id, project.id, now]);
  }
}

/** Drops every link of the task, in `tx`: deleteTask calls it so no link outlives its task. */
export async function unlinkTask(tx: SqlExecutor, task_id: string): Promise<void> {
  await tx.run("DELETE FROM controller_task_projects WHERE task_id = ?", [task_id]);
}

function getProject(db: SqlDriver, id: string): Promise<Project | null> {
  return select(db, "id", id);
}

async function listProjects(db: SqlDriver, which: "active" | "archived"): Promise<Project[]> {
  const where = which === "active" ? "archived_at IS NULL" : "archived_at IS NOT NULL";
  return (await db.all(`SELECT ${COLUMNS} FROM controller_projects WHERE ${where} ORDER BY slug, id`)).map(rowToProject);
}

/** Each task's active projects' slugs, sorted; one read for the whole list. */
async function listTaskProjectSlugs(db: SqlDriver, task_ids: readonly string[]): Promise<Record<string, string[]>> {
  if (task_ids.length === 0) return {};
  const rows = await db.all(
    `SELECT l.task_id, p.slug FROM controller_task_projects l JOIN controller_projects p ON p.id = l.project_id
      WHERE p.archived_at IS NULL AND l.task_id IN (${task_ids.map(() => "?").join(", ")}) ORDER BY l.task_id, p.slug`,
    [...task_ids],
  );
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[String(r.task_id)] ??= []).push(String(r.slug));
  return out;
}

/**
 * Each work item's source task's active projects' slugs, sorted, read over controller_tasks.work_item_id in one query;
 * an item with no source task, or whose task is in no active project, is left out.
 */
async function listWorkItemProjectSlugs(db: SqlDriver, work_item_ids: readonly string[]): Promise<Record<string, string[]>> {
  if (work_item_ids.length === 0) return {};
  const rows = await db.all(
    `SELECT DISTINCT t.work_item_id, p.slug FROM controller_tasks t JOIN controller_task_projects l ON l.task_id = t.id
      JOIN controller_projects p ON p.id = l.project_id
      WHERE p.archived_at IS NULL AND t.work_item_id IN (${work_item_ids.map(() => "?").join(", ")}) ORDER BY t.work_item_id, p.slug`,
    [...work_item_ids],
  );
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[String(r.work_item_id)] ??= []).push(String(r.slug));
  return out;
}

async function listTaskProjects(db: SqlDriver, task_id: string): Promise<Project[]> {
  const rows = await db.all(
    `SELECT ${COLUMNS.split(", ").map((c) => `p.${c}`).join(", ")} FROM controller_projects p
      JOIN controller_task_projects l ON l.project_id = p.id WHERE l.task_id = ? AND p.archived_at IS NULL ORDER BY p.slug, p.id`,
    [task_id],
  );
  return rows.map(rowToProject);
}

/**
 * ProjectStore over a SqlDriver: the methods above bound to the store's driver and `stamp`, the store's injected Clock's
 * time. SqlFactoryStore extends it, so the task projects add no line to that file's budget.
 */
export class SqlProjectStore implements ProjectStore {
  constructor(
    readonly db: SqlDriver,
    private readonly stamp: () => Timestamp,
  ) {}

  createProject(p: NewProject) { return createProject(this.db, p, this.stamp()); }
  getProject(id: string) { return getProject(this.db, id); }
  getProjectBySlug(slug: string) { return select(this.db, "slug", slug); }
  listProjects(which: "active" | "archived") { return listProjects(this.db, which); }
  renameProject(id: string, name: string) { return renameProject(this.db, id, name); }
  archiveProject(id: string) { return setArchived(this.db, id, this.stamp()); }
  restoreProject(id: string) { return setArchived(this.db, id, null); }
  deleteProject(id: string) { return deleteProject(this.db, id); }
  addTaskToProject(project_id: string, task_id: string) { return addTaskToProject(this.db, project_id, task_id, this.stamp()); }
  removeTaskFromProject(project_id: string, task_id: string) { return removeTaskFromProject(this.db, project_id, task_id); }
  listTaskProjects(task_id: string) { return listTaskProjects(this.db, task_id); }
  listTaskProjectSlugs(task_ids: readonly string[]) { return listTaskProjectSlugs(this.db, task_ids); }
  listWorkItemProjectSlugs(work_item_ids: readonly string[]) { return listWorkItemProjectSlugs(this.db, work_item_ids); }
}
