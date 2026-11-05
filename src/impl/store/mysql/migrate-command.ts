// `factory migrate` (npm run migrate): status, dry-run and apply over one MySQL connection; the machine-readable
// status the git-worktree updater checks before it starts a new revision; and the drain protocol that lets
// `npm run migrate` run while the factory does (design: Self-update, MySQL schema steps).

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import mysql from "mysql2/promise";
import type { Clock } from "../../../interfaces/clock.js";
import {
  MIGRATION_PENDING_CODE,
  SUPERVISOR_REQUEST_FILE,
  SUPERVISOR_STATUS_FILE,
  type SupervisorRequest,
  type SupervisorStatus,
} from "../../../interfaces/updater.js";
import type { MysqlOptions } from "./mysql-driver.js";
import { type MigrationStatus, MysqlMigrations, type Queryable } from "./migrations.js";

export type MigrateMode = "apply" | "status" | "dry-run";

export const SQLITE_MIGRATE_MESSAGE =
  "SQLite has no schema scripts: it builds the latest schema when the factory opens it. `npm run migrate` runs only the data steps (project keys) on SQLite.";

export const BACKUP_REMINDER =
  "Back up the database before migrating (e.g. mysqldump --single-transaction <database> > backup.sql). Steps are not reversible.";

const MIGRATE_FLAGS = ["--status", "--dry-run", "--json", "--no-drain"];

/**
 * `--status` / `--dry-run` as arguments (`npm run migrate -- --status`) or as npm config
 * (`npm run migrate --status` sets npm_config_status). `--json` and `--no-drain` are read by `migrateFlags`.
 */
export function parseMigrateArgs(args: readonly string[], env: Record<string, string | undefined> = {}): MigrateMode | { error: string } {
  const flag = (name: string, envName: string) => args.includes(`--${name}`) || env[envName] === "true";
  const unknown = args.filter((a) => !MIGRATE_FLAGS.includes(a));
  if (unknown.length > 0) return { error: `unknown argument: ${unknown.join(" ")} (use --status [--json], --dry-run or --no-drain)` };
  const status = flag("status", "npm_config_status");
  const dry = flag("dry-run", "npm_config_dry_run");
  if (status && dry) return { error: "use one of --status and --dry-run" };
  return status ? "status" : dry ? "dry-run" : "apply";
}

/**
 * `--json` (with `--status`): print one JSON object, `PendingReport`, and nothing else. `--no-drain`: apply without
 * asking a running supervisor to drain. As npm config, `npm run migrate --no-drain` sets npm_config_drain to "".
 */
export function migrateFlags(args: readonly string[], env: Record<string, string | undefined> = {}): { json: boolean; noDrain: boolean } {
  return {
    json: args.includes("--json") || env.npm_config_json === "true",
    noDrain: args.includes("--no-drain") || env.npm_config_drain === "" || env.npm_config_drain === "false",
  };
}

/** The name the project-key data step has in a pending list. */
export const PROJECT_KEYS_STEP = "project-keys";

/**
 * `migrate --status --json`: what the updater checks before it starts a new revision. Exit 0 whether or not
 * steps are pending; non-zero only when the check itself failed. `pending` lists every step name in order:
 * schema steps, then `project-keys` when owner/name rows are left. While schema steps are pending the
 * project-key step is not counted (it reads tables those steps may create): `project_keys.status` says
 * `after_schema_steps`.
 */
export interface PendingReport {
  store: "mysql" | "sqlite";
  /** null on SQLite (no schema scripts). */
  schema: { state: number | null; latest: number; pending: string[]; refusal: string | null } | null;
  project_keys: { status: "done" | "pending" | "after_schema_steps"; rows: number | null };
  pending: string[];
}

