// Timestamped migrations (RFC 0015 §6.3): `<yyyymmddThhmm>-<component>-<slug>.migration.ts` in the owning
// component's migrations/ folder, found by discovery and applied in timestamp order after the frozen baseline
// (SQLite's numbered list in impl/store/sqlite/schema.ts, MySQL's migrations/mysql/ steps up to 0041).

import type { SqlExecutor } from "../sql-driver.js";

export type Dialect = "sqlite" | "mysql";

export interface MigrationDb extends SqlExecutor {
  readonly dialect: Dialect;
}

export interface MigrationSpec {
  /** additive: safe while old code runs. breaking: needs drained writers and a backup first (§12 D1, D3). */
  readonly change: "additive" | "breaking";
  /** Tables backed up before a breaking migration runs (§12 D1). */
  readonly tables: readonly string[];
  /** Applies the change. On MySQL it must be resumable: DDL is not transactional (§12 D3). */
  up(db: MigrationDb): Promise<void>;
}

export interface MigrationDescriptor extends MigrationSpec {
  readonly kind: "migration";
}

export interface Migration extends MigrationDescriptor {
  /** The file name without `.migration.ts`: `<timestamp>-<component>-<slug>`. */
  readonly id: string;
  readonly component: string;
}

export const MIGRATION_FILE = /^(\d{8}T\d{4})-([a-z]+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.migration\.(?:ts|js)$/;

export function defineMigration(spec: MigrationSpec): MigrationDescriptor {
  return { kind: "migration", ...spec };
}
