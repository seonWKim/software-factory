// RFC 0015 M11: drops the two command tables M4's merge left as `legacy_*` (§12 D2 contract, D7). It runs only
// through `npm run migrate -- --contract`, at least CONTRACT_MIN_DAYS after the merge was applied; the runner
// archives their rows first (D4).

import { LEGACY_PREFIX, defineMigration, dropTables } from "../../state/index.js";
import { APPS, COMMANDS } from "./20261108T2200-inbound-merge-commands.migration.js";

const LEGACY = [COMMANDS, APPS].map((t) => LEGACY_PREFIX + t);

export default defineMigration({
  change: "contract",
  tables: LEGACY,
  after: ["20261108T2200-inbound-merge-commands"],
  async up(db) {
    await dropTables(db, LEGACY);
  },
});
