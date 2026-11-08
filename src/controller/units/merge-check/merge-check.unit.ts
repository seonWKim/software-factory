// The local merge check: a factory PR waiting for a merge is checked against the newest base.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { MERGE_CHECK_BATCH, MergeChecker, canMergeCheck } from "../../../core/merge-check.js";
import { awaitingMerge } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The local merge check: a factory PR waiting for a merge is checked against the newest base. */
export class MergeCheckUnit {
  constructor(private readonly c: Ctx) {
    const d = c.k.d;
    this.merges = canMergeCheck(d.sandbox) ? new MergeChecker({ store: d.store, sandbox: d.sandbox, clock: d.clock }) : null;
  }

  /** The local merge check; its only in-process state is a fetch throttle no other replica needs. */
  readonly merges: MergeChecker | null;

  async mergeCheckStep(): Promise<void> {
    if (!this.merges) return;
    const waiting = await this.c.k.reader.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "human", limit: MERGE_CHECK_BATCH });
    // Factory branches only: an adopted PR's branch is a person's, which the factory never updates.
    const ready = waiting.filter((it) => awaitingMerge(it) && it.change_ref !== null && it.head_branch === null);
    const { repo, branch_prefix, poll_interval_ms } = this.c.k.cfg;
    await this.merges.step(ready, { repo: repo.path, base_ref: repo.base_branch, branch_prefix, poll_interval_ms }, (it, c) => {
      this.c.k.d.log.info("merge check conflict", { work_item_id: it.id, files: c.conflicts.length });
      return this.c.unit("pr-events").startUpdate(it.id, it.change_ref!, c.head_sha, c.base_sha);
    });
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "merge-check": MergeCheckUnit;
  }
}

export default controllerUnit({
  name: "merge-check",
  create: (c: Ctx) => new MergeCheckUnit(c),
  steps: [
    { name: "merge check", every: "poll", order: 60, run: (u) => u.mergeCheckStep() },
  ],
});
