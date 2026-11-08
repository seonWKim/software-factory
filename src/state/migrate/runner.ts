// Applies timestamped migrations after the frozen baseline (RFC 0015 §6.3, §12). Each applied migration is a
// row in runtime_schema_migrations (D10). A breaking migration first backs up the tables it names (D1) when
// the caller gives a backup folder.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findDescriptorFiles } from "../discovery.js";
import { backupTables } from "./backup.js";
import { tableExists } from "./copy-tables.js";
import { MIGRATION_FILE, type Migration, type MigrationDb, type MigrationDescriptor } from "./migration.js";

/** The code root: src/ (tests) or dist/ (built); this file is src/state/migrate/runner.ts. */
export const CODE_ROOT = join(import.meta.dirname, "..", "..");

export const MIGRATIONS_TABLE = "runtime_schema_migrations";

const CREATE: Record<MigrationDb["dialect"], string> = {
  sqlite: `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    id            TEXT PRIMARY KEY,
    component     TEXT NOT NULL,
    change_kind   TEXT NOT NULL,
    checksum      TEXT NOT NULL,
    backup_dir    TEXT,
    started_at    TEXT NOT NULL,
    finished_at   TEXT NOT NULL
  )`,
  mysql: `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    id            VARCHAR(191) NOT NULL PRIMARY KEY,
    component     VARCHAR(64) NOT NULL,
    change_kind   VARCHAR(16) NOT NULL,
    checksum      CHAR(64) NOT NULL,
    backup_dir    TEXT,
    started_at    CHAR(24) NOT NULL,
    finished_at   CHAR(24) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
};

let cached: Promise<Migration[]> | null = null;

/** Every `*.migration.ts` (`.js` once built) under the code root, in timestamp order. */
export function discoverMigrations(root: string = CODE_ROOT): Promise<Migration[]> {
  if (root === CODE_ROOT && cached) return cached;
  const load = (async () => {
    const out: Migration[] = [];
    for (const file of findDescriptorFiles(root, MIGRATION_FILE)) {
      const name = file.split(/[\\/]/).pop()!;
      const m = MIGRATION_FILE.exec(name)!;
      const mod = (await import(pathToFileURL(file).href)) as { default?: MigrationDescriptor };
      if (mod.default?.kind !== "migration") throw new Error(`${file}: default export must be defineMigration(...)`);
      out.push({ ...mod.default, id: name.replace(/\.migration\.(?:ts|js)$/, ""), component: m[2]! });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  })();
  if (root === CODE_ROOT) cached = load;
  return load;
}

async function applied(db: MigrationDb): Promise<Set<string>> {
  const has =
    db.dialect === "sqlite"
      ? await db.all("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [MIGRATIONS_TABLE])
      : await db.all("SELECT 1 AS x FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", [MIGRATIONS_TABLE]);
  if (has.length === 0) return new Set();
  return new Set((await db.all(`SELECT id FROM ${MIGRATIONS_TABLE}`)).map((r) => String(r.id)));
}

/** The migrations not yet applied. Read-only. */
export async function pendingMigrations(db: MigrationDb, migrations?: readonly Migration[]): Promise<Migration[]> {
  const all = migrations ?? (await discoverMigrations());
  const done = await applied(db);
  return all.filter((m) => !done.has(m.id));
}

export interface ApplyOptions {
  /** Where breaking migrations back up their tables; null skips the backup (an in-memory or empty database). */
  readonly backupDir: string | null;
  readonly now: () => string;
  readonly print?: (line: string) => void;
  readonly migrations?: readonly Migration[];
}

/** Applies every pending migration in order; returns the ids applied. */
export async function applyMigrations(db: MigrationDb, opts: ApplyOptions): Promise<string[]> {
  const pending = await pendingMigrations(db, opts.migrations);
  if (pending.length === 0) return [];
  await db.run(CREATE[db.dialect]);
  const out: string[] = [];
  for (const m of pending) {
    const started_at = opts.now();
    let backup: string | null = null;
    if (m.change === "breaking" && opts.backupDir !== null && m.tables.length > 0) {
      const present = await existingTables(db, m.tables);
      if (await anyRows(db, present)) {
        backup = join(opts.backupDir, `${started_at.replace(/[:.]/g, "")}-${m.id}`);
        const manifest = await backupTables(db, present, backup, { id: m.id, reason: `before migration ${m.id}`, created_at: started_at });
        const rows = Object.values(manifest.tables).reduce((n, t) => n + t.rows, 0);
        opts.print?.(`backed up ${present.length} tables (${rows} rows) to ${backup}`);
      }
    }
    opts.print?.(`applying ${m.id}`);
    await m.up(db);
    await db.run(
      `INSERT INTO ${MIGRATIONS_TABLE} (id, component, change_kind, checksum, backup_dir, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [m.id, m.component, m.change, createHash("sha256").update(String(m.up)).digest("hex"), backup, started_at, opts.now()],
    );
    out.push(m.id);
  }
  return out;
}

async function existingTables(db: MigrationDb, tables: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const t of tables) if (await tableExists(db, t)) out.push(t);
  return out;
}

async function anyRows(db: MigrationDb, tables: readonly string[]): Promise<boolean> {
  for (const t of tables) if ((await db.all(`SELECT 1 AS x FROM ${t} LIMIT 1`)).length > 0) return true;
  return false;
}
