// State component (RFC 0015 §7): transactions and SQL drivers, the migration safety kit, schema snapshots.
// Other components import only this file.

export type { Row, SqlDialect, SqlDriver, SqlExecutor, SqlValue } from "./sql-driver.js";
export { backupTables, restoreBackup, tableChecksum, verifyCopy, type BackupManifest, type TableSummary } from "./migrate/backup.js";
export { mysqlSnapshot, sqliteSnapshot } from "./snapshot.js";
