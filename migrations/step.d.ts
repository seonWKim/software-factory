// Types for `.ts` steps in migrations/mysql/. Import with `import type { DataStep } from "../step.js";`.
// Same shapes as `StepDb` and `DataStep` in src/impl/store/mysql/migrations.ts (the runner).

export type Row = Record<string, unknown>;
export type Value = string | number | null;

export interface StepDb {
  all(sql: string, params?: readonly Value[]): Promise<Row[]>;
  run(sql: string, params?: readonly Value[]): Promise<number>;
}

export interface DataStep {
  /** The rows `apply` would change, for `npm run migrate -- --dry-run`. Runs in a READ ONLY transaction. */
  plan(db: StepDb): Promise<Row[]>;
  /** Changes the data. Runs in one transaction together with the state update. */
  apply(db: StepDb): Promise<void>;
}
