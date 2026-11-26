// Path companions (design 04-triage.md, issue #224): files a change to a path also needs, such as a
// migration step beside a schema change, or a design topic file beside its index. Triage names the files it
// expects to change; the controller adds each companion to `allowed_paths` before the answer is checked, so a
// path limit never stops the implementer halfway.

import { isGatePath } from "./improver.js";
import { MAX_APPLIED_DEFAULTS } from "./outputs.js";
import { floorTier, isCovered } from "./policy.js";
import type { Floor } from "./settings.js";

/**
 * One `path_companions` entry of factory.config.json: when `files_to_change` names `when` (and each `with` path),
 * also allow `also`; `reason` says why in the spec's applied defaults.
 */
export interface PathCompanion {
  /** A repo-relative path; one ending in `/` names a folder. */
  when: string;
  /** Repo-relative paths added to `allowed_paths`, at least one; a path ending in `/` names a folder. */
  also: string[];
  /** More paths `files_to_change` must also name for the entry to apply, matched like `when`. Absent: `when` alone. */
  with?: string[];
  /** Why the change needs `also`; the spec notes "Added by companion rule: <reason>" under its applied defaults. */
  reason?: string;
}

/** A path the companion step added to `allowed_paths`, and the path that caused it. */
export interface AddedPath {
  path: string;
  because: string;
}

/** The keys a `path_companions` entry may have. */
export const PATH_COMPANION_KEYS = ["when", "also", "with", "reason"] as const;

/** The applied-defaults line of a companion entry with a reason (decided 2026-11-22). */
export const companionNote = (reason: string): string => `Added by companion rule: ${reason}`;

/**
 * The doc indexes and their topic folders. An answer that names an index in `files_to_change` or
 * `allowed_paths` also gets the folder, since the change edits a topic file there; the index stays allowed.
 */
export const INDEX_FOLDERS: readonly PathCompanion[] = [
  { when: "docs/design.md", also: ["docs/design/"] },
  { when: "docs/plugins.md", also: ["docs/plugins/"] },
];

/** The generated i18n catalog barrel: allowed only when the answer names it (a new area file). */
const I18N_BARREL = "web/src/i18n/en.ts";

/** One built-in rule: the companions of one `files_to_change` path, read from the path alone. */
export interface CompanionRule {
  also: (file: string) => string[];
  /** The fixed paths a kind rule adds; a test checks each exists in the repository. */
  fixed?: readonly string[];
  /** Why; noted under the spec's applied defaults like a config entry's reason. */
  reason?: string;
}

/** A migration directly under `src/<owner>/migrations/`, or that folder itself (the file name not chosen yet). */
const MIGRATION = /^src\/([^/]+)\/migrations\/(?:[^/]+\.ts)?$/;

/** A kind rule: a file matching `when` brings the `fixed` files along, for `reason`. */
const kindRule = (when: RegExp, fixed: readonly string[], reason: string): CompanionRule => ({
  also: (file) => (when.test(file) ? [...fixed] : []),
  fixed,
  reason,
});

/**
 * The built-in rules (decided 2026-11-18), the one list of them: the companions of one `files_to_change` path, read
 * from the path alone, since triage has no clone. A design topic file adds its History file; a web view or component
 * adds only the i18n area file its name maps to; the generated catalog barrel `web/src/i18n/en.ts`
 * (`npm run i18n:catalog`) is added only when `files_to_change` names it, as triage does for a new area file (decided
 * 2026-11-20); a source file under `src/` adds the test named after it; a migration directly under
 * `src/<owner>/migrations/` adds that owner's `src/<owner>/table-docs.ts`. The kind rules (decided 2026-11-26): a
 * migration adds the schema snapshot, a capability under `src/api/capabilities/` adds the API registry files, and
 * `src/core/settings.ts` or a declaration `src/<owner>/settings/<name>.setting.ts` adds the Settings page's label and
 * group files.
 * A later rule is one entry here plus its test in tests/path-companions.test.ts.
 */
export const COMPANION_RULES: readonly CompanionRule[] = [
  {
    also: (file) => {
      const topic = /^docs\/design\/([^/]+)\.md$/.exec(file)?.[1];
      return topic === undefined ? [] : [`docs/design/history/${topic}.md`];
    },
  },
  {
    also: (file) => {
      const area =
        /^web\/src\/components\/([^/.]+)\.tsx$/.exec(file)?.[1] ??
        /^web\/src\/views\/(?:([^/]+)\/[^/]+|([^/.-]+)[^/]*)\.tsx$/.exec(file)?.slice(1).find((a) => a !== undefined);
      return area === undefined ? [] : [`web/src/i18n/en/${area}.ts`];
    },
  },
  { also: (file) => (file === I18N_BARREL ? [file] : []) },
  {
    also: (file) => {
      if (file.endsWith(".d.ts")) return [];
      const m = /^src\/(?:.+\/)?([^/.]+)[^/]*\.(tsx?)$/.exec(file);
      return m && m[1] !== "index" ? [`tests/${m[1]}.test.${m[2]}`] : [];
    },
  },
  {
    also: (file) => {
      const owner = MIGRATION.exec(file)?.[1];
      return owner === undefined ? [] : [`src/${owner}/table-docs.ts`];
    },
  },
  kindRule(MIGRATION, ["schema/sqlite/controller.sql"], "a new migration changes the schema snapshot (npm run schema:snapshot)"),
  kindRule(
    /^src\/api\/capabilities\/(?:[^/]+\.ts)?$/,
    ["src/api/index.ts", "web/src/api/generated.ts", "docs/api/openapi.json"],
    "a new or changed API capability changes its registry files (npm run gen:api)",
  ),
  kindRule(
    /^src\/(?:core\/settings\.ts|[^/]+\/settings\/(?:[^/]+\.setting\.ts)?)$/,
    ["web/src/i18n/en/settings.ts", "web/src/views/settings/advanced-groups.ts"],
    "a new settable key needs its Settings-page label, help and group",
  ),
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
    if (entry.with !== undefined && (!Array.isArray(entry.with) || entry.with.length === 0 || !entry.with.every(isRepoPath))) {
      problems.push(`${at}.with must be a non-empty list of repo-relative paths`);
    }
    if (entry.reason !== undefined && (typeof entry.reason !== "string" || entry.reason.trim() === "")) {
      problems.push(`${at}.reason must be a non-empty string`);
    }
  });
  return problems;
}

