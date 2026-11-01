import { secretName } from "../../../interfaces/secret-store.js";
import { definePlugin } from "../../../plugin-api.js";
import { SqlFactoryStore } from "../sql/sql-factory-store.js";
import { MysqlDriver } from "./mysql-driver.js";

const MYSQL_PASSWORD = secretName("MYSQL_PASSWORD");

export default definePlugin({
  kind: "store",
  name: "mysql",
  secrets: [{ name: MYSQL_PASSWORD, purpose: "password of the factory's own MySQL user (npm run setup generates it)" }],
  create: async (c) => {
    const s = c.loaded.store;
    if (s.type !== "mysql") throw new Error('store plugin "mysql" needs a store block with type "mysql"');
    const password = await c.secrets.get(MYSQL_PASSWORD);
    if (!password) throw new Error("MYSQL_PASSWORD missing from the secret file (run: npm run setup)");
    const driver = new MysqlDriver({ host: s.host, port: s.port, database: s.database, user: s.user, password: password.reveal() });
    return new SqlFactoryStore(driver, c.clock);
  },
});
