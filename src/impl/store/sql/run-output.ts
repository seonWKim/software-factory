// A running run's last model output time (design 05-restarts): `worker_runs.last_output_at`, written by the worker
// that holds the run's lease, read by the controller's stall step. SqlFactoryStore extends this class, so these
// methods add no line to that file's budget.

import type { RunOutputStore } from "../../../core/stall.js";
import type { RunId, Timestamp } from "../../../core/types.js";
import type { SqlDriver } from "../../../state/index.js";
import { SqlProjectStore } from "./projects.js";

/** RunOutputStore over a SqlDriver; `outputStamp` is the store's injected Clock's time. */
export class SqlRunOutputStore extends SqlProjectStore implements RunOutputStore {
  constructor(db: SqlDriver, private readonly outputStamp: () => Timestamp) {
    super(db, outputStamp);
  }

  /** Conditional on the run still `running` with this lease token, so a lost lease writes nothing. */
  async recordRunOutput(runId: RunId, token: number): Promise<boolean> {
    const n = await this.db.run("UPDATE worker_runs SET last_output_at = ? WHERE id = ? AND status = 'running' AND lease_token = ?", [this.outputStamp(), runId, token]);
    return n === 1;
  }

  async latestRunningOutput(): Promise<Timestamp | null> {
    const [row] = await this.db.all("SELECT MAX(last_output_at) AS at FROM worker_runs WHERE status = 'running'");
    return (row?.at as Timestamp | null | undefined) ?? null;
  }
}
