import { definePlugin } from "../../../../plugin-api.js";
import { storeSql } from "../../../../impl/store/sql/store-sql.js";
import { JournalEngines } from "./journal-engine.js";

// The default ExecutionEngine (docs/plugins/execution-engine.md): the step journal in the store's own database,
// with no setup and no account. Its tables come with the worker's migrations.
export default definePlugin({
  kind: "engine",
  name: "journal",
  default: true,
  create: (c) => new JournalEngines(storeSql(c.store)),
});