/** Builds the report from the schema status (null: SQLite) and, only once the schema is current, the row count. */
export async function pendingReport(d: { schema: () => Promise<MigrationStatus | null>; legacyRows: () => Promise<number> }): Promise<PendingReport> {
  const s = await d.schema();
  const schemaPending = s === null || (s.state !== null && s.state > s.latest) ? [] : s.pending.map((p) => p.label);
  const refusal = s?.refusal ?? null;
  const schema = s === null ? null : { state: s.state, latest: s.latest, pending: schemaPending, refusal };
  const store = s === null ? "sqlite" : "mysql";
  if (schemaPending.length > 0 || refusal) {
    return { store, schema, project_keys: { status: "after_schema_steps", rows: null }, pending: refusal ? [`refused: ${refusal}`] : schemaPending };
  }
  const rows = await d.legacyRows();
  return {
    store,
    schema,
    project_keys: { status: rows > 0 ? "pending" : "done", rows },
    pending: rows > 0 ? [PROJECT_KEYS_STEP] : [],
  };
}

/**
 * A supervised child's start error while steps are pending. `code` is MIGRATION_PENDING_CODE, a stable field
 * the supervisor reads (never the message text); `pending` names the steps.
 */
export class MigrationPendingError extends Error {
  readonly code = MIGRATION_PENDING_CODE;
  constructor(
    message: string,
    readonly pending: readonly string[],
  ) {
    super(message);
  }
}

// --- migrate while the factory runs --------------------------------------------------------------------------

/** The running supervisor's status, when its `supervisor_pid` is alive; else null (apply directly). */
export async function liveSupervisor(stateDir: string, alive: (pid: number) => boolean): Promise<SupervisorStatus | null> {
  const s = await readStatus(stateDir);
  if (!s || s.state === "stopped" || typeof s.supervisor_pid !== "number" || !alive(s.supervisor_pid)) return null;
  return s;
}

async function readStatus(stateDir: string): Promise<SupervisorStatus | null> {
  try {
    return JSON.parse(await readFile(join(stateDir, SUPERVISOR_STATUS_FILE), "utf8")) as SupervisorStatus;
  } catch {
    return null;
  }
}

/** Writes the request file atomically. */
export async function writeSupervisorRequest(stateDir: string, req: SupervisorRequest): Promise<void> {
  const file = join(stateDir, SUPERVISOR_REQUEST_FILE);
  await writeFile(`${file}.tmp`, `${JSON.stringify(req)}\n`);
  await rename(`${file}.tmp`, file);
}

export interface DrainMigrateDeps {
  stateDir: string;
  clock: Clock;
  alive: (pid: number) => boolean;
  /** How long to wait for every child to exit before giving up: run_timeout_ms + 60 s + one supervisor poll. */
  drainTimeoutMs: number;
  /** How often the status file is read while waiting. Default 1000. */
  stepMs?: number;
  /** How often a progress line is printed while the set of live children stays the same. Default 15000. */
  progressMs?: number;
  /** This process's pid: the supervisor treats the drain as cancelled once it is gone. */
  pid: number;
  print: (line: string) => void;
  /** Applies the steps: the waiting target's own migrate from its folder, or this checkout's when none waits. */
  apply: (target: { rev: string; dir: string } | null) => Promise<number>;
}

const shortRev = (rev: string | null | undefined) => (rev ? rev.slice(0, 7) : "unknown");

/**
 * `npm run migrate` with a live supervisor: write a drain request, wait until the supervisor holds and no child
 * is live, apply the steps, then write start (applied) or cancel (failed, or the wait gave up). Returns the exit code.
 */
