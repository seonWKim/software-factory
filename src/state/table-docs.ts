// What each store table State declares holds, one line each: the migration bookkeeping, the extension packs, and the
// `legacy_` copies its table-prefix rename (RFC 0015 M1) and later rebuilds keep until the contract migration drops
// them. Read by the Data page (src/ui/data.ts, design 09-dashboard-app); checked by tests/data-table-docs.test.ts.

import { LEGACY_PREFIX } from "./migrate/copy-tables.js";
import { ARCHIVE_ONLY, RENAMES } from "./migrations/20261108T1300-state-prefix-tables.migration.js";

const copyOf = (table: string) => `Old copy of ${table} from before a table rename or rebuild, kept until the contract migration drops it.`;

export const TABLE_DOCS: Readonly<Record<string, string>> = {
  schema_migrations: "The numbered baseline schema steps applied to this store.",
  ext_packs_entries: "Extension packs (tools and skills) added to the factory, with their approval status.",
  ext_packs_approvals: "Every approval or refusal of an extension pack, by whom and when.",
  ...Object.fromEntries(RENAMES.map((r) => [LEGACY_PREFIX + r.from, copyOf(r.to)])),
  ...Object.fromEntries(ARCHIVE_ONLY.map((t) => [LEGACY_PREFIX + t, `Archive of the retired ${t} table; no code reads it.`])),
  legacy_controller_work_items: copyOf("controller_work_items"),
  legacy_controller_unreviewed_merges: copyOf("controller_unreviewed_merges"),
  legacy_inbound_commands: copyOf("inbound_commands"),
  legacy_inbound_app_requests: copyOf("inbound_commands"),
};
