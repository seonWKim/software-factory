// A cleanup handler (design 08-cleanup): one folder under src/cleanup/handlers/<name>/ holding `<name>.cleanup.ts`,
// whose default export is defineCleanupHandler(...). The sweep finds them by pattern and never names a resource kind:
// each handler lists its own resources, says which it accepts, why one must stay, and removes one.

import type { CommandRunner } from "../interfaces/updater.js";

export const HANDLER_FILE = /\.cleanup\.(?:ts|js)$/;

/** A running process as the host reports it: its id, its command name and its working folder. */
export interface HostProcess {
  readonly pid: number;
  readonly command: string;
  readonly cwd: string;
}

/** The host's process table: listed and signalled through here, so a test fakes it. */
export interface ProcessTable {
  list(): Promise<HostProcess[]>;
  /** Asks the process to stop (SIGTERM). */
  stop(pid: number): Promise<void>;
}

/** What every handler works with on this host. */
export interface CleanupEnv {
  /** The factory repository (the owner's checkout). */
  readonly repo: string;
  /** The folder this host's run folders are made in. */
  readonly worktreesDir: string;
  /** The name of a run folder the sandbox makes in `worktreesDir` (setup-paths' RUN_FOLDER, given by the root). */
  readonly runFolder: RegExp;
  /** `branch_prefix` (`factory/`): an item's branch is `<prefix><id>`. */
  readonly branchPrefix: string;
  readonly baseBranch: string;
  readonly run: CommandRunner;
  readonly processes: ProcessTable;
  /** Where an agent runtime leaves a temp folder per run folder it ran in (Claude Code: `/tmp/claude-<uid>`). */
  readonly agentTempRoots: readonly string[];
}

/** One thing a handler may remove. */
export interface Resource {
  /** The listing handler's name. */
  readonly kind: string;
  /** Unique across every handler: a path, a ref, a pid. */
  readonly key: string;
  /** What the history and the CLI name it by, e.g. `run folder /repo/.worktrees/sbx_1a2b3c4d`. */
  readonly label: string;
  /** The work item it belongs to; null: none, and it stays with `unowned` as the reason. */
  readonly item_id: string | null;
  readonly unowned?: string;
  /**
   * Of a resource with no item and no parent that nothing uses any more: when it was last used (ms). It goes once
   * `cleanup.keep_hours` passed since then, instead of staying with `unowned` as the reason.
   */
  readonly idle_since?: number;
  /** The key of the resource it lives in: it goes only in a pass where that one goes too. */
  readonly parent?: string;
  /** The handler's own facts (a path, a sha, a pid). */
  readonly data: Readonly<Record<string, string | number>>;
}

export interface CleanupHandlerDescriptor {
  readonly kind: "cleanup";
  readonly name: string;
  /** Removal order, lowest first (a process stops before its folder goes). */
  readonly order: number;
  /** This host's resources of the handler's kind, each with its item. */
  list(env: CleanupEnv): Promise<Resource[]>;
  accepts(resource: Resource): boolean;
  /** Why this resource must stay beyond the item's in-use guard (unsafe, not allowed), or null when it may go. */
  keep(resource: Resource, env: CleanupEnv): Promise<string | null>;
  /** Removes it; `bytes` freed, null when it has no size (a branch, a process). Throws on a failed removal. */
  cleanup(resource: Resource, env: CleanupEnv): Promise<{ bytes: number | null }>;
}

export function defineCleanupHandler(d: Omit<CleanupHandlerDescriptor, "kind">): CleanupHandlerDescriptor {
  return { kind: "cleanup", ...d };
}
