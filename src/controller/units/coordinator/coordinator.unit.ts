// The coordinator step (design 05-coordinator): at each tick it hands the coordinator cycle (src/coordinator/, built by
// compose as `coordinator`) the live settings, the items waiting for a merge and the existing local merge, as auto
// mode runs it under the controller's service passport. The cycle decides whether a cycle is due and runs it. Each
// merge it asks is an agent write: after the passport check it passes the permission gate (design 08-permissions),
// which holds it for the owner's `confirm <id>` once per item, however many ticks ask it again.

import type { UserId } from "../../../core/types.js";
import { COMMAND_TABLE } from "../../../core/command-table.js";
import { awaitingMerge } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** Items waiting for a merge read per cycle. */
const WAITING_BATCH = 50;
/** The command table's `merge`, the one write the coordinator asks. */
const MERGE = COMMAND_TABLE.find((c) => c.name === "merge")!;
/** Who a held coordinator merge names as its writer. */
const COORDINATOR_ACTOR = "service:coordinator" as UserId;

export class CoordinatorUnit {
  private readonly cycle: { tick(): Promise<unknown> } | null;

  constructor(private readonly c: Ctx) {
    this.cycle = c.k.d.coordinator?.({
      settings: async () => {
        const v = this.c.k.live.values();
        return { on: v.coordinator, max_tier: v.auto_merge_max_tier };
      },
      waiting: async () => (await this.c.k.reader.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "human", limit: WAITING_BATCH })).filter(awaitingMerge),
      merge: async (id, key) => {
        const item = await this.c.k.reader.getWorkItem(id);
        const refusal = item ? await this.c.unit("auth").automatic("approve_merge", item) : "the work item was not found";
        if (refusal !== null) return refusal;
        const gate = await this.c.unit("commands").gateAgentWrite({
          command: MERGE, args: [id], actor: COORDINATOR_ACTOR, in_chat_turn: false, key: `coordinator:merge:${id}`,
        });
        return gate.outcome === "run" ? this.c.unit("local-merge").mergeLocal(id, { auto: true }, key, { coordinator: key }) : gate.reply;
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
