// RFC 0015 M4: the controller's outbox and inbox (§5.2). The inbox dedupes what the controller consumed from
// controller.commands; the outbox carries what its units emit (M5). Additive: no old code reads them.

import { ensureComponentTables } from "../../bus/index.js";
import { defineMigration } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  up: (db) => ensureComponentTables(db, "controller"),
});
