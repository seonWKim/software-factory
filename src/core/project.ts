// Project identity (design 2026-11-01, "Projects are keyed by the forge's repository ID"). A project is
// stored by its key, `<provider>:<host>:<repository id>`, which survives a rename or a move to another owner.
// The readable path (`<host>/<owner>/<name>`) is only a label: refreshed from the forge at startup, kept in
// the store for the status page, and the only form comments and log lines show. Pure: no I/O here.

/** A project as the factory stores it (`key`) and shows it (`label`). */
export interface ProjectRef {
  /** `<provider>:<host>:<repo node id>`. What every project column and lookup holds. Never shown. */
  key: string;
  /** `<host>/owner/name`, the repository's current path. What the status page, comments and logs show. */
  label: string;
}

/**
 * Providers the key format names: the forge's, and `local` for a factory with no forge plugin (design 05-sources,
 * Local startup). The format leaves room for others.
 */
export type ProjectProvider = "github" | "local";

const KEY = /^([a-z][a-z0-9-]*):([A-Za-z0-9.-]+(?::\d+)?):(.+)$/;
/** A legacy project value: `owner/name`, as stored before project keys. */
const OWNER_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * The key of the configured repo when no forge plugin is selected: `local:local:<digest>`, `digest` a hex hash of
 * its `owner/name` made by the caller (core runs no crypto). No forge ID, so a rename starts a new project.
 */
export function localProjectKey(digest: string): string {
  if (!/^[0-9a-f]{16,64}$/.test(digest)) throw new Error(`not a hex digest: ${JSON.stringify(digest)}`);
  return `local:local:${digest}`;
}

/** The label of a repository: `<host>/<owner>/<name>`. */
export function projectLabel(host: string, owner: string, name: string): string {
  return `${host}/${owner}/${name}`;
}

/** True for a project key (`<provider>:<host>:<id>`); false for a legacy `owner/name` or anything else. */
export function isProjectKey(value: string): boolean {
  return KEY.test(value) && !value.includes("/");
}

/** True for a legacy `owner/name` project value, the form the data migration rewrites. */
export function isLegacyProject(value: string): boolean {
  return OWNER_NAME.test(value);
}

/** Throws unless `value` is a project key: the store's check that no `owner/name` reaches a project column. */
export function assertProjectKey(value: string): void {
  if (!isProjectKey(value)) {
    throw new Error(`project must be a project key (<provider>:<host>:<id>), not ${JSON.stringify(value.slice(0, 80))}`);
  }
}

/** The store cursor that holds a project's label (the `cursors` table: name → value, conditional set). */
export function projectLabelCursor(key: string): string {
  return `project_label:${key}`;
}

/**
 * The store cursor that holds the key of the configured repo `owner/name` (design 2026-11-07): written once
 * the forge resolved it, read at every later startup so starting never waits on the forge.
 */
export function projectKeyCursor(repo: { owner: string; name: string }): string {
  return `project_key:${repo.owner}/${repo.name}`;
}

/** What the status page shows for a project with no stored label yet: never the raw key. */
export const UNKNOWN_PROJECT_LABEL = "unknown project";

/**
 * The gate settings layers keyed by the configured repo's `owner/name` (as factory.config.json writes them),
 * re-keyed to its project key once startup has resolved it. Other entries are dropped: config load already
 * refuses any project but the configured one.
 */
export function rekeyProjectSettings<T>(projects: Readonly<Record<string, T>>, ownerName: string, key: string): Record<string, T> {
  return Object.hasOwn(projects, ownerName) ? { [key]: projects[ownerName]! } : {};
}
