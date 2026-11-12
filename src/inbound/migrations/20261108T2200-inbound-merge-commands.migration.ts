// RFC 0015 M4, rule D7: the command inbox (`inbound_commands`, was command_inbox) and the app command requests
// (`inbound_app_requests`, was app_command_requests) merge into one `inbound_commands`. Breaking: the store reads
// the merged table in the same release.
//
// - Every row of both tables is copied with every column; `legacy_table` + `legacy_seq` trace it to its source and
//   its id is deterministic (`cmd_<legacy table>_<legacy seq>`), so a rerun builds the same rows.
// - Both keys (`command_key`, `request_key`) go into the one unique `command_key`. A collision stops the
//   migration before anything is copied, instead of dropping a row.
// - Command rows keep their `seq`, so the `commands` cursor still marks what was handled (D6). App requests get
//   `seq = <highest command seq> + <their old seq>`: above every command row and above every old request seq, so
//   a new row's seq never equals an old request's seq (refusal markers and state changes name requests by seq;
//   migrated requests keep naming theirs by `legacy_seq`).
// - The copy is verified per source over every old column; then both old tables become `legacy_inbound_commands`
//   and `legacy_inbound_app_requests` and the new one takes the name, in one step (one transaction). They stay until
//   a contract migration after the owner confirms (§12).

import { LEGACY_PREFIX, defineMigration, tableExists, verifyCopy, type MigrationDb } from "../../state/index.js";

export const COMMANDS = "inbound_commands";
export const APPS = "inbound_app_requests";
const NEXT = "inbound_commands_next";
/** The source names RFC 0015 §12 D7 records in `legacy_table`. */
export const FROM_COMMANDS = "command_inbox";
export const FROM_APPS = "app_command_requests";

const DDL = `CREATE TABLE ${NEXT} (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT NOT NULL UNIQUE,
    origin        TEXT NOT NULL,
    command_key   TEXT NOT NULL UNIQUE,
    actor         TEXT NOT NULL,
    command       TEXT NOT NULL,
    args          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    handled_at    TEXT,
    refusal       TEXT,
    mirror        INTEGER NOT NULL DEFAULT 0,
    mirrored_at   TEXT,
    passport_id   TEXT,
    legacy_table  TEXT,
    legacy_seq    INTEGER
  )`;

/** SQLite names indexes per database; the legacy table keeps `inbound_commands_mirror`. */
const SQLITE_INDEXES = [
  `CREATE INDEX inbound_commands_pending ON ${COMMANDS} (handled_at, created_at)`,
  `CREATE INDEX inbound_commands_unmirrored ON ${COMMANDS} (mirror, mirrored_at, seq)`,
];

function concat(prefix: string, column: string): string {
  return `'${prefix}' || ${column}`;
}

/** Old column → merged column, per source; verified row for row. */
const COMMAND_COLUMNS = {
  seq: "legacy_seq",
  command_key: "command_key",
  actor: "actor",
  command: "command",
  args: "args",
  created_at: "created_at",
  mirror: "mirror",
  mirrored_at: "mirrored_at",
} as const;
const APP_COLUMNS = {
  seq: "legacy_seq",
  request_key: "command_key",
  actor: "actor",
  command: "command",
  args: "args",
  created_at: "created_at",
  handled_at: "handled_at",
  refusal: "refusal",
} as const;

async function merged(db: MigrationDb): Promise<boolean> {
  return tableExists(db, LEGACY_PREFIX + COMMANDS);
}

async function copy(db: MigrationDb): Promise<void> {
  const [clash] = await db.all(`SELECT a.request_key AS k FROM ${APPS} a JOIN ${COMMANDS} c ON c.command_key = a.request_key LIMIT 1`);
  if (clash) throw new Error(`cannot merge ${APPS} into ${COMMANDS}: key ${String(clash.k)} is in both; no row was copied`);
  if (await tableExists(db, NEXT)) await db.run(`DELETE FROM ${NEXT}`);
  else await db.run(DDL);
  await db.run(
    `INSERT INTO ${NEXT} (seq, id, origin, command_key, actor, command, args, created_at, mirror, mirrored_at, legacy_table, legacy_seq)
     SELECT seq, ${concat(`cmd_${FROM_COMMANDS}_`, "seq")},
       CASE WHEN command_key LIKE 'github:%' THEN 'github' WHEN command_key LIKE 'app:%' THEN 'app' ELSE 'cli' END,
       command_key, actor, command, args, created_at, mirror, mirrored_at, '${FROM_COMMANDS}', seq
     FROM ${COMMANDS}`,
  );
  const [top] = await db.all(`SELECT COALESCE(MAX(seq), 0) AS n FROM ${COMMANDS}`);
  await db.run(
    `INSERT INTO ${NEXT} (seq, id, origin, command_key, actor, command, args, created_at, handled_at, refusal, legacy_table, legacy_seq)
     SELECT ? + seq, ${concat(`cmd_${FROM_APPS}_`, "seq")}, 'app', request_key, actor, command, args, created_at, handled_at, refusal, '${FROM_APPS}', seq
     FROM ${APPS}`,
    [Number(top?.n ?? 0)],
  );
}

async function swap(db: MigrationDb): Promise<void> {
  await db.run(`ALTER TABLE ${COMMANDS} RENAME TO ${LEGACY_PREFIX}${COMMANDS}`);
  await db.run(`ALTER TABLE ${APPS} RENAME TO ${LEGACY_PREFIX}${APPS}`);
  await db.run(`ALTER TABLE ${NEXT} RENAME TO ${COMMANDS}`);
  for (const sql of SQLITE_INDEXES) await db.run(sql);
}

/** Every old row is in the merged table over every old column, and nothing else is. */
async function check(db: MigrationDb, commands: string, apps: string, into: string): Promise<string[]> {
  const out = [
    ...(await verifyCopy(db, commands, into, COMMAND_COLUMNS, { column: "legacy_table", value: FROM_COMMANDS })),
    ...(await verifyCopy(db, apps, into, APP_COLUMNS, { column: "legacy_table", value: FROM_APPS })),
  ];
  const count = async (t: string) => Number((await db.all(`SELECT COUNT(*) AS n FROM ${t}`))[0]?.n ?? 0);
  const [a, b, c] = [await count(commands), await count(apps), await count(into)];
  if (c !== a + b) out.push(`${into} has ${c} rows, expected ${a} + ${b}`);
  return out;
}

export default defineMigration({
  change: "breaking",
  tables: [COMMANDS, APPS],
  async up(db) {
    if (await merged(db)) return;
    await copy(db);
    const problems = await check(db, COMMANDS, APPS, NEXT);
    if (problems.length > 0) throw new Error(`merge of ${COMMANDS} and ${APPS} failed verification: ${problems.join("; ")}`);
    await swap(db);
  },
  verify: (db) => check(db, LEGACY_PREFIX + COMMANDS, LEGACY_PREFIX + APPS, COMMANDS),
});
