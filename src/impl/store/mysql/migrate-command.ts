// `factory migrate` (npm run migrate): status, dry-run, rehearse and apply over one MySQL connection.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { fingerprintTables, lostRows, type Row } from "../../../state/index.js";
import type { MysqlOptions } from "./mysql-driver.js";
import { type MigrationStatus, MysqlMigrations, mysqlMigrationDb, type Queryable } from "./migrations.js";

/** `contract`: only the contract migrations that drop `legacy_*` (RFC 0015 §12 D2); the migrate command runs it. */
export type MigrateMode = "apply" | "status" | "dry-run" | "rehearse" | "contract";

export const SQLITE_MIGRATE_MESSAGE =
  "SQLite has no schema scripts: the factory applies additive migrations when it opens the database. `npm run migrate` applies the breaking ones (they rename tables, so a running factory drains first) and the data steps (project keys).";

export const BACKUP_REMINDER =
  "Back up the database before migrating (e.g. mysqldump --single-transaction <database> > backup.sql), and rehearse first (npm run migrate -- --rehearse). Numbered steps are not reversible.";

/** `--copy-from-mysql [--dry-run] [--replace]`: copy the MySQL store into SQLite (copy-to-sqlite.ts). */
export interface CopyFromMysql {
  readonly copy: "from-mysql";
  readonly dryRun: boolean;
  readonly replace: boolean;
}

/**
 * `--status` / `--dry-run` / `--rehearse` / `--contract` / `--copy-from-mysql` as arguments (`npm run migrate --
 * --status`) or as npm config (`npm run migrate --status` sets npm_config_status). `--dry-run` and `--replace`
 * also go with `--copy-from-mysql`.
 */
export function parseMigrateArgs(args: readonly string[], env: Record<string, string | undefined> = {}): MigrateMode | CopyFromMysql | { error: string } {
  const flag = (name: string) => args.includes(`--${name}`) || env[`npm_config_${name.replaceAll("-", "_")}`] === "true";
  const names = ["status", "dry-run", "rehearse", "contract"] as const;
  const known: readonly string[] = [...names, "copy-from-mysql", "replace"];
  const unknown = args.filter((a) => !known.some((n) => a === `--${n}`));
  if (unknown.length > 0) return { error: `unknown argument: ${unknown.join(" ")} (use --status, --dry-run, --rehearse, --contract or --copy-from-mysql)` };
  const modes = names.filter((m) => flag(m));
  if (flag("copy-from-mysql")) {
    if (modes.some((m) => m !== "dry-run")) return { error: "--copy-from-mysql goes only with --dry-run and --replace" };
    return { copy: "from-mysql", dryRun: modes.includes("dry-run"), replace: flag("replace") };
  }
  if (flag("replace")) return { error: "--replace goes with --copy-from-mysql" };
  if (modes.length > 1) return { error: "use one of --status, --dry-run, --rehearse and --contract" };
  return modes[0] ?? "apply";
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
  opts: { dir?: string; backupDir?: string | null } = {},
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
    if (mode === "rehearse") throw new Error("rehearse runs through migrateCommand: it needs its own copy of the database");
    if (mode === "contract") throw new Error("contract runs through the migrate command (applyMigrations with contract)");
    print(BACKUP_REMINDER);
    const s = await m.apply(print);
    print(s.pending.length === 0 ? `up to date at state ${s.state}: nothing to apply` : `done: state ${s.pending.at(-1)!.number}`);
    return 0;
  } catch (err) {
    print(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/**
 * Opens one connection for `runMigrate` and closes it. `backupDir`: where a breaking migration backs up the
 * tables it changes before it runs (RFC 0015 §12 D1).
 */
export async function migrateCommand(opts: MysqlOptions, mode: MigrateMode, print: (line: string) => void, backupDir: string | null = null): Promise<number> {
  if (mode === "rehearse") return rehearse(opts, print);
  const c = await connect(opts, opts.database);
  try {
    return await runMigrate(c, mode, print, { backupDir });
  } finally {
    await c.end();
  }
}

function connect(opts: MysqlOptions, database: string): Promise<mysql.Connection> {
  return mysql.createConnection({ host: opts.host, port: opts.port, user: opts.user, password: opts.password, database });
}

/**
 * D8: copies the database to `<database>_rehearsal` (one consistent snapshot), applies every pending step and
 * migration there, checks that no row was lost or changed, and drops the copy. The live database is only read.
 */
async function rehearse(opts: MysqlOptions, print: (line: string) => void): Promise<number> {
  const copy = `${opts.database}_rehearsal`;
  const src = await connect(opts, opts.database);
  const backups = await mkdtemp(join(tmpdir(), "sf-rehearsal-"));
  let created = false;
  try {
    try {
      await src.query(`DROP DATABASE IF EXISTS \`${copy}\``);
      await src.query(`CREATE DATABASE \`${copy}\``);
      created = true;
    } catch (err) {
      print(`cannot create the rehearsal database ${copy}: ${err instanceof Error ? err.message : String(err)}`);
      print(`grant it once: GRANT ALL ON \`${copy}\`.* TO '${opts.user}'@'%';`);
      return 1;
    }
    const [rows] = await src.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY 1");
    const tables = (rows as Row[]).map((r) => String(r.t));
    await src.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of tables) {
      const [[ddl]] = (await src.query(`SHOW CREATE TABLE \`${t}\``)) as unknown as [Row[]];
      await src.query(String(ddl!["Create Table"]).replace(/^CREATE TABLE `/, `CREATE TABLE \`${copy}\`.\``));
    }
    await src.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
    for (const t of tables) await src.query(`INSERT INTO \`${copy}\`.\`${t}\` SELECT * FROM \`${t}\``);
    await src.query("COMMIT");
    print(`copied ${tables.length} tables to ${copy}`);

    const c = await connect(opts, copy);
    try {
      const before = await fingerprintTables(mysqlMigrationDb(c));
      const code = await runMigrate(c, "apply", print, { backupDir: backups });
      if (code !== 0) return code;
      const lost = await lostRows(mysqlMigrationDb(c), before);
      for (const line of lost) print(`lost: ${line}`);
      print(lost.length === 0 ? `rehearsal passed: every row of ${before.size} tables is still there` : "rehearsal FAILED: do not migrate the live database");
      return lost.length === 0 ? 0 : 1;
    } finally {
      await c.end();
    }
  } finally {
    if (created) await src.query(`DROP DATABASE IF EXISTS \`${copy}\``);
    await src.end();
    await rm(backups, { recursive: true, force: true });
  }
}

/** The pending schema step file names, read-only (for `migrate --status --json`); a refusal is one entry. */
export async function pendingStepNames(opts: MysqlOptions): Promise<string[]> {
  const c = await connect(opts, opts.database);
  try {
    const s = await new MysqlMigrations(c).status();
    if (s.state !== null && s.state > s.latest) return [];
    if (s.refusal) return [`refused: ${s.refusal}`];
    return s.pending.map((p) => p.label);
  } finally {
    await c.end();
  }
}
