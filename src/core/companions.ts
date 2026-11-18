// Path companions (design 04-triage.md, issue #224): files a change to a path also needs, such as a
// migration step beside a schema change, or a design topic file beside its index. Triage names the files it
// expects to change; the controller adds each companion to `allowed_paths` before the answer is checked, so a
// path limit never stops the implementer halfway.

import { isGatePath } from "./improver.js";
import { floorTier, isCovered } from "./policy.js";
import type { Floor } from "./settings.js";

/** One `path_companions` entry of factory.config.json: when `files_to_change` names `when`, also allow `also`. */
export interface PathCompanion {
  /** A repo-relative path; one ending in `/` names a folder. */
  when: string;
  /** Repo-relative paths added to `allowed_paths`, at least one; a path ending in `/` names a folder. */
  also: string[];
}

/** A path the companion step added to `allowed_paths`, and the path that caused it. */
export interface AddedPath {
  path: string;
  because: string;
}

/** The keys a `path_companions` entry may have. */
export const PATH_COMPANION_KEYS = ["when", "also"] as const;

/**
 * The doc indexes and their topic folders. An answer that names an index in `files_to_change` or
 * `allowed_paths` also gets the folder, since the change edits a topic file there; the index stays allowed.
 */
export const INDEX_FOLDERS: readonly PathCompanion[] = [
  { when: "docs/design.md", also: ["docs/design/"] },
  { when: "docs/plugins.md", also: ["docs/plugins/"] },
];

/**
 * The built-in rules (decided 2026-11-18): the companions of one `files_to_change` path, read from the path alone,
 * since triage has no clone. A design topic file adds its History file; a web view adds the i18n area file its name
 * maps to (a shared component: the shell's); a source file adds the test named after it.
 */
const COMPANION_RULES: readonly ((file: string) => string[])[] = [
  (file) => {
    const topic = /^docs\/design\/([^/]+)\.md$/.exec(file)?.[1];
    return topic === undefined ? [] : [`docs/design/history/${topic}.md`];
  },
  (file) => {
    if (/^web\/src\/components\/.+\.tsx?$/.test(file)) return ["web/src/i18n/en/shell.ts"];
    const view = /^web\/src\/views\/(?:([^/]+)\/[^/]+|([^/.-]+)[^/]*)\.tsx?$/.exec(file);
    return view ? [`web/src/i18n/en/${view[1] ?? view[2]}.ts`] : [];
  },
  (file) => {
    if (file.startsWith("tests/") || file.endsWith(".d.ts")) return [];
    const m = /(?:^|\/)([^/.]+)[^/]*\.(tsx?)$/.exec(file);
    return m && m[1] !== "index" ? [`tests/${m[1]}.test.${m[2]}`] : [];
  },
];

/** True when a built-in rule may never add `path`: on the gate list (protected paths included) or under a floor. */
export function refusedCompanion(path: string, floors: readonly Floor[]): boolean {
  return isGatePath(path) || floorTier([path], floors) !== null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Repo-relative: non-empty, not absolute, no `..` segment. */
function isRepoPath(p: unknown): p is string {
  return typeof p === "string" && p.trim() !== "" && !p.startsWith("/") && !p.split("/").includes("..");
}

/** Every problem with the `path_companions` key of a parsed factory.config.json, one message each. Absent: none. */
export function pathCompanionProblems(raw: unknown): string[] {
  if (!isObj(raw) || raw.path_companions === undefined) return [];
  const list = raw.path_companions;
  if (!Array.isArray(list)) return ["path_companions must be a list of { when, also } entries"];
  const problems: string[] = [];
  list.forEach((entry, i) => {
    const at = `path_companions[${i}]`;
    if (!isObj(entry)) {
      problems.push(`${at} must be an object with "when" and "also"`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!(PATH_COMPANION_KEYS as readonly string[]).includes(key)) {
        problems.push(`${at} has unknown key "${key}"; valid keys: ${PATH_COMPANION_KEYS.join(", ")}`);
      }
    }
    if (!isRepoPath(entry.when)) problems.push(`${at}.when must be a non-empty repo-relative path`);
    if (!Array.isArray(entry.also) || entry.also.length === 0 || !entry.also.every(isRepoPath)) {
      problems.push(`${at}.also must be a non-empty list of repo-relative paths`);
    }
  });
  return problems;
}

/** The checked `path_companions` entries; [] when the key is absent. Throws every problem, one per line. */
export function pathCompanionsConfig(raw: unknown): PathCompanion[] {
  const problems = pathCompanionProblems(raw);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const list = isObj(raw) && Array.isArray(raw.path_companions) ? (raw.path_companions as PathCompanion[]) : [];
  return list.map((c) => ({ when: c.when, also: [...c.also] }));
}

/** True when a `when` path matches a named path: equal, under a `when` folder, or a `when` under a named folder. */
export function whenMatches(when: string, path: string): boolean {
  return path === when || (when.endsWith("/") && path.startsWith(when)) || (path.endsWith("/") && when.startsWith(path));
}

/**
 * The companion step, on the raw triage answer before parseTriage. Adds each companion path to the top-level
 * `allowed_paths` unless an allowed path already covers it: config entries whose `when` matches a
 * `files_to_change` path, the doc index folders (INDEX_FOLDERS) when an index is named in either list, and the
 * built-in rules' paths for each `files_to_change` path, except a gate path or one under `floors`.
 * Phases' own `allowed_paths` are left alone: each phase's own triage applies the rule. An answer whose lists
 * are not string lists is returned as is, for parseTriage to reject. Never mutates `answer`.
 */
export function applyCompanions(answer: unknown, companions: readonly PathCompanion[], floors: readonly Floor[] = []): { answer: unknown; added: AddedPath[] } {
  if (!isObj(answer) || !isStrs(answer.allowed_paths) || !isStrs(answer.files_to_change)) return { answer, added: [] };
  const files = answer.files_to_change;
  const allowed = [...answer.allowed_paths];
  const added: AddedPath[] = [];
  const add = (path: string, because: string) => {
    if (isCovered(path, allowed)) return;
    allowed.push(path);
    added.push({ path, because });
  };
  for (const c of companions) {
    const hit = files.find((f) => whenMatches(c.when, f));
    if (hit !== undefined) for (const p of c.also) add(p, c.when);
  }
  for (const c of INDEX_FOLDERS) {
    if (files.includes(c.when) || answer.allowed_paths.includes(c.when)) for (const p of c.also) add(p, c.when);
  }
  for (const f of files) {
    for (const rule of COMPANION_RULES) for (const p of rule(f)) if (!refusedCompanion(p, floors)) add(p, f);
  }
  if (added.length === 0) return { answer, added };
  return { answer: { ...answer, allowed_paths: allowed }, added };
}
