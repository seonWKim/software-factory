// State component (RFC 0015 §7): transactions and SQL drivers, the migration safety kit, schema snapshots.
// Other components import only this file.

export type { Row, SqlDialect, SqlDriver, SqlExecutor, SqlValue } from "./sql-driver.js";
export { backupTables, restoreBackup, tableChecksum, verifyCopy, type BackupManifest, type TableSummary } from "./migrate/backup.js";
export { mysqlSnapshot, sqliteSnapshot } from "./snapshot.js";
export { findDescriptorFiles } from "./discovery.js";
export { defineMigration, migrationSpecProblems, type Dialect, type Migration, type MigrationDb, type MigrationDescriptor } from "./migrate/migration.js";
export { applyMigrations, discoverMigrations, MIGRATIONS_TABLE, pendingMigrations } from "./migrate/runner.js";
export { LEGACY_PREFIX, renameTablesByCopy, tableExists, verifyRenamedTables, type Rename } from "./migrate/copy-tables.js";
export { fingerprintTables, lostRows, type Fingerprint } from "./migrate/rehearse.js";
