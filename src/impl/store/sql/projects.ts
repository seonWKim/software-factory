// Task projects (phase 1 of 3): the store methods of ProjectStore over `controller_projects` and
// `controller_task_projects`, as SqlProjectStore, which SqlFactoryStore extends. Every write is conditional on the row's
// current state, so applying one twice changes nothing more. No task row is ever written here.

import {
  type AddTaskToProjectResult, type ArchiveProjectResult, type CreateProjectResult, type DeleteProjectResult, type NewProject, type Project,
  type ProjectStore, type RenameProjectResult, projectName,
} from "../../../core/projects.js";
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
  listProjects(which: "active" | "archived") { return listProjects(this.db, which); }
  renameProject(id: string, name: string) { return renameProject(this.db, id, name); }
  archiveProject(id: string) { return setArchived(this.db, id, this.stamp()); }
  restoreProject(id: string) { return setArchived(this.db, id, null); }
  deleteProject(id: string) { return deleteProject(this.db, id); }
  addTaskToProject(project_id: string, task_id: string) { return addTaskToProject(this.db, project_id, task_id, this.stamp()); }
  removeTaskFromProject(project_id: string, task_id: string) { return removeTaskFromProject(this.db, project_id, task_id); }
  listTaskProjects(task_id: string) { return listTaskProjects(this.db, task_id); }
}
