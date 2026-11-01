// `factory migrate` (npm run migrate): status, dry-run and apply over one MySQL connection.

import mysql from "mysql2/promise";
import type { MysqlOptions } from "./mysql-driver.js";
import { type MigrationStatus, MysqlMigrations, type Queryable } from "./migrations.js";

export type MigrateMode = "apply" | "status" | "dry-run";

export const SQLITE_MIGRATE_MESSAGE =
  "SQLite has no migration scripts: it builds the latest schema when the factory opens it. `npm run migrate` is for MySQL only.";

export const BACKUP_REMINDER =
  "Back up the database before migrating (e.g. mysqldump --single-transaction <database> > backup.sql). Steps are not reversible.";

/**
 * `--status` / `--dry-run` as arguments (`npm run migrate -- --status`) or as npm config
 * (`npm run migrate --status` sets npm_config_status).
 */
export function parseMigrateArgs(args: readonly string[], env: Record<string, string | undefined> = {}): MigrateMode | { error: string } {
  const flag = (name: string, envName: string) => args.includes(`--${name}`) || env[envName] === "true";
  const unknown = args.filter((a) => a !== "--status" && a !== "--dry-run");
  if (unknown.length > 0) return { error: `unknown argument: ${unknown.join(" ")} (use --status or --dry-run)` };
  const status = flag("status", "npm_config_status");
  const dry = flag("dry-run", "npm_config_dry_run");
  if (status && dry) return { error: "use one of --status and --dry-run" };
  return status ? "status" : dry ? "dry-run" : "apply";
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
