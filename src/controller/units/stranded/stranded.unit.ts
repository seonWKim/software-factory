// The safety net for a run outcome that never landed (design 05-restarts, 2026-11-11): an item RUNNING with nothing
// blocking it, no queued or running run, and a last implement or resolve run that failed and was acknowledged waits
// for nothing that will ever come. It gets the plain failed-run block once, so `/retry` applies.

import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** How many RUNNING items with nothing blocking them one tick checks. */
const STRANDED_BATCH = 50;
/** The `repaired` detail on the state change of a block this unit applied. */
export const LOST_OUTCOME = "lost_outcome";

/** Finds items a lost run outcome left RUNNING with nothing to move them, and blocks each on a human once. */
export class StrandedUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * One pass over RUNNING items with nothing blocking them. A run not acknowledged yet is the runs step's, so it is
   * left alone. The block is conditional on the version read here: a second pass, or another replica, finds the item
   * blocked (or moved) and changes nothing. The run is acknowledged already and its tokens counted, so the
   * transition carries no ack.
   */
  async strandedStep(): Promise<void> {
    const reader = this.c.k.reader;
    for (const it of await reader.listWorkItemsWhere({ stage: "RUNNING", blocked_on: "none", limit: STRANDED_BATCH })) {
      const runs = await reader.listRuns(it.id);
      const last = runs.at(-1);
      if (!last || last.status !== "failed" || last.acknowledged_at === null || (last.kind !== "implement" && last.kind !== "resolve")) continue;
      if (runs.some((r) => r.status === "queued" || r.status === "running")) continue;
      this.c.k.d.log.warn("run outcome never landed; blocking the item", { work_item_id: it.id, run_id: last.id });
      await this.c.unit("transitions").decide(it.id, async (now) => {
        if (now.version !== it.version) return null;
        const d = await this.c.unit("run-results").failedBlock(now, last);
        if (!d) return null;
        const { ack_run: _acked, ...rest } = d;
        return { ...rest, detail: { ...rest.detail, repaired: LOST_OUTCOME } };
      });
    }
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "stranded": StrandedUnit;
  }
}

export default controllerUnit({
  name: "stranded",
  create: (c: Ctx) => new StrandedUnit(c),
  steps: [
    { name: "stranded items", every: "tick", order: 91, run: (u) => u.strandedStep() },
  ],
});
