// Project files (design 02-tasks, project files; 09-dashboard-tasks, the Files tab): a task project's base folder, its
// tree one level at a time, and one file's text, read and written only inside that folder. Four POST routes, all run
// behind server.ts's write guards in the task routes' order (Host, Origin, Content-Type, the page's CSRF token, body size,
// JSON), reads too, as the plugins import read is: POST /api/v1/projects/folder sets the folder, /api/v1/projects/files/tree
// lists one folder, /api/v1/projects/files/read reads one file and /api/v1/projects/files/write saves one. The set and the
// save also need the commands actor (503 without it).
//
// The path guard: a path is relative, `/`-separated, with no empty, `.` or `..` segment and no hidden name; it is joined to
// the folder and resolved with realpath, and refused unless the real path is the folder's own real path or under it and
// holds no hidden name either, so a symlink inside the folder that points outside (or at .git) is refused before any read
// or write. Hidden names, skipped in the tree and refused as paths: every name starting with a dot (.git, .env*), node_modules
// and key files (decision 2 of the spec). Files over MAX_EDIT_BYTES and files that are not UTF-8 text open read-only; a save
// to one is refused. No create, rename or delete: a save writes an existing file only.

import { open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { isProjectSlug, type Project } from "../core/projects.js";
import { projectRefusal } from "../core/tasks.js";
import type { ApiResult } from "./api.js";
import type { UiDeps } from "./deps.js";

export const PROJECT_FOLDER_PATH = "/api/v1/projects/folder";
export const PROJECT_TREE_PATH = "/api/v1/projects/files/tree";
export const PROJECT_FILE_READ_PATH = "/api/v1/projects/files/read";
export const PROJECT_FILE_WRITE_PATH = "/api/v1/projects/files/write";

// The project routes' shared answers, here so that projects-api.ts (a feature of this engine) imports them, not the reverse.
export const OFF: ApiResult = { status: 503, value: { error: "Projects are off: this server is not on loopback, so it needs ui.user_id." } };
export const refused = (status: 400 | 404 | 409 | 413, error: string, extra: Record<string, unknown> = {}): ApiResult => ({ status, value: { error, ...extra } });

/** The body as an object with exactly `keys`, or why it is not one. */
export function fields(body: unknown, keys: readonly string[]): { ok: true; b: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !keys.includes(k));
  if (extra !== undefined) return { ok: false, error: `unknown field "${extra}"` };
  const missing = keys.find((k) => !(k in b));
  return missing === undefined ? { ok: true, b } : { ok: false, error: `missing field "${missing}"` };
}

/** The largest file the editor edits (about 1 MB); a larger one opens read-only, its first MAX_EDIT_BYTES shown. */
export const MAX_EDIT_BYTES = 1024 * 1024;
/** The largest save body read: a 1 MB text JSON-escaped, with room for quotes and backslashes. */
export const MAX_FILE_BODY = 4 * MAX_EDIT_BYTES;
/** The longest path or folder taken. */
const MAX_PATH = 4096;
/** The bytes looked at for a NUL, the binary sign. */
const SNIFF_BYTES = 8000;

/** Key files: never listed, read or written (decision 2: hide .env* and key files; .env* is hidden as a dot name). */
const KEY_FILE = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.+\.(pem|key|p12|pfx|jks|keystore))$/i;

/** Whether a file or folder name is skipped in the tree and refused in a path. */
export const isHiddenName = (name: string): boolean => name.startsWith(".") || name === "node_modules" || KEY_FILE.test(name);

export interface FileEntry {
  name: string;
  kind: "dir" | "file";
}

/** Why a file opens read-only: over MAX_EDIT_BYTES, or not UTF-8 text. */
export type ReadOnlyReason = "large" | "binary";

export interface FileText {
  /** The text (a large file's first MAX_EDIT_BYTES); null for a binary file. */
  text: string | null;
  size: number;
  read_only: ReadOnlyReason | null;
}

type Refusal = { ok: false; status: 400 | 404 | 409 | 413; error: string };
type Done<T> = { ok: true; value: T } | Refusal;

const no = (status: Refusal["status"], error: string): Refusal => ({ ok: false, status, error });
const LEAVES = no(400, "the path leaves the base folder");
const BAD_PATH = no(400, "path must be a relative path inside the base folder, with no .., empty or hidden part");

/** A relative path's segments ([] for the folder itself), or null for an absolute path, `..`, `.`, an empty or hidden part. */
export function pathSegments(raw: unknown): string[] | null {
  if (typeof raw !== "string" || raw.length > MAX_PATH || raw.includes("\0") || raw.includes("\\")) return null;
  if (raw === "") return [];
  if (isAbsolute(raw)) return null;
  const parts = raw.split("/");
  return parts.some((p) => p === "" || p === "." || p === ".." || isHiddenName(p)) ? null : parts;
}

/** An fs error as a refusal: a missing path is 404, anything else 409 with its code. */
function fsRefusal(err: unknown): Refusal {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return no(404, "no such file or folder in the base folder");
  return no(409, `the file system refused it (${code ?? "error"})`);
}

