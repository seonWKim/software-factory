// The coordinator step (design 05-coordinator): at each tick it hands the coordinator cycle (src/coordinator/, built by
// compose as `coordinator`) the live settings, the items waiting for a merge and the existing local merge, as auto
// mode runs it under the controller's service passport. The cycle decides whether a cycle is due and runs it. It
// stores the `coordinator` Activity record of each cycle that called the agent, and raises the daily limit's owner
// question (design 06-spend).

import { activityOf, logRef } from "../../background-jobs.js";
import { coordinatorLimitQuestion } from "../../../core/alarms.js";
import { awaitingMerge } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** Items waiting for a merge read per cycle. */
const WAITING_BATCH = 50;

export class CoordinatorUnit {
  private readonly cycle: { tick(): Promise<unknown> } | null;

  constructor(private readonly c: Ctx) {
    this.cycle = c.k.d.coordinator?.({
      settings: async () => {
        const v = this.c.k.live.values();
        return { on: v.coordinator, max_tier: v.auto_merge_max_tier, daily_usd: v["spend.coordinator_daily_usd"] };
      },
      activity: async (a) => {
        await this.c.k.d.store.recordActivity(activityOf("coordinator", { ...a, ref: logRef("controller", "coordinator cycle done") }));
      },
      limitReached: async (q) => {
        await coordinatorLimitQuestion({ store: this.c.k.d.store, scanner: this.c.k.d.scanner, log: this.c.k.d.log }, q);
      },
      waiting: async () => (await this.c.k.reader.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "human", limit: WAITING_BATCH })).filter(awaitingMerge),
      merge: async (id, key) => {
        const item = await this.c.k.reader.getWorkItem(id);
        const refusal = item ? await this.c.unit("auth").automatic("approve_merge", item) : "the work item was not found";
        return refusal ?? this.c.unit("local-merge").mergeLocal(id, { auto: true }, key, { coordinator: key });
      },
    }) ?? null;
  }

  /** One tick of the cycle; with no coordinator wired, nothing. */
  async step(): Promise<void> {
    await this.cycle?.tick();
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "coordinator": CoordinatorUnit;
  }
}

export default controllerUnit({
  name: "coordinator",
  create: (c: Ctx) => new CoordinatorUnit(c),
  steps: [
    { name: "coordinator", every: "tick", order: 116, run: (u) => u.step() },
  ],
});
