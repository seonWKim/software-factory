import type { Timestamp, UserId } from "./types.js";

/**
 * Task projects (phase 1 of 3): a named group the owner puts plain tasks in, stored in `controller_projects`, a task's
 * membership in `controller_task_projects`. Not a repository: `src/core/project.ts` is the repository key. A task may
 * be in several projects. Archive hides a project and keeps its links; delete removes it and its links, never a task.
 */

/** The longest project name, in characters, once projectName has cleaned it. */
export const MAX_PROJECT_NAME = 80;
/** The longest slug, in characters. */
export const MAX_PROJECT_SLUG = 40;

export interface Project {
  id: string;
  /** projectSlug of the name; unique across active and archived projects. */
  slug: string;
  name: string;
  /** A user ID, never a display name. */
  created_by: UserId;
  created_at: Timestamp;
  /** When it was archived; null while it is active. */
  archived_at: Timestamp | null;
}

export interface NewProject {
  /** Chosen by the caller, so a repeated create (a retry, a redelivered message) stores nothing more. */
  id: string;
  /** As typed; projectName cleans it. */
  name: string;
  created_by: UserId;
}

export type ProjectNameResult = { ok: true; name: string; slug: string } | { ok: false; error: string };

/** `project`: the one holding the slug. */
type SlugTaken = { ok: false; reason: "slug_taken"; project: Project };
type InvalidName = { ok: false; reason: "invalid_name"; error: string };

export type CreateProjectResult = { ok: true; project: Project } | InvalidName | SlugTaken;
export type RenameProjectResult = { ok: true; project: Project } | { ok: false; reason: "not_found" } | InvalidName | SlugTaken;
/** `changed`: false when it was in that state already (nothing written). */
export type ArchiveProjectResult = { ok: true; project: Project; changed: boolean } | { ok: false; reason: "not_found" };
/** `unlinked`: the IDs of the tasks that were in it, now in it no more; the tasks themselves are untouched. */
export type DeleteProjectResult = { ok: true; project: Project; unlinked: string[] } | { ok: false; reason: "not_found" };
/** `changed`: false when the task was in it already (nothing written). */
export type AddTaskToProjectResult = { ok: true; changed: boolean } | { ok: false; reason: "project_not_found" | "task_not_found" | "archived" };

/** The store's project methods, part of FactoryStore (through TaskStore); implemented once in the shared SQL store. */
export interface ProjectStore {
  /** Inserts the project unless its ID is stored (then returns the stored row); refused on a bad name or a taken slug. */
  createProject(p: NewProject): Promise<CreateProjectResult>;
  getProject(id: string): Promise<Project | null>;
  /** Active or archived projects, by slug. Read-only. */
  listProjects(which: "active" | "archived"): Promise<Project[]>;
  /** Sets the name and its slug; refused on a bad name or a slug another project holds. */
  renameProject(id: string, name: string): Promise<RenameProjectResult>;
  /** Sets archived_at, conditional on it being unset. Links stay. */
  archiveProject(id: string): Promise<ArchiveProjectResult>;
  /** Clears archived_at, conditional on it being set. */
  restoreProject(id: string): Promise<ArchiveProjectResult>;
  /** Deletes the project and its link rows in one transaction; no task row changes. */
  deleteProject(id: string): Promise<DeleteProjectResult>;
  /** Links the task, unless linked; refused for an unknown task or project, or an archived project. */
  addTaskToProject(project_id: string, task_id: string): Promise<AddTaskToProjectResult>;
  /** Unlinks the task; false when it was not linked. */
  removeTaskFromProject(project_id: string, task_id: string): Promise<boolean>;
  /** The task's active projects, by slug. Read-only. */
  listTaskProjects(task_id: string): Promise<Project[]>;
}

/** `name` trimmed with runs of whitespace as one space, its slug, or why it is refused (a tab is whitespace). Pure. */
export function projectName(raw: string): ProjectNameResult {
  if (typeof raw !== "string") return { ok: false, error: "a project name must be text" };
  // A control character other than a tab, a line break among them.
  if (/\p{Cc}/u.test(raw.replace(/\t/g, ""))) return { ok: false, error: "a project name must be one line with no control characters" };
  const name = raw.trim().replace(/\s+/g, " ");
  if (name === "") return { ok: false, error: "a project name must not be empty" };
  if ([...name].length > MAX_PROJECT_NAME) return { ok: false, error: `a project name must be at most ${MAX_PROJECT_NAME} characters` };
  const slug = projectSlug(name);
  if (slug === null) return { ok: false, error: "a project name needs at least one letter or digit" };
  return { ok: true, name, slug };
}

/**
 * The slug of `name`: lowercase, accents dropped, each run of characters that are not a letter or digit (of any
 * script) one dash, no dash at either end, at most MAX_PROJECT_SLUG characters; null when no letter or digit is left. Pure.
 */
export function projectSlug(name: string): string | null {
  const words = name.normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFC").toLowerCase();
  const dashed = words.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  const slug = [...dashed].slice(0, MAX_PROJECT_SLUG).join("").replace(/-+$/, "");
  return slug === "" ? null : slug;
}

/** Whether `s` is a slug as projectSlug makes one. Pure. */
export const isProjectSlug = (s: string): boolean => s !== "" && projectSlug(s) === s;
