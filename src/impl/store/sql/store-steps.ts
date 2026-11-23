// What the store's method-group modules (sessions.ts, dependencies.ts, pr-heads.ts and the others) take from
// SqlFactoryStore: its injected Clock's time, its conditional insert, and the work-item and run reads and the
// transition a group shares with the claims, which stay in the class.

import type { Run, RunId, Timestamp, WorkItem, WorkItemId } from "../../../core/types.js";
import type { TransitionInput, TransitionResult } from "../../../interfaces/factory-store.js";
import type { SqlDriver, SqlExecutor, SqlValue } from "../../../state/index.js";

/** The store's clock: now, and now plus `ms`, as ISO text. */
export interface StoreTime {
  now(): Timestamp;
  after(ms: number): Timestamp;
}

/** The class's own transaction steps, each run on `q` or inside the caller's transaction `tx`. */
export interface StoreSteps {
  selectItem(q: SqlExecutor, id: WorkItemId): Promise<WorkItem | null>;
  selectRun(q: SqlExecutor, id: RunId): Promise<Run | null>;
  applyTransition(tx: SqlExecutor, input: TransitionInput): Promise<TransitionResult>;
}

/** False if a unique key says the row is already there. */
export async function insertOnce(db: SqlDriver, tx: SqlExecutor, sql: string, params: SqlValue[]): Promise<boolean> {
  try {
    await tx.run(sql, params);
    return true;
  } catch (err) {
    if (db.isDuplicateKey(err)) return false;
    throw err;
  }
}
