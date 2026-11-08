import { SqlBus } from "../../bus/plugins/sql/sql-bus.js";
import { definePlugin } from "../../plugin-api.js";

// The default: the topic tables, cursors, retries and dead letters live in the store's own database, so a solo
// factory needs no broker and an enterprise one shares the MySQL store (docs/plugins/event-bus.md). The descriptor
// stays in src/impl until plugin-api.ts moves into a component (M11); a component file importing it would be a
// new dependency-direction violation.
export default definePlugin({
  kind: "bus",
  name: "sql",
  default: true,
  create: () => new SqlBus(),
});
