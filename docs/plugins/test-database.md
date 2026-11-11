# TestDatabase

What it does: gives each check run a fresh, isolated MySQL database and passes `SF_TEST_MYSQL_URL` only to the check commands, never to an agent. The database name is always `sf_test_<run id>`, and the lease drops it when the run ends. That keeps the app's own database separate from test data and prevents a bad SQL statement from hitting anything but the per-run scratch database.

**`mysql-local` is deprecated (decision changed 2026-11-11, owner decision; current).** The MySQL store is deprecated ([factory-store.md](factory-store.md)), so check runs no longer need a MySQL database. Replaced by: `none`, the checked-in default, which stays until the interface goes. Removal plan: the follow-up issue that removes the MySQL store (number added when filed) also removes `mysql-local`, `TEST_MYSQL_URL`, `SF_TEST_MYSQL_URL` and the MySQL tests that read it; then a TestDatabase with only `none` has no reason left, and the interface is removed in the same issue.

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

- **`mysql-local` deprecated** (decision changed 2026-11-11, owner decision). Before: `mysql-local` was the plugin to select once `TEST_MYSQL_URL` and the local test user existed, giving each check run its own MySQL database.
- **The per-run test database** (new decision, 2026-11-03, issue #158). Before: no plugin gave check commands a database, and the MySQL tests ran only in CI. `none` stays the checked-in default until `TEST_MYSQL_URL` is in the secret file and the local test user exists; then `mysql-local` can be selected.
