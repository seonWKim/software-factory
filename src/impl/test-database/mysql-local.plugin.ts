import { secretName } from "../../interfaces/secret-store.js";
import { definePlugin } from "../../plugin-api.js";
import { MysqlLocalTestDatabase } from "./mysql-local-test-database.js";

const TEST_MYSQL_URL = secretName("TEST_MYSQL_URL");

export default definePlugin({
  kind: "test_database",
  name: "mysql-local",
  secrets: [
    {
      name: TEST_MYSQL_URL,
      purpose: "admin URL (mysql://user:password@host:port) of the local test-only MySQL user that may create and drop sf_test_* databases",
    },
  ],
  create: async (c) => {
    const secret = await c.secrets.get(TEST_MYSQL_URL);
    if (!secret) {
      throw new Error(
        'plugins.test_database selects "mysql-local", but TEST_MYSQL_URL is missing from the secret file (SET_UP.md, "Local test MySQL"). ' +
          'Set it, or select "none" (docs/plugins.md, TestDatabase)',
      );
    }
    // The URL's shape is checked when the first run asks for a database; its error never names the URL.
    return new MysqlLocalTestDatabase(() => secret.reveal());
  },
});
