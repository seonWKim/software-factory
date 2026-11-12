// The local merge check: a factory PR or a local item waiting for a merge is checked against the newest base.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { MERGE_CHECK_BATCH, MergeChecker, type OnConflict, canMergeCheck } from "../../../core/merge-check.js";
import { awaitingMerge } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The local merge check: a factory PR or a local item waiting for a merge is checked against the newest base. */
export class MergeCheckUnit {
  constructor(private readonly c: Ctx) {
    const d = c.k.d;
    this.merges = canMergeCheck(d.sandbox) ? new MergeChecker({ store: d.store, sandbox: d.sandbox, clock: d.clock }) : null;
  }

  /** The local merge check; its only in-process state is a fetch throttle no other replica needs. */
  readonly merges: MergeChecker | null;

  /**
   * Factory PRs and local items (no PR). With no forge (`local_only`) the sandbox's base and branch reads are the
   * factory repo's own refs, so both take one step; with a forge selected those reads are the remote's, so local
   * items are read from the local refs instead (`localBranch`, no network call). A PR's conflict starts its update
   * run; a local item's starts the automatic resolve at once (design §5 Merge conflict).
   */
  async mergeCheckStep(): Promise<void> {
    if (!this.merges) return;
    const waiting = await this.c.k.reader.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "human", limit: MERGE_CHECK_BATCH });
    const { repo, branch_prefix, poll_interval_ms, local_only } = this.c.k.cfg;
    // Factory branches only: an adopted PR's branch is a person's, which the factory never updates.
    const ready = waiting.filter((it) => awaitingMerge(it) && it.head_branch === null);
    const target = { repo: repo.path, base_ref: repo.base_branch, branch_prefix, poll_interval_ms };
    const onConflict: OnConflict = (it, c) => {
      this.c.k.d.log.info("merge check conflict", { work_item_id: it.id, files: c.conflicts.length });
      if (it.change_ref === null) return this.c.unit("local-merge").startLocalResolve(it.id, c.base_sha, "merge_check");
      return this.c.unit("pr-events").startUpdate(it.id, it.change_ref, c.head_sha, c.base_sha);
    };
    if (local_only === true) return this.merges.step(ready, target, onConflict);
    await this.merges.step(ready.filter((it) => it.change_ref !== null), target, onConflict);
    const local = this.c.unit("local-merge").localReads(ready);
    if (local) await this.merges.stepLocal(local.items, target, local.read, onConflict);
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
