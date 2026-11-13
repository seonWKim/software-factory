// The task projects' dashboard routes (design 02-tasks, task projects; 09-dashboard-app, the Tasks page's project
// dialog): POST /api/v1/projects creates a project, as `factory project create` does, under the ID the page chose (a
// resend stores nothing more), and POST /api/v1/tasks/project adds a task to a project or removes it, through the
// store's addTaskToProject and removeTaskFromProject. Both are task routes (tasks-api.ts TASK_WRITES): server.ts runs
// the request guards (Host, Origin, Content-Type, CSRF token, body size, JSON) and the commands actor's token first,
// and every refusal here comes before the store write.

import { isProjectSlug, projectName, type Project } from "../core/projects.js";
import { projectRefusal } from "../core/tasks.js";
import type { ApiResult } from "./api.js";
import type { UiDeps } from "./pages.js";

export const PROJECTS_PATH = "/api/v1/projects";
export const TASK_PROJECT_PATH = "/api/v1/tasks/project";

/** A caller-chosen project ID: `pj_` and 8 to 64 URL-safe characters (the CLI's own `pj_<random>`). */
const PROJECT_ID = /^pj_[A-Za-z0-9_-]{8,64}$/;
/** The longest task ID taken: any stored one (a chat-added task's ID is its message's). */
const MAX_TASK_ID = 200;
/** The longest project name taken before projectName cleans it. */
const MAX_RAW_NAME = 1000;

const OFF: ApiResult = { status: 503, value: { error: "Projects are off: this server is not on loopback, so it needs ui.user_id." } };
const refused = (status: 400 | 404 | 409, error: string, extra: Record<string, unknown> = {}): ApiResult => ({ status, value: { error, ...extra } });

/** The body as an object with exactly `keys`, or why it is not one. */
function fields(body: unknown, keys: readonly string[]): { ok: true; b: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !keys.includes(k));
  if (extra !== undefined) return { ok: false, error: `unknown field "${extra}"` };
  const missing = keys.find((k) => !(k in b));
  return missing === undefined ? { ok: true, b } : { ok: false, error: `missing field "${missing}"` };
}

/** A project as the page reads it. */
const shown = (p: Project) => ({ id: p.id, slug: p.slug, name: p.name, archived_at: p.archived_at });

/**
 * POST /api/v1/projects with `{ id, name }`, after the request guards: 503 with no commands actor; 400 for a body that
 * is not one or a name projectName refuses (its reason); 409 naming the project that holds the name's slug; else 200
 * with the project (the one stored under that ID on a resend, so it stores nothing more). Every refusal writes nothing.
 */
export async function writeProject(d: UiDeps, body: unknown): Promise<ApiResult> {
  const actor = d.commands?.actor ?? null;
  if (actor === null) return OFF;
  const f = fields(body, ["id", "name"]);
  if (!f.ok) return refused(400, f.error);
  const { id, name } = f.b;
  if (typeof id !== "string" || !PROJECT_ID.test(id)) return refused(400, "id must be pj_ and 8 to 64 letters, digits, - or _");
  if (typeof name !== "string" || name.length > MAX_RAW_NAME) return refused(400, `name must be a string of at most ${MAX_RAW_NAME} characters`);
  const named = projectName(name);
  if (!named.ok) return refused(400, named.error);
  // A resend under a stored ID: the store answers the stored project and writes nothing.
  const r = await d.store.createProject({ id, name, created_by: actor });
  if (r.ok) return { status: 200, value: { project: shown(r.project) } };
  if (r.reason === "invalid_name") return refused(400, r.error);
  const archived = r.project.archived_at === null ? "" : " (archived)";
  return refused(409, `project "${r.project.slug}" exists already${archived}`, { project: shown(r.project) });
}

/**
 * POST /api/v1/tasks/project with `{ id, project, add }`, after the request guards: 503 with no commands actor; 400 for a
 * body that is not one or a `project` that is not a slug as projectSlug makes one; 404 for an unknown task or project;
 * 400 with the archived reason when `add` names an archived project; else 200 with `{ task_id, project, changed }`,
 * `changed` false when the task was in that state already. Every refusal writes nothing.
 */
export async function writeTaskProject(d: UiDeps, body: unknown): Promise<ApiResult> {
  if ((d.commands?.actor ?? null) === null) return OFF;
  const f = fields(body, ["id", "project", "add"]);
  if (!f.ok) return refused(400, f.error);
  const { id, project: slug, add } = f.b;
  if (typeof id !== "string" || id === "" || id.length > MAX_TASK_ID) return refused(400, `id must be a task ID of at most ${MAX_TASK_ID} characters`);
  if (typeof slug !== "string" || !isProjectSlug(slug)) return refused(400, "project must be a project slug, e.g. home-repairs");
  if (typeof add !== "boolean") return refused(400, "add must be true or false");
  const project = await d.store.getProjectBySlug(slug);
  const noProject = refused(404, projectRefusal(slug, "not_found"));
  if (project === null) return noProject;
  const noTask = refused(404, `no task ${id}: it was deleted, or the page is out of date; reload it`);
  if ((await d.store.getTask(id)) === null) return noTask;
  const archived = refused(400, projectRefusal(slug, "archived"));
  if (add && project.archived_at !== null) return archived;
  let changed: boolean;
  if (add) {
    // A refusal here is a race with another worker: the store checked again inside its transaction and wrote nothing.
    const r = await d.store.addTaskToProject(project.id, id);
    if (!r.ok) return r.reason === "archived" ? archived : r.reason === "task_not_found" ? noTask : noProject;
    changed = r.changed;
  } else {
    changed = await d.store.removeTaskFromProject(project.id, id);
  }
  return { status: 200, value: { task_id: id, project: project.slug, changed } };
}
