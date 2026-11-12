# TestDatabase

What it does: the throwaway database the pre-push checks may use. Its one plugin, `none`, gives the check commands no database, so the MySQL tests, which read `SF_TEST_MYSQL_URL`, skip themselves before push and the PR body says so.

**Only `none` remains; the local MySQL plugin is removed (decision changed 2026-11-12, issue #599 phase 1; current).** The decision that changed: the removal plan, which kept the deprecated local MySQL plugin until the MySQL store was removed. The plugin could no longer be selected by the checked-in config (`none`), so it, its class, its tests and its secret are removed now, ahead of the store. The TestDatabase interface and `none` stay until the later phases of #599 remove them; the MySQL store's tests keep reading `SF_TEST_MYSQL_URL`, which CI sets itself.

Plugins:

- `none`: `NoTestDatabase`. Does nothing and leaves MySQL checks to skip themselves because there is no `SF_TEST_MYSQL_URL` in the check environment.
  - Enable: `"plugins": { "test_database": "none", ... }`, or leave the key out to use the checked-in default.
  - Secrets: none.

Switch back / disable: there is no other plugin; `none` is the default when the key is left out.

## History

- **`mysql-local` removed now** (decision changed 2026-11-12, issue #599 phase 1). Before: `mysql-local` was deprecated and was to be removed, with `TEST_MYSQL_URL`, by the follow-up issue that removes the MySQL store.
- **`mysql-local` deprecated** (decision changed 2026-11-11, owner decision). Before: `mysql-local` was the plugin to select once `TEST_MYSQL_URL` and the local test user existed, giving each check run its own MySQL database.
- **The per-run test database** (new decision, 2026-11-03, issue #158). Before: no plugin gave check commands a database, and the MySQL tests ran only in CI. `none` stays the checked-in default until `TEST_MYSQL_URL` is in the secret file and the local test user exists; then `mysql-local` can be selected.
