// The file-only key writer (design 08-settings, phase 2 of "Settings without editing factory.config.json"): one
// file-only key of factory.config.json, edited for the owner and put on a new local branch `<branch_prefix><id>`,
// filed as one local work item waiting for the owner's merge (`factory merge <id>`, which runs the merge queue's
// checks before the commit lands). No review run: the owner wrote the edit, the loader checks it here, and a
// loosening-sensitive edit needs the confirm flag. The file stays the one store of the value: the audit row records
// the edit, and a runtime override of `models` or `model_by` still wins over the file value. Core runs no git: the
// sandbox reads the base and writes the commit and the branch, never the owner's checkout. `factory settings
// edit-file` and the Settings write route both run editConfigFile. A refusal writes no file, branch, row or item.

import type { Sandbox } from "../interfaces/sandbox.js";
import { type Json, isJsonObject, setConfigKey } from "./config-text.js";
import type { Timestamp, UserId, WorkItem, WorkItemId } from "./types.js";

/**
 * The keys the writer edits (owner list, phase 1 owns any change to it): plugins, models, model_by, slack, the repo
 * commands, toolchain, the paths (state_dir, worktrees_dir, repo.path), floors, dials, permissions, the guards, and
 * the path lists triage weighs (hotspot_paths, mechanical_paths, path_companions). A dotted key names a member of an object.
 */
export const FILE_ONLY_KEYS = [
  "plugins", "plugins.secrets", "plugins.egress", "plugins.broker",
  "models", "model_by", "slack",
  "repo.install_command", "repo.test_command", "repo.check_commands",
  "toolchain",
  "state_dir", "worktrees_dir", "repo.path",
  "floors", "dials", "permissions",
  "hotspot_paths", "mechanical_paths", "path_companions",
] as const;

/** The guards (owner answer): an edit to one is loosening-sensitive. `deny_paths` is built at load, never a file key. */
export const GUARD_KEYS = ["secrets", "egress", "broker", "deny_paths"] as const;

/** The plugins members that select a guard. */
const GUARD_PLUGINS = ["secrets", "egress", "broker"] as const;

/** A file-only key edit filed as a local item (design 08-settings): the item and its audit row, one transaction. */
export interface NewConfigFileChange {
  /** Chosen before the branch was made: the branch is `<branch_prefix><id>`. */
  id: WorkItemId;
  project: string;
  /** Who asked, as an ID, never a display name. */
  actor: UserId;
  key: string;
  /** JSON text; null when the file had no such key. */
  old_value: string | null;
  /** JSON text. */
  new_value: string;
  branch: string;
  /** The changed file, relative to the repo root: the item's allowed paths and changed files. */
  path: string;
  title: string;
  problem: string;
}

/** One audit row of a file-only key edit. The value itself lives only in the file; this row records the change. */
export interface ConfigFileChange {
  seq: number;
  work_item_id: WorkItemId;
  key: string;
  old_value: string | null;
  new_value: string;
  branch: string;
  actor: UserId;
  at: Timestamp;
}

export interface ConfigFileChangeStore {
  /**
   * Creates the local item at REVIEW, waiting for the owner's merge (blocked on human, `merge_pending`, no
   * change_ref), and its one audit row, in one transaction. Idempotent on the item ID: a second call writes nothing.
   */
  fileConfigEdit(input: NewConfigFileChange): Promise<{ item: WorkItem; change: ConfigFileChange; created: boolean }>;
  /** Audit rows, newest first, at most `limit`. */
  listConfigFileChanges(limit: number): Promise<ConfigFileChange[]>;
}

export interface ConfigWriterDeps {
  store: Pick<ConfigFileChangeStore, "fileConfigEdit">;
  sandbox: Pick<Sandbox, "readLocalFile" | "commitNewBranch">;
  /** The factory repo and its local base branch: the branch starts at the base, and the local merge lands it there. */
  repo: { path: string; base_branch: string };
  /** The config file, relative to the repo root; null when it is outside the factory repo (an external config). */
  file: string | null;
  branch_prefix: string;
  /** The commit's author and committer: the factory's git identity. */
  identity: { name: string; email: string };
  /** Who asks, as an ID. */
  actor: UserId;
  /** The configured repo's project key, or null when none is known here. */
  project(): Promise<string | null>;
  /** A fresh work item ID (`wi_…`). */
  newId(): WorkItemId;
  /** The config loader's checks (checkConfigKeys, then loadConfig) on the whole new text: the refusal, or null. */
  check(text: string): Promise<string | null>;
}

export interface ConfigEditRequest {
  key: string;
  /** JSON text. */
  value: string;
  /** The explicit confirm flag a loosening-sensitive edit needs (CLI `--confirm`, HTTP `"confirm": true`). */
  confirm: boolean;
}

export type ConfigEditResult =
  | { ok: true; item: WorkItemId; branch: string; sha: string; old_value: string | null; new_value: string }
  | { ok: false; refusal: string };

