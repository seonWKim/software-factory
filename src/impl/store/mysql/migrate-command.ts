// `factory migrate` (npm run migrate): status, dry-run and apply over one MySQL connection; the
// machine-readable status the git-worktree updater reads before it drains; and the drain, apply, start
// protocol `npm run migrate` follows while a supervisor runs (design §8 Self-update, §5 MySQL schema steps).

import { readFile, rename, writeFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import type { Clock } from "../../../interfaces/clock.js";
import {
  type MigrationCheck,
  PROJECT_KEYS_STEP,
  type SupervisorRequest,
  type SupervisorStatus,
} from "../../../interfaces/updater.js";
import { countLegacyProjectRows } from "../project-keys.js";
import type { Row } from "../sql/driver.js";
import type { MysqlOptions } from "./mysql-driver.js";
import { type MigrationStatus, MysqlMigrations, type Queryable } from "./migrations.js";

export type MigrateMode = "apply" | "status" | "dry-run";

export const SQLITE_MIGRATE_MESSAGE =
  "SQLite has no schema scripts: it builds the latest schema when the factory opens it. `npm run migrate` runs only the data steps (project keys) on SQLite.";

export const BACKUP_REMINDER =
  "Back up the database before migrating (e.g. mysqldump --single-transaction <database> > backup.sql). Steps are not reversible.";

/**
 * `--status` / `--dry-run` as arguments (`npm run migrate -- --status`) or as npm config
 * (`npm run migrate --status` sets npm_config_status).
 */
export function parseMigrateArgs(args: readonly string[], env: Record<string, string | undefined> = {}): MigrateMode | { error: string } {
  const f = parseMigrateFlags(args, env);
  return "error" in f ? f : f.mode;
}

export interface MigrateFlags {
  mode: MigrateMode;
  /** `--status --json`: one MigrationCheck line, for the updater. */
  json: boolean;
  /** False with `--no-drain`: apply without asking a running supervisor to drain. */
  drain: boolean;
}

const KNOWN_ARGS = ["--status", "--dry-run", "--json", "--no-drain"];

/**
 * Every migrate flag, as arguments or as npm config (`npm run migrate --no-drain` sets npm_config_drain=false).
 * `--json` only goes with `--status`.
 */
export function parseMigrateFlags(args: readonly string[], env: Record<string, string | undefined> = {}): MigrateFlags | { error: string } {
  const flag = (name: string, envName: string) => args.includes(`--${name}`) || env[envName] === "true";
  const unknown = args.filter((a) => !KNOWN_ARGS.includes(a));
  if (unknown.length > 0) return { error: `unknown argument: ${unknown.join(" ")} (use --status, --dry-run, --json or --no-drain)` };
  const status = flag("status", "npm_config_status");
  const dry = flag("dry-run", "npm_config_dry_run");
  if (status && dry) return { error: "use one of --status and --dry-run" };
  const json = flag("json", "npm_config_json");
  if (json && !status) return { error: "--json goes with --status" };
  const noDrain = args.includes("--no-drain") || env.npm_config_drain === "false" || env.npm_config_no_drain === "true";
  return { mode: status ? "status" : dry ? "dry-run" : "apply", json, drain: !noDrain };
}

/** A pending schema step's name: its file name (`0018-foo.sql`), or `0011-baseline`. */
function stepName(p: MigrationStatus["pending"][number]): string {
  return p.step?.file ?? `${pad(p.number)}-baseline`;
}

/**
 * The machine-readable status from the schema status (null on SQLite, which has no schema steps) and the
 * project-key rows left (null when they were not counted: while schema steps are pending, the count reads
 * tables a pending step may create, so the step is reported "after schema steps").
 */
export function migrationCheck(store: MigrationCheck["store"], s: MigrationStatus | null, projectKeyRows: number | null): MigrationCheck {
  const schema = s?.pending.map(stepName) ?? [];
  const project_keys: MigrationCheck["project_keys"] =
    schema.length > 0 || projectKeyRows === null ? "after schema steps" : projectKeyRows > 0 ? "pending" : "done";
  return {
    store,
    schema_state: s?.state ?? null,
    latest: s?.latest ?? null,
    schema_pending: schema,
    refusal: s?.refusal ?? null,
    project_keys,
    project_key_rows: schema.length > 0 ? null : projectKeyRows,
    pending: [...schema, ...(project_keys === "pending" ? [PROJECT_KEYS_STEP] : [])],
  };
}

/** `--status --json` on MySQL over one connection: the schema status, then the project-key rows once it is current. */
export async function mysqlMigrationCheck(db: Queryable, opts: { dir?: string } = {}): Promise<MigrationCheck> {
  const s = await new MysqlMigrations(db, opts).status();
  let rows: number | null = null;
  if (s.pending.length === 0) {
    const all = async (sql: string, params?: readonly unknown[]) => (await db.query(sql, params ? [...params] : []))[0] as Row[];
    const run = async (sql: string, params?: readonly unknown[]) =>
      ((await db.query(sql, params ? [...params] : []))[0] as { affectedRows?: number }).affectedRows ?? 0;
    rows = await countLegacyProjectRows({ all, run }).catch(() => null);
  }
  return migrationCheck("mysql", s, rows);
}

/** Opens one connection for `mysqlMigrationCheck` and closes it. */
export async function migrationCheckCommand(opts: MysqlOptions): Promise<MigrationCheck> {
  const c = await mysql.createConnection({ host: opts.host, port: opts.port, user: opts.user, password: opts.password, database: opts.database });
  try {
    return await mysqlMigrationCheck(c);
  } finally {
    await c.end();
  }
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

// --- while a supervisor runs -----------------------------------------------------------------------------

/** supervisor.json, or null when it is missing or unreadable. */
export async function readSupervisorStatus(file: string): Promise<SupervisorStatus | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as SupervisorStatus;
  } catch {
    return null;
  }
}

