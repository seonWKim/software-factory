// What setup and the factory it starts leave on this machine (design 08-teardown.md): every path under the state
// folder, every worktree location and every git ref prefix. One list, read by `factory teardown` and by the test
// that fails when setup writes a path missing from it (tests/teardown.test.ts).

import { progressFile } from "./cli/handlers/setup/progress.js";
import { LOCAL_KEY_FILE } from "./identity/index.js";
import { EMPTY_HOOKS_DIR } from "./impl/sandbox/noop-sandbox.js";
import { SUPERVISOR_REQUEST_FILE, SUPERVISOR_STATUS_FILE } from "./interfaces/updater.js";
import { HOST_ID_FILE } from "./runtime/host-id.js";

/** One top-level entry of the state folder: its name relative to the folder, and what it holds. */
export interface StatePath {
  readonly path: string;
  readonly what: string;
}

/** Every top-level entry the factory creates in its state folder (`state_dir`, `.factory/` by default). */
export const STATE_PATHS: readonly StatePath[] = [
  { path: "db", what: "the SQLite store and its migration backups" },
  { path: progressFile(""), what: "setup's progress record" },
  { path: HOST_ID_FILE, what: "this machine's host id" },
  { path: LOCAL_KEY_FILE, what: "the solo passport key" },
  { path: SUPERVISOR_STATUS_FILE, what: "the supervisor's status" },
  { path: SUPERVISOR_REQUEST_FILE, what: "a request to the supervisor" },
  { path: "versions", what: "version copies of the base branch (git worktrees)" },
  { path: "deps", what: "installed dependencies of the version copies" },
  { path: "agents", what: "agent configs and homes" },
  { path: "storage", what: "shared storage (transcripts, artifacts)" },
  { path: "sessions", what: "interactive session records" },
  { path: "golden", what: "golden set results" },
];

/** The state folder's subfolder whose entries are git worktrees of the repository (the updater's version copies). */
export const VERSIONS_DIR = "versions";

/**
 * Entries of the worktrees folder (`worktrees_dir`, `.worktrees/` by default) the factory makes: one clone per run
 * (`sbx_` and 8 hex digits, as the noop sandbox names it), merge scratch folders and the empty hooks folder. Any
 * other entry there is a person's own and is never removed.
 */
export const RUN_FOLDER = /^sbx_[0-9a-f]{8}$/;

/** A merge scratch folder or the empty hooks folder: factory-made, never holding a person's work. */
export function isScratchFolder(name: string): boolean {
  return name.startsWith(".merge-") || name === EMPTY_HOOKS_DIR;
}

/** The git ref prefixes the factory writes besides its branches (`branch_prefix`, under refs/heads/). */
export const REF_PREFIXES: readonly string[] = ["refs/factory/"];

/** What a state folder entry is, or null when the list does not name it. */
export function statePath(name: string): StatePath | null {
  return STATE_PATHS.find((p) => p.path === name) ?? null;
}