const refuse = (refusal: string): ConfigEditResult => ({ ok: false, refusal });

const isFileOnlyKey = (key: string): boolean => (FILE_ONLY_KEYS as readonly string[]).includes(key);

/** A guard, `floors` or `permissions`, by the key's name. */
function sensitiveByName(key: string): boolean {
  const [first] = key.split(".");
  return (GUARD_KEYS as readonly string[]).includes(key.split(".").at(-1)!) || first === "floors" || first === "permissions";
}

function at(raw: unknown, path: readonly string[]): Json | undefined {
  let v: unknown = raw;
  for (const k of path) {
    if (!isJsonObject(v)) return undefined;
    v = v[k];
  }
  return v as Json | undefined;
}

/** `raw` with the member at `path` set: what the edited text must parse to. */
function withValue(raw: Json, path: readonly string[], value: Json): Json {
  const [k, ...rest] = path;
  const obj = isJsonObject(raw) ? raw : {};
  return { ...obj, [k!]: rest.length === 0 ? value : withValue(obj[k!] ?? {}, rest, value) };
}

const text = (v: Json | undefined): string | null => (v === undefined ? null : JSON.stringify(v));

const SENSITIVE = "is loosening-sensitive (a guard, floor or permission): the edit needs the confirm flag (`--confirm`, or \"confirm\": true)";

/**
 * Sets one file-only key on a new local branch and files it for the owner's merge. Checks first, then one commit
 * on `<branch_prefix><id>` from the base's commit, then the item and its audit row. Never touches the base ref,
 * HEAD or the working tree.
 */
export async function editConfigFile(d: ConfigWriterDeps, r: ConfigEditRequest): Promise<ConfigEditResult> {
  let value: Json;
  try {
    value = JSON.parse(r.value) as Json;
  } catch {
    return refuse(`the value of ${r.key} must be JSON text`);
  }
  if (sensitiveByName(r.key) && !r.confirm) return refuse(`${r.key} ${SENSITIVE}`);
  if (!isFileOnlyKey(r.key)) return refuse(`${r.key} is not a file-only key; the file-only keys are ${FILE_ONLY_KEYS.join(", ")}`);
  if (d.file === null) return refuse("the config file is outside the factory repo, so no branch can carry the edit");
  if (!d.sandbox.readLocalFile || !d.sandbox.commitNewBranch) return refuse("this sandbox cannot commit to a local branch");

  const base = await d.sandbox.readLocalFile({ repo: d.repo.path, ref: d.repo.base_branch, path: d.file });
  if (base === null) return refuse(`the local ${d.repo.base_branch} has no ${d.file}`);
  let raw: Json;
  try {
    raw = JSON.parse(base.text) as Json;
  } catch {
    return refuse(`${d.file} on ${d.repo.base_branch} is not JSON`);
  }
  const path = r.key.split(".");
  const old = at(raw, path);
  if (text(old) === JSON.stringify(value)) return refuse(`${r.key} already has that value in ${d.file}`);
  if (r.key === "plugins" && !r.confirm && GUARD_PLUGINS.some((g) => text(at(old, [g])) !== text(at(value, [g])))) {
    return refuse(`this plugins edit changes a guard (${GUARD_PLUGINS.join(", ")}) and ${SENSITIVE}`);
  }

  let edited: string;
  try {
    edited = setConfigKey(base.text, path, value);
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
  // Belt and braces: the edited text parses to the old file with only this key changed.
  if (JSON.stringify(JSON.parse(edited)) !== JSON.stringify(withValue(raw, path, value))) return refuse(`${r.key} could not be edited without changing another key`);
  const refusal = await d.check(edited);
  if (refusal !== null) return refuse(refusal);
  const project = await d.project();
  if (project === null) return refuse("no project is stored yet: start the factory once so it records the configured repo");

  const id = d.newId();
  const branch = `${d.branch_prefix}${id}`;
  const made = await d.sandbox.commitNewBranch({
    repo: d.repo.path, base_ref: d.repo.base_branch, parent: base.commit, branch, path: d.file, content: edited, identity: d.identity,
    message: `Set ${r.key} in ${d.file}\n\nWork item ${id}, by ${d.actor} with \`factory settings edit-file\`.`,
  });
  if (!made.created) {
    return refuse(made.reason === "exists" ? `the branch ${branch} already exists` : `the local ${d.repo.base_branch} moved while the edit was made; run it again`);
  }
  const old_value = text(old);
  const new_value = JSON.stringify(value);
  await d.store.fileConfigEdit({
    id, project, actor: d.actor, key: r.key, old_value, new_value, branch, path: d.file,
    title: `Set ${r.key} in ${d.file}`,
    problem: `Set ${r.key} in ${d.file} from ${old_value ?? "(not set)"} to ${new_value}. The commit is on the local branch ${branch}; merge it with \`factory merge ${id}\`.`,
  });
  return { ok: true, item: id, branch, sha: made.sha, old_value, new_value };
}