/** The pid of the supervisor that wrote `s`, when it is still alive; else null (apply directly). */
export function liveSupervisorPid(s: SupervisorStatus | null, alive: (pid: number) => boolean): number | null {
  const pid = s?.supervisor_pid;
  if (!s || s.state === "stopped" || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  return alive(pid) ? pid : null;
}

/** Writes the request file atomically (a temp file, then rename). */
export async function writeSupervisorRequest(file: string, req: SupervisorRequest): Promise<void> {
  await writeFile(`${file}.tmp`, `${JSON.stringify(req)}\n`);
  await rename(`${file}.tmp`, file);
}

/**
 * `npm run migrate` (apply): through the supervisor (`whileRunning`) when one is live and `--no-drain` was not
 * given; otherwise directly, as before. The status file is only read, never written, on the direct path.
 */
export async function runMigrateApply(o: {
  drain: boolean;
  statusFile: string;
  pidAlive(pid: number): boolean;
  whileRunning(): Promise<number>;
  direct(): Promise<number>;
}): Promise<number> {
  if (!o.drain) return o.direct();
  const live = liveSupervisorPid(await readSupervisorStatus(o.statusFile), o.pidAlive);
  return live === null ? o.direct() : o.whileRunning();
}

export interface MigrateWhileRunningDeps {
  statusFile: string;
  requestFile: string;
  clock: Clock;
  /** How often supervisor.json is read again while waiting. */
  pollMs: number;
  /** Gives up (and cancels) when no child is gone after this long: the updater's drain timeout. */
  drainTimeoutMs: number;
  pidAlive(pid: number): boolean;
  print(line: string): void;
  /** Applies the steps: the target's own migrate from `dir` (its version folder), or here when null. Exit code. */
  apply(dir: string | null): Promise<number>;
  /** This process, named in each request. */
  pid: number;
}

const live = (s: SupervisorStatus, alive: (pid: number) => boolean): number[] =>
  [...(s.child_pid != null ? [s.child_pid] : []), ...(s.draining_pids ?? [])].filter((p) => alive(p));

/**
 * `npm run migrate` with a live supervisor: writes a drain request, waits until the supervisor reports
 * `drained` and no child is live (printing progress), applies the steps, then writes a start request. A failed
 * apply, a drain that outlasts the drain timeout, or a target that changed while waiting writes a cancel
 * request instead, and the supervisor restarts the old revision from its own folder.
 */
export async function migrateWhileRunning(d: MigrateWhileRunningDeps): Promise<number> {
  const first = await readSupervisorStatus(d.statusFile);
  const target = first?.state === "migration_pending" ? (first.target_rev ?? null) : null;
  const request = (action: SupervisorRequest["action"]) =>
    writeSupervisorRequest(d.requestFile, { action, target_rev: target, pid: d.pid, at: d.clock.now().toISOString() });
  const cancel = async (why: string) => {
    await request("cancel");
    d.print(`${why}: asked the factory to restart its old revision (nothing was applied)`);
    return 1;
  };
  await request("drain");
  d.print(
    `the factory is running (supervisor ${first?.supervisor_pid ?? "?"}): asked it to drain${target ? ` for ${target.slice(0, 7)}` : ""}; ` +
      "steps apply once no child is live (use --no-drain to apply without waiting)",
  );
  const start = d.clock.now().getTime();
  let last = "";
  let s: SupervisorStatus | null = first;
  for (;;) {
    s = await readSupervisorStatus(d.statusFile);
    if (s && target && s.target_rev !== target) return cancel(`the target changed to ${short(s.target_rev)} while waiting; run \`npm run migrate\` again`);
    const pids = s ? live(s, d.pidAlive) : [];
    if (s?.state === "migration_pending" && s.migration_phase === "drained" && pids.length === 0) break;
    if (liveSupervisorPid(s, d.pidAlive) === null && s?.state !== "migration_pending") {
      d.print("the supervisor stopped while waiting; run `npm run migrate` again");
      return 1;
    }
    const waited = d.clock.now().getTime() - start;
    if (waited >= d.drainTimeoutMs) return cancel(`gave up after ${Math.round(waited / 1000)} s: children still live (${pids.join(", ") || "none"})`);
    const line = pids.length
      ? `waiting for the factory to drain: ${pids.length} child${pids.length === 1 ? "" : "ren"} live (${pids.join(", ")}), in-flight runs finish first`
      : "waiting for the factory to pick up the drain request";
    if (line !== last) d.print(line);
    last = line;
    await d.clock.sleep(d.pollMs);
  }
  d.print("no child is live: applying the steps");
  const code = await d.apply(s.target_dir ?? null).catch((err: unknown) => {
    d.print(err instanceof Error ? err.message : String(err));
    return 1;
  });
  if (code !== 0) {
    await request("cancel");
    d.print(`applying failed: asked the factory to restart ${short(s.rev)} from its own folder`);
    return code;
  }
  await request("start");
  d.print(`applied: asked the factory to start ${short(s.target_rev ?? s.rev)}`);
  return 0;
}

function short(rev: string | null | undefined): string {
  return rev ? rev.slice(0, 7) : "unknown";
}