/**
 * The real path of `parts` under the folder, when it stays inside: the folder's real path must still be `base` (the
 * stored real path), and the target's real path must be it or under it with no hidden name. Throws an fs error for a
 * missing path. Reads nothing but the names on the way.
 */
async function inside(base: string, parts: readonly string[]): Promise<Done<string>> {
  const root = await realpath(base);
  if (root !== base) return no(409, "the base folder moved or is now a link; set it again");
  const real = await realpath(join(root, ...parts));
  if (real !== root && !real.startsWith(root + sep)) return LEAVES;
  const rel = relative(root, real);
  if (rel !== "" && rel.split(sep).some(isHiddenName)) return LEAVES;
  return { ok: true, value: real };
}

/** One folder's entries, folders first, then files, each by name; hidden names, links out and other kinds left out. */
export async function listFolder(base: string, parts: readonly string[]): Promise<Done<FileEntry[]>> {
  try {
    const dir = await inside(base, parts);
    if (!dir.ok) return dir;
    if (!(await stat(dir.value)).isDirectory()) return no(400, "path is not a folder");
    const entries: FileEntry[] = [];
    for (const d of await readdir(dir.value, { withFileTypes: true })) {
      if (isHiddenName(d.name)) continue;
      let kind: FileEntry["kind"] | null = d.isDirectory() ? "dir" : d.isFile() ? "file" : null;
      if (d.isSymbolicLink()) {
        // Listed only when it resolves inside the folder, as what it points at.
        const target = await inside(base, [...parts, d.name]).catch(() => null);
        const s = target?.ok ? await stat(target.value).catch(() => null) : null;
        kind = s?.isDirectory() ? "dir" : s?.isFile() ? "file" : null;
      }
      if (kind !== null) entries.push({ name: d.name, kind });
    }
    return { ok: true, value: entries.sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
  } catch (err) {
    return fsRefusal(err);
  }
}

/** UTF-8 text, or null when the bytes hold a NUL in their first SNIFF_BYTES or are not UTF-8 (cut at the end allowed when `cut`). */
function asText(bytes: Uint8Array, cut: boolean): string | null {
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: cut });
  } catch {
    return null;
  }
}

/** A regular file's real path and size, inside the folder. */
async function regularFile(base: string, parts: readonly string[]): Promise<Done<{ real: string; size: number }>> {
  if (parts.length === 0) return no(400, "path must name a file");
  const file = await inside(base, parts);
  if (!file.ok) return file;
  const s = await stat(file.value);
  if (!s.isFile()) return no(400, "path is not a file");
  return { ok: true, value: { real: file.value, size: s.size } };
}

