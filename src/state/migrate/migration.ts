// Timestamped migrations (RFC 0015 §6.3): `<yyyymmddThhmm>-<component>-<slug>.migration.ts` in the owning
// component's migrations/ folder, found by discovery and applied in timestamp order after the frozen baseline
// (SQLite's numbered list in impl/store/sqlite/schema.ts, MySQL's migrations/mysql/ steps up to 0041).

import type { SqlExecutor } from "../sql-driver.js";

export type Dialect = "sqlite" | "mysql";

export interface MigrationDb extends SqlExecutor {
  readonly dialect: Dialect;
}

export interface MigrationSpec {
  /**
   * additive: safe while old code runs. breaking: needs drained writers and a backup first, and keeps the old
   * data until a contract migration (§12 D1, D3). contract: drops what a breaking migration left behind, only
   * after its tables were archived (D4).
   */
  readonly change: "additive" | "breaking" | "contract";
  /** Tables a breaking or contract migration changes; backed up (archived) before it runs (§12 D1, D4). */
  readonly tables: readonly string[];
  /** Applies the change. On MySQL it must be resumable: DDL is not transactional (§12 D3). */
  up(db: MigrationDb): Promise<void>;
  /**
   * Required for breaking: runs right after `up` and returns every problem (a row count or checksum that
   * differs). Any problem fails the migration, so it is never recorded as applied (§12 D2).
   */
  verify?(db: MigrationDb): Promise<string[]>;
  /**
   * Required for contract: the breaking migrations whose leftovers it drops. It runs only through
   * `npm run migrate -- --contract`, and only once each of them was applied CONTRACT_MIN_DAYS ago (§12 D2).
   */
  readonly after?: readonly string[];
}

export interface MigrationDescriptor extends MigrationSpec {
  readonly kind: "migration";
}

export interface Migration extends MigrationDescriptor {
  /** The file name without `.migration.ts`: `<timestamp>-<component>-<slug>`. */
  readonly id: string;
  readonly component: string;
}

/** Days a breaking migration's leftovers are kept before its contract may drop them (§12 D2). */
export const CONTRACT_MIN_DAYS = 14;

export const MIGRATION_FILE = /^(\d{8}T\d{4})-([a-z]+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.migration\.(?:ts|js)$/;

/** Problems with a spec that the type alone cannot catch; empty when it is safe to run (migration-safety). */
export function migrationSpecProblems(spec: MigrationSpec): string[] {
  const out: string[] = [];
  if (spec.change !== "additive" && spec.tables.length === 0) out.push(`a ${spec.change} migration must name the tables it changes`);
  if (spec.change === "breaking" && spec.verify === undefined) out.push("a breaking migration needs verify");
  if (spec.change === "contract" && (spec.after ?? []).length === 0) out.push("a contract migration must name the migrations it follows (after)");
  return out;
}

export function defineMigration(spec: MigrationSpec): MigrationDescriptor {
  const problems = migrationSpecProblems(spec);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return { kind: "migration", ...spec };
}
