// RFC 0015 M11: drops `outbound_base_pushes`, replaced by outbound's `push_base` action (M8); the pending rows were
// carried into actions by 20261109T1200. It runs only through `npm run migrate -- --contract`, at least
// CONTRACT_MIN_DAYS after the carry was applied; the runner archives its rows first (D4).

import { defineMigration, dropTables } from "../../state/index.js";

const TABLES = ["outbound_base_pushes"];

export default defineMigration({
  change: "contract",
  tables: TABLES,
  after: ["20261109T1200-outbound-carry-base-pushes"],
  async up(db) {
    await dropTables(db, TABLES);
  },
});
