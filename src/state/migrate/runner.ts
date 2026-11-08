// Applies timestamped migrations after the frozen baseline (RFC 0015 §6.3, §12). Each applied migration is a
// row in runtime_schema_migrations (D10). A breaking or contract migration first backs up the tables it names
// (D1, D4) when the caller gives a backup folder, and a breaking one is verified right after it runs (D2).

import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findDescriptorFiles, forgetOnFailure } from "../discovery.js";
import { backupTables } from "./backup.js";
import { tableExists } from "./copy-tables.js";
import { CONTRACT_MIN_DAYS, MIGRATION_FILE, type Migration, type MigrationDb, type MigrationDescriptor } from "./migration.js";

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
  return root === CODE_ROOT ? (cached = forgetOnFailure(load, () => (cached = null))) : load;
}

async function applied(db: MigrationDb): Promise<Set<string>> {
  const has =
    db.dialect === "sqlite"
      ? await db.all("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [MIGRATIONS_TABLE])
      : await db.all("SELECT 1 AS x FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", [MIGRATIONS_TABLE]);
  if (has.length === 0) return new Set();
  return new Set((await db.all(`SELECT id FROM ${MIGRATIONS_TABLE}`)).map((r) => String(r.id)));
}

/**
 * The migrations not yet applied. Read-only. Contract migrations are left out unless `contract` is set: they run
 * only when the owner asks (`npm run migrate -- --contract`), so they never hold up a start or an update.
 */
export async function pendingMigrations(db: MigrationDb, migrations?: readonly Migration[], contract = false): Promise<Migration[]> {
  const all = migrations ?? (await discoverMigrations());
  const done = await applied(db);
  return all.filter((m) => !done.has(m.id) && (m.change === "contract") === contract);
}

/**
 * Why a contract migration may not run yet: a migration it follows is not applied, or was applied less than
 * CONTRACT_MIN_DAYS ago (the down path of D9 stays open that long). Null when it may run.
 */
export async function contractNotReady(db: MigrationDb, m: Migration, now: string): Promise<string | null> {
  for (const id of m.after ?? []) {
    const [row] = await db.all(`SELECT finished_at FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [id]);
    if (!row) return `${id} is not applied`;
    const days = (Date.parse(now) - Date.parse(String(row.finished_at))) / 86_400_000;
    if (days < CONTRACT_MIN_DAYS) return `${id} was applied ${Math.floor(days)} days ago; contract waits ${CONTRACT_MIN_DAYS}`;
  }
  return null;
}

export interface ApplyOptions {
  /** Where breaking migrations back up their tables; null skips the backup (an in-memory or empty database). */
  readonly backupDir: string | null;
  readonly now: () => string;
  readonly print?: (line: string) => void;
  readonly migrations?: readonly Migration[];
  /** Runs the pending contract migrations instead (and only those whose `after` is old enough). */
  readonly contract?: boolean;
}

/** Applies every pending migration in order; returns the ids applied. */
export async function applyMigrations(db: MigrationDb, opts: ApplyOptions): Promise<string[]> {
  const pending = await pendingMigrations(db, opts.migrations, opts.contract);
  if (pending.length === 0) return [];
  await db.run(CREATE[db.dialect]);
  const out: string[] = [];
  for (const m of pending) {
    const started_at = opts.now();
    const wait = m.change === "contract" ? await contractNotReady(db, m, started_at) : null;
    if (wait) {
      opts.print?.(`skipping ${m.id}: ${wait}`);
      continue;
    }
    let backup: string | null = null;
    if (m.change !== "additive" && m.tables.length > 0) {
      const present = await existingTables(db, m.tables);
      const rows = await anyRows(db, present);
      // D4: a contract never drops a row that was not archived first.
      if (rows && opts.backupDir === null && m.change === "contract") throw new Error(`${m.id} drops tables with rows but has no backup folder to archive them to`);
      if (rows && opts.backupDir !== null) {
        backup = join(opts.backupDir, `${started_at.replace(/[:.]/g, "")}-${m.id}`);
        const manifest = await backupTables(db, present, backup, { id: m.id, reason: `before migration ${m.id}`, created_at: started_at });
        const rows = Object.values(manifest.tables).reduce((n, t) => n + t.rows, 0);
        opts.print?.(`backed up ${present.length} tables (${rows} rows) to ${backup}`);
      }
    }
    opts.print?.(`applying ${m.id}`);
    await m.up(db);
    const problems = m.verify ? await m.verify(db) : [];
    if (problems.length > 0) throw new Error(`${m.id} failed verification, not recorded as applied: ${problems.join("; ")}`);
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
