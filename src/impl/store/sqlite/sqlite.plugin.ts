import { join } from "node:path";
import { definePlugin } from "../../../plugin-api.js";
import { SqlFactoryStore } from "../sql/sql-factory-store.js";
import { SqliteDriver } from "./sqlite-driver.js";

export default definePlugin({
  kind: "store",
  name: "sqlite",
  create: (c) => new SqlFactoryStore(new SqliteDriver(join(c.loaded.stateDir, "db", "factory.db")), c.clock),
});
