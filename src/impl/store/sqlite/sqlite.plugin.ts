import { join } from "node:path";
import { factoryRunning } from "../../../migrate-drain.js";
import { definePlugin } from "../../../plugin-api.js";
import { SqlFactoryStore } from "../sql/sql-factory-store.js";
import { SqliteDriver } from "./sqlite-driver.js";

export default definePlugin({
  kind: "store",
  name: "sqlite",
  // A breaking migration applies on open when no factory process runs; else the open refuses in one line.
  create: (c) =>
    new SqlFactoryStore(
      new SqliteDriver(join(c.loaded.stateDir, "db", "factory.db"), { canApplyBreaking: async () => !(await factoryRunning(c.loaded.stateDir)) }),
      c.clock,
    ),
});
