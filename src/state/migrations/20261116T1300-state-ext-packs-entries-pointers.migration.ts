// Imported MCP servers become pointers (design 11-plugin-import and 11-packs): `ext_packs_entries` is rebuilt with
// `source`, `source_file` and `source_key` (an imported server's source label, the file that holds it and its key
// there), `descriptor` nullable (a pointer row keeps no copy) and unique on (source, source_file, source_key) too.
// SQLite cannot make a column nullable in place, so the old table is renamed to `legacy_ext_packs_entries` and kept
// until the contract migration (20261109T0900) archives and drops it after the owner confirms; nothing is dropped here.
//
// A pack's entry (`factory pack add`) is copied as it is. A copied MCP server the old import stored (its descriptor's
// `source` is `claude` or `codex`) becomes one pointer per name, from its newest row (the current one):
// `~/.claude.json` or `~/.codex/config.toml`, key = the descriptor's name, descriptor NULL. Its entry is read there now:
// - found with the same hash: description_hash and status are kept, so its approvals still hold;
// - found with another hash: the new hash, status `pending` (owner answer 5): the old approval no longer applies;
// - not found: status `missing`, its hash kept; nothing runs it.
// The older rows of the name stay in the legacy table. Breaking: the code reads pointers in the same release. A rerun
// is a no-op. Runs inside the migration transaction; reads the user's config files, writes none.

import { homedir } from "node:os";
import { join } from "node:path";
import { readPointer } from "../../packs/pack-entries.store.js";
import { LEGACY_PREFIX, tableExists } from "../migrate/copy-tables.js";
import { type MigrationDb, defineMigration } from "../migrate/migration.js";

const TABLE = "ext_packs_entries";
const LEGACY = `${LEGACY_PREFIX}${TABLE}`;

const CREATE = `CREATE TABLE ${TABLE} (
    id                TEXT PRIMARY KEY,
    kind              TEXT NOT NULL,
    name              TEXT NOT NULL,
    description_hash  TEXT NOT NULL,
    module_hash       TEXT,
    descriptor        TEXT,
    credential_name   TEXT,
    source            TEXT,
    source_file       TEXT,
    source_key        TEXT,
    status            TEXT NOT NULL,
    added_by          TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (kind, name, description_hash),
    UNIQUE (source, source_file, source_key)
  )`;

const COPIED = ["id", "kind", "name", "description_hash", "module_hash", "descriptor", "credential_name", "status", "added_by", "created_at", "updated_at"] as const;

/** The file the old import read each source from. */
const SOURCE_FILES: Readonly<Record<string, (home: string) => string>> = {
  claude: (home) => join(home, ".claude.json"),
  codex: (home) => join(home, ".codex", "config.toml"),
};

type Row = Record<string, unknown>;

/** The source of a copied imported MCP server: its descriptor's `source`; null for a pack's entry. */
function importedSource(r: Row): string | null {
  if (r.kind !== "mcp_server") return null;
  try {
    const source = (JSON.parse(String(r.descriptor)) as { source?: unknown }).source;
    return typeof source === "string" && Object.hasOwn(SOURCE_FILES, source) ? source : null;
  } catch {
    return null;
  }
}

/** The legacy rows: each pack entry, and the newest row of each imported server's name. */
async function plan(db: MigrationDb): Promise<{ pack: Row[]; imported: Row[] }> {
  const rows = await db.all(`SELECT ${COPIED.join(", ")} FROM ${LEGACY} ORDER BY created_at DESC, id DESC`);
  const pack: Row[] = [];
  const newest = new Map<string, Row>();
  for (const r of rows) {
    if (importedSource(r) === null) pack.push(r);
    else if (!newest.has(String(r.name))) newest.set(String(r.name), r);
  }
  return { pack, imported: [...newest.values()] };
}

export default defineMigration({
  change: "breaking",
  tables: [TABLE],
  async up(db) {
    if (await tableExists(db, LEGACY)) return;
    await db.run(`ALTER TABLE ${TABLE} RENAME TO ${LEGACY}`);
    await db.run(CREATE);
    const { pack, imported } = await plan(db);
    const marks = COPIED.map(() => "?").join(", ");
    for (const r of pack) await db.run(`INSERT INTO ${TABLE} (${COPIED.join(", ")}) VALUES (${marks})`, COPIED.map((c) => r[c] as never));
    const home = homedir();
    for (const r of imported) {
      const source = importedSource(r)!;
      const key = String((JSON.parse(String(r.descriptor)) as { name?: unknown }).name ?? r.name);
      const file = SOURCE_FILES[source]!(home);
      const live = await readPointer({ source, file, key });
      const hash = live === null || live.description_hash === r.description_hash ? String(r.description_hash) : live.description_hash;
      const status = live === null ? "missing" : hash === r.description_hash ? String(r.status) : "pending";
      await db.run(
        `INSERT INTO ${TABLE} (id, kind, name, description_hash, module_hash, descriptor, credential_name, source, source_file, source_key, status, added_by, created_at, updated_at)
         VALUES (?, 'mcp_server', ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        [String(r.id), String(r.name), hash, source, file, key, status, String(r.added_by), String(r.created_at), String(r.updated_at)],
      );
    }
  },
  verify: (db: MigrationDb) => verify(db),
});

/** Every pack entry is copied as it was; each imported name is one pointer row with no descriptor; nothing else. */
async function verify(db: MigrationDb): Promise<string[]> {
  if (!(await tableExists(db, LEGACY))) return [`${TABLE}: expected ${LEGACY}`];
  const { pack, imported } = await plan(db);
  const out: string[] = [];
  const copied = await db.all(`SELECT ${COPIED.join(", ")} FROM ${TABLE} WHERE source_file IS NULL ORDER BY created_at DESC, id DESC`);
  if (JSON.stringify(copied) !== JSON.stringify(pack)) out.push(`${TABLE}: the pack entries differ from ${LEGACY}`);
  const pointers = await db.all(`SELECT id, name, descriptor FROM ${TABLE} WHERE source_file IS NOT NULL ORDER BY name`);
  const want = imported.map((r) => ({ id: r.id, name: r.name, descriptor: null })).sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
  if (JSON.stringify(pointers) !== JSON.stringify(want)) out.push(`${TABLE}: the pointer rows differ from the imported servers of ${LEGACY}`);
  return out;
}
