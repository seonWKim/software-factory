// RFC 0015 M4: inbound's outbox and inbox (§5.2), written in the same transaction as inbound's own rows: a raw
// record and its InboundReceived, a cursor move and the records it read. Additive: no old code reads them.

import { ensureComponentTables } from "../../bus/index.js";
import { defineMigration } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  up: (db) => ensureComponentTables(db, "inbound"),
});
