import type { TestDatabase, TestDatabaseLease } from "../../interfaces/test-database.js";

/** The PR body line when no test database is configured. */
export const MYSQL_SKIPPED =
  "MySQL checks skipped: no test database is configured (`plugins.test_database` is `none`), so the MySQL tests did not run before push.";

/** No database: the check commands get no SF_TEST_MYSQL_URL, so the MySQL tests skip themselves. */
export class NoTestDatabase implements TestDatabase {
  async create(): Promise<TestDatabaseLease> {
    return { env: {}, redact: [], skipped: MYSQL_SKIPPED, release: async () => undefined };
  }
}