export async function migrateWithSupervisor(sup: SupervisorStatus, d: DrainMigrateDeps): Promise<number> {
  const target =
    sup.state === "migration_pending" && sup.target_rev && sup.target_dir ? { rev: sup.target_rev, dir: sup.target_dir } : null;
  const request = (action: SupervisorRequest["action"]) =>
    writeSupervisorRequest(d.stateDir, { action, target_rev: target?.rev ?? null, pid: d.pid, at: d.clock.now().toISOString() });
  await request("drain");
  d.print(
    `the factory is running (supervisor pid ${sup.supervisor_pid}): asked it to drain` +
      (target ? ` so ${shortRev(target.rev)}'s steps can be applied` : "") +
      `; waiting up to ${Math.round(d.drainTimeoutMs / 1000)} s for its in-flight runs to finish`,
  );
  const start = d.clock.now().getTime();
  let lastLine = "";
  let lastPrint = start;
  for (;;) {
    const s = await readStatus(d.stateDir);
    const pids = s ? [s.child_pid, ...(s.draining_pids ?? [])].filter((p): p is number => typeof p === "number" && d.alive(p)) : [];
    const live = [...new Set(pids)];
    if (s?.held && live.length === 0) break;
    const now = d.clock.now().getTime();
    if (now - start >= d.drainTimeoutMs) {
      d.print(`gave up after ${Math.round((now - start) / 1000)} s: children still live (${live.join(", ") || "supervisor has not taken the drain request"}). Nothing was applied; the factory resumes`);
      await request("cancel");
      return 1;
    }
    const line = s?.held ? `waiting for ${live.length} child${live.length === 1 ? "" : "ren"} to finish (pids ${live.join(", ")})` : "waiting for the supervisor to take the drain request";
    if (line !== lastLine || now - lastPrint >= (d.progressMs ?? 15_000)) {
      d.print(`${line}, ${Math.round((now - start) / 1000)} s so far`);
      lastLine = line;
      lastPrint = now;
    }
    await d.clock.sleep(d.stepMs ?? 1000);
  }
  d.print("no child is running: applying the steps");
  let code: number;
  try {
    code = await d.apply(target);
  } catch (err) {
    d.print(err instanceof Error ? err.message : String(err));
    code = 1;
  }
  if (code === 0) {
    await request("start");
    d.print(target ? `applied: the supervisor starts ${shortRev(target.rev)} on its next poll` : "applied: the supervisor restarts the factory on its next poll");
  } else {
    await request("cancel");
    d.print(`migrate failed: the supervisor restarts ${shortRev(sup.rev)} from its own folder on its next poll`);
  }
  return code;
}

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

function printPending(s: MigrationStatus, print: (line: string) => void): void {
  if (s.pending.length === 0) print("pending: none (up to date)");
  else {
    print("pending:");
    for (const p of s.pending) print(`  ${pad(p.number)}  ${p.label}`);
  }
}

/** Runs one mode on `db` (one connection). Returns the exit code; prints instead of throwing. */
export async function runMigrate(
  db: Queryable,
  mode: MigrateMode,
  print: (line: string) => void,
  opts: { dir?: string } = {},
): Promise<number> {
  const m = new MysqlMigrations(db, opts);
  try {
    if (mode === "status") {
      const s = await m.status();
      print(`state: ${s.state ?? "none"} (latest step: ${s.latest})`);
      if (s.refusal) {
        print(`refusing: ${s.refusal}`);
        return 1;
      }
      printPending(s, print);
      return 0;
    }
    if (mode === "dry-run") {
      const s = await m.dryRun(print);
      if (s.refusal) {
        print(`refusing: ${s.refusal}`);
        return 1;
      }
      print(s.pending.length === 0 ? `up to date at state ${s.state}: nothing to apply` : "dry run: nothing was changed");
      return 0;
    }
    print(BACKUP_REMINDER);
    const s = await m.apply(print);
    print(s.pending.length === 0 ? `up to date at state ${s.state}: nothing to apply` : `done: state ${s.pending.at(-1)!.number}`);
    return 0;
  } catch (err) {
    print(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/** Opens one connection for `runMigrate` and closes it. */
export async function migrateCommand(opts: MysqlOptions, mode: MigrateMode, print: (line: string) => void): Promise<number> {
  const c = await mysql.createConnection({ host: opts.host, port: opts.port, user: opts.user, password: opts.password, database: opts.database });
  try {
    return await runMigrate(c, mode, print);
  } finally {
    await c.end();
  }
}
