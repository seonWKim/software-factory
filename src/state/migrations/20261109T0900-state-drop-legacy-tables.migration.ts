// RFC 0015 M11: drops the `legacy_<old>` tables M1's rename left (§12 D2 contract). It runs only through
// `npm run migrate -- --contract`, at least CONTRACT_MIN_DAYS after M1 was applied; the runner archives every table
// that still holds rows first (D4), and refuses without a backup folder.

import { LEGACY_PREFIX, tableExists } from "../migrate/copy-tables.js";
import { defineMigration } from "../migrate/migration.js";
import { ARCHIVE_ONLY, RENAMES } from "./20261108T1300-state-prefix-tables.migration.js";

const LEGACY = [...RENAMES.map((r) => r.from), ...ARCHIVE_ONLY].map((t) => LEGACY_PREFIX + t);

export default defineMigration({
  change: "contract",
  tables: LEGACY,
  after: ["20261108T1300-state-prefix-tables"],
  async up(db) {
    for (const t of LEGACY) if (await tableExists(db, t)) await db.run(`DROP TABLE ${t}`);
  },
});