/** One file's text: read-only when larger than MAX_EDIT_BYTES (its first MAX_EDIT_BYTES) or binary (no text). */
export async function readProjectFile(base: string, parts: readonly string[]): Promise<Done<FileText>> {
  try {
    const file = await regularFile(base, parts);
    if (!file.ok) return file;
    const { real, size } = file.value;
    const large = size > MAX_EDIT_BYTES;
    const handle = await open(real, "r");
    let bytes: Uint8Array;
    try {
      const buf = Buffer.alloc(Math.min(size, MAX_EDIT_BYTES));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      bytes = buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const text = asText(bytes, large);
    return { ok: true, value: { text, size, read_only: text === null ? "binary" : large ? "large" : null } };
  } catch (err) {
    return fsRefusal(err);
  }
}

/** Writes `text` over an existing editable file; refused for a large or binary file and a text over MAX_EDIT_BYTES. */
export async function writeProjectFile(base: string, parts: readonly string[], text: string): Promise<Done<{ size: number }>> {
  const size = Buffer.byteLength(text, "utf8");
  if (size > MAX_EDIT_BYTES) return no(413, `the text is larger than ${MAX_EDIT_BYTES} bytes`);
  try {
    const file = await regularFile(base, parts);
    if (!file.ok) return file;
    if (file.value.size > MAX_EDIT_BYTES) return no(409, "the file is larger than about 1 MB, so it is read-only");
    if (asText(await readFile(file.value.real), false) === null) return no(409, "the file is binary, so it is read-only");
    await writeFile(file.value.real, text, "utf8");
    return { ok: true, value: { size } };
  } catch (err) {
    return fsRefusal(err);
  }
}

/** A refusal as the route's answer. */
const answer = <T>(r: Done<T>, ok: (v: T) => unknown): ApiResult => (r.ok ? { status: 200, value: ok(r.value) } : refused(r.status, r.error));

/** The active project of a slug, or the refusal: 400 for a value that is not a slug or an archived project, 404 for an unknown one. */
async function activeProject(d: UiDeps, slug: unknown): Promise<Done<Project>> {
  if (typeof slug !== "string" || !isProjectSlug(slug)) return no(400, "project must be a project slug, e.g. home-repairs");
  const p = await d.store.getProjectBySlug(slug);
  if (p === null) return no(404, projectRefusal(slug, "not_found"));
  if (p.archived_at !== null) return no(400, projectRefusal(slug, "archived"));
  return { ok: true, value: p };
}

/** The body's `keys`, the active project and the path's segments, or the refusal; none of it reads a file. */
async function target(d: UiDeps, body: unknown, keys: readonly string[]): Promise<Done<{ b: Record<string, unknown>; project: Project; parts: string[] }>> {
  const f = fields(body, keys);
  if (!f.ok) return no(400, f.error);
  const project = await activeProject(d, f.b.project);
  if (!project.ok) return project;
  const parts = pathSegments(f.b.path);
  return parts === null ? BAD_PATH : { ok: true, value: { b: f.b, project: project.value, parts } };
}

const NO_FOLDER = no(409, "this project has no base folder; set one first");

/**
 * POST /api/v1/projects/files/tree with `{ project, path }` ("" for the folder itself): `{ folder, path, entries }`. A
 * project with no base folder answers `{ folder: null, path, entries: [] }` and reads nothing.
 */
export async function readProjectTree(d: UiDeps, body: unknown): Promise<ApiResult> {
  const t = await target(d, body, ["project", "path"]);
  if (!t.ok) return refused(t.status, t.error);
  const folder = t.value.project.base_folder;
  const path = t.value.parts.join("/");
  if (folder === null) return { status: 200, value: { folder: null, path, entries: [] } };
  return answer(await listFolder(folder, t.value.parts), (entries) => ({ folder, path, entries }));
}

/** POST /api/v1/projects/files/read with `{ project, path }`: `{ path, text, size, read_only }`. */
export async function readProjectFileRoute(d: UiDeps, body: unknown): Promise<ApiResult> {
  const t = await target(d, body, ["project", "path"]);
  if (!t.ok) return refused(t.status, t.error);
  const folder = t.value.project.base_folder;
  if (folder === null) return refused(NO_FOLDER.status, NO_FOLDER.error);
  const path = t.value.parts.join("/");
  return answer(await readProjectFile(folder, t.value.parts), (f) => ({ path, ...f }));
}

/** POST /api/v1/projects/files/write with `{ project, path, text }`: 503 with no commands actor; else `{ path, size }`. */
export async function writeProjectFileRoute(d: UiDeps, body: unknown): Promise<ApiResult> {
  if ((d.commands?.actor ?? null) === null) return OFF;
  const t = await target(d, body, ["project", "path", "text"]);
  if (!t.ok) return refused(t.status, t.error);
  if (typeof t.value.b.text !== "string") return refused(400, "text must be a string");
  const folder = t.value.project.base_folder;
  if (folder === null) return refused(NO_FOLDER.status, NO_FOLDER.error);
  const path = t.value.parts.join("/");
  return answer(await writeProjectFile(folder, t.value.parts, t.value.b.text), (w) => ({ path, ...w }));
}

/**
 * POST /api/v1/projects/folder with `{ project, folder }`: 503 with no commands actor; 400 for a folder that is not an
 * absolute path to an existing directory; the project refusals; else the resolved real path is stored and answered as
 * `{ project, folder }`. Every refusal stores nothing.
 */
export async function writeProjectFolder(d: UiDeps, body: unknown): Promise<ApiResult> {
  if ((d.commands?.actor ?? null) === null) return OFF;
  const f = fields(body, ["project", "folder"]);
  if (!f.ok) return refused(400, f.error);
  const { folder } = f.b;
  const project = await activeProject(d, f.b.project);
  if (!project.ok) return refused(project.status, project.error);
  if (typeof folder !== "string" || folder.length > MAX_PATH || folder.includes("\0") || !isAbsolute(folder)) return refused(400, "folder must be an absolute path");
  let real: string;
  try {
    real = await realpath(folder);
    if (!(await stat(real)).isDirectory()) return refused(400, "folder must be an existing folder, not a file");
  } catch {
    return refused(400, `no folder at ${folder}`);
  }
  // A refusal here is a race with another worker (deleted or archived since the read): nothing was written.
  const r = await d.store.setProjectFolder(project.value.id, real);
  if (!r.ok) return refused(r.reason === "archived" ? 400 : 404, projectRefusal(project.value.slug, r.reason));
  return { status: 200, value: { project: r.project.slug, folder: r.project.base_folder } };
}

/** The four routes by path; `write` ones refresh the snapshots after a success, as every write route does. */
export const PROJECT_FILE_ROUTES: Readonly<Record<string, { write: boolean; run: (d: UiDeps, body: unknown) => Promise<ApiResult> }>> = {
  [PROJECT_FOLDER_PATH]: { write: true, run: writeProjectFolder },
  [PROJECT_TREE_PATH]: { write: false, run: readProjectTree },
  [PROJECT_FILE_READ_PATH]: { write: false, run: readProjectFileRoute },
  [PROJECT_FILE_WRITE_PATH]: { write: true, run: writeProjectFileRoute },
};