/** The checked `path_companions` entries; [] when the key is absent. Throws every problem, one per line. */
export function pathCompanionsConfig(raw: unknown): PathCompanion[] {
  const problems = pathCompanionProblems(raw);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const list = isObj(raw) && Array.isArray(raw.path_companions) ? (raw.path_companions as PathCompanion[]) : [];
  return list.map((c) => ({
    when: c.when, also: [...c.also], ...(c.with ? { with: [...c.with] } : {}), ...(c.reason ? { reason: c.reason.trim() } : {}),
  }));
}

/** True when a `when` path matches a named path: equal, under a `when` folder, or a `when` under a named folder. */
export function whenMatches(when: string, path: string): boolean {
  return path === when || (when.endsWith("/") && path.startsWith(when)) || (path.endsWith("/") && when.startsWith(path));
}

/**
 * The companion step, on the raw triage answer before parseTriage. Adds each companion path to the top-level
 * `allowed_paths` unless an allowed path already covers it: config entries whose `when` matches a
 * `files_to_change` path, the doc index folders (INDEX_FOLDERS) when an index is named in either list, and the
 * built-in rules' paths for each `files_to_change` path, except a gate path or one under `floors` (the project's
 * tier floors, required so no caller skips the refusal). A config entry or built-in rule with a `reason` that added a path also adds
 * its note (`companionNote`) to the answer's `applied_defaults`, once per reason; notes that would pass
 * MAX_APPLIED_DEFAULTS share one line, and none is added when even that does not fit (the Files section still names
 * the paths). The controller runs it on every triage answer, so a `/revise` (a new triage run) gets it too.
 * Phases' own `allowed_paths` are left alone: each phase's own triage applies the rule. An answer whose lists
 * are not string lists is returned as is, for parseTriage to reject. Never mutates `answer`.
 */
export function applyCompanions(answer: unknown, companions: readonly PathCompanion[], floors: readonly Floor[]): { answer: unknown; added: AddedPath[] } {
  if (!isObj(answer) || !isStrs(answer.allowed_paths) || !isStrs(answer.files_to_change)) return { answer, added: [] };
  const files = answer.files_to_change;
  const allowed = [...answer.allowed_paths];
  const added: AddedPath[] = [];
  const add = (path: string, because: string): boolean => {
    if (isCovered(path, allowed)) return false;
    allowed.push(path);
    added.push({ path, because });
    return true;
  };
  const reasons: string[] = [];
  const addAll = (paths: readonly string[], because: string, reason: string | undefined) => {
    const any = paths.map((p) => add(p, because)).some(Boolean);
    if (any && reason && !reasons.includes(reason)) reasons.push(reason);
  };
  const named = (when: string) => files.some((f) => whenMatches(when, f));
  for (const c of companions) {
    if (named(c.when) && (c.with ?? []).every(named)) addAll(c.also, c.when, c.reason);
  }
  for (const c of INDEX_FOLDERS) {
    if (files.includes(c.when) || answer.allowed_paths.includes(c.when)) for (const p of c.also) add(p, c.when);
  }
  for (const f of files) {
    for (const rule of COMPANION_RULES) addAll(rule.also(f).filter((p) => !refusedCompanion(p, floors)), f, rule.reason);
  }
  if (added.length === 0) return { answer, added };
  const notes = withNotes(answer.applied_defaults, reasons);
  return { answer: { ...answer, allowed_paths: allowed, ...(notes ? { applied_defaults: notes } : {}) }, added };
}

/** `applied_defaults` with one note per reason, or one shared note when they would pass the limit; null: unchanged. */
function withNotes(defaults: unknown, reasons: readonly string[]): string[] | null {
  if (reasons.length === 0 || (defaults !== undefined && !isStrs(defaults))) return null;
  const was = defaults ?? [];
  const notes = was.length + reasons.length <= MAX_APPLIED_DEFAULTS ? reasons.map(companionNote) : [companionNote(reasons.join("; "))];
  return was.length + notes.length <= MAX_APPLIED_DEFAULTS ? [...was, ...notes] : null;
}
