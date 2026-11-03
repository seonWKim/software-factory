# TestDatabase

What it does: gives each check run a fresh, isolated MySQL database and passes `SF_TEST_MYSQL_URL` only to the check commands, never to an agent. The database name is always `sf_test_<run id>`, and the lease drops it when the run ends. That keeps the app's own database separate from test data and prevents a bad SQL statement from hitting anything but the per-run scratch database.

Plugins:

- `mysql-local`: `MysqlLocalTestDatabase`. Connects to a local MySQL admin URL from the secret file and creates one `sf_test_*` database per run, then drops it on release.
  - Enable: `"plugins": { "test_database": "mysql-local", ... }`
  - Secrets: `TEST_MYSQL_URL`.
  - Startup failure: if `TEST_MYSQL_URL` is missing, `build()` fails with a message naming `plugins.test_database` and suggesting the `none` plugin.
- `none`: `NoTestDatabase`. Does nothing and leaves MySQL checks to skip themselves because there is no `SF_TEST_MYSQL_URL` in the check environment.
  - Enable: `"plugins": { "test_database": "none", ... }`, or leave the key out to use the checked-in default.
  - Secrets: none.

Switch back / disable: set `plugins.test_database` to the other plugin, or delete the key to restore the default (`none`).

## History

- **The per-run test database** (new decision, 2026-11-03, issue #158). Before: no plugin gave check commands a database, and the MySQL tests ran only in CI. `none` stays the checked-in default until `TEST_MYSQL_URL` is in the secret file and the local test user exists; then `mysql-local` can be selected.
