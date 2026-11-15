// RFC 0015 M11: the one contract migration for `legacy_*` tables (§12 D2), SQLite only. It runs only through
// `npm run migrate -- --contract` (`--dry-run` prints what it would do and rolls back), at least CONTRACT_MIN_DAYS
// after every migration that left legacy tables: M1's prefix rename, M4's command merge and the change-ref rebuild.
// It finds every legacy table, copies each row whose key is missing from its current table, checks the copy, and
// drops them all; a legacy table missing from LEGACY_TABLES stops it before anything changes. The runner archives
// every table that still holds rows first (D4), and refuses without a backup folder.

import { LEGACY_PREFIX, dropLegacyTables, type LegacySource } from "../migrate/copy-tables.js";
import { defineMigration } from "../migrate/migration.js";
import { printerOf } from "../migrate/runner.js";
import { ARCHIVE_ONLY, RENAMES } from "./20261108T1300-state-prefix-tables.migration.js";

/** Tables with no replacement: their rows are archived, never copied. */
const RETIRED: Readonly<Record<string, string>> = {
  ...Object.fromEntries(ARCHIVE_ONLY.map((t) => [t, "no code read it"])),
  base_pushes: "replaced by outbound push_base actions; 20261109T1200 carried the pending ones",
  local_users: "the owner moved to identity_owner and the table was dropped (20261113T1500)",
};

/** M4 (20261108T2200) merged both command tables into inbound_commands, keyed by command_key; ids as it built them. */
function intoCommands(from: string, keyColumn: string, columns: readonly string[]): LegacySource {
  const id = `'cmd_${from}_' || l.seq`;
  const origin = from === "command_inbox" ? "CASE WHEN l.command_key LIKE 'github:%' THEN 'github' WHEN l.command_key LIKE 'app:%' THEN 'app' ELSE 'cli' END" : "'app'";
  return {
    to: "inbound_commands",
    key: { command_key: `l.${keyColumn}` },
    values: { id, origin, command_key: `l.${keyColumn}`, ...Object.fromEntries(columns.map((c) => [c, `l.${c}`])), legacy_table: `'${from}'`, legacy_seq: "l.seq" },
  };
}
const COMMANDS = intoCommands("command_inbox", "command_key", ["actor", "command", "args", "created_at", "mirror", "mirrored_at"]);
const APPS = intoCommands("app_command_requests", "request_key", ["actor", "command", "args", "created_at", "handled_at", "refusal"]);

/** Every legacy table any migration leaves, and where its rows live now. Later entries win over the plain renames. */
export const LEGACY_TABLES: Readonly<Record<string, LegacySource>> = Object.fromEntries(
  Object.entries({
    ...Object.fromEntries(RENAMES.map((r) => [r.from, { to: r.to }])),
    ...Object.fromEntries(Object.entries(RETIRED).map(([t, why]) => [t, { to: null, why }])),
    command_inbox: COMMANDS,
    inbound_commands: COMMANDS,
    app_command_requests: APPS,
    inbound_app_requests: APPS,
    controller_work_items: { to: "controller_work_items" },
    controller_unreviewed_merges: { to: "controller_unreviewed_merges" },
  } satisfies Record<string, LegacySource>).map(([t, s]) => [LEGACY_PREFIX + t, s]),
);

export default defineMigration({
  change: "contract",
  tables: Object.keys(LEGACY_TABLES),
  after: ["20261108T1300-state-prefix-tables", "20261108T2200-inbound-merge-commands", "20261112T1200-controller-change-ref-only"],
  async up(db) {
    await dropLegacyTables(db, LEGACY_TABLES, printerOf(db));
  },
});
