// Every decided item transition: re-read, decide, the budget hold, the WorkItem state table check, a conditional write.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { BUDGET_CHECKPOINT, DEFAULT_BUDGET_MIN_SAMPLE, checkpointComment, currentBudget, overBudget, suggestBudget, tierBudget } from "../../../core/budget.js";
import { prNumber } from "../../../core/change-ref.js";
import { type RunKind, type WorkItem, type WorkItemId, type WorkItemPatch } from "../../../core/types.js";
import type { NewBudgetCheckpoint, TransitionInput } from "../../../interfaces/factory-store.js";
import { type Decision, type Refusal, MAX_CONFLICT_RETRIES, updatingForChecks, awaitingMerge } from "../support.js";
import workItemActor from "../../actors/work-item/work-item.actor.js";
import { allowed } from "../../router/actor.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** A decision whose implement or review run is held at a budget checkpoint instead of queued. */
type Hold = Omit<TransitionInput, "id" | "expected_version" | "enqueue"> & { checkpoint: NewBudgetCheckpoint };
/** Patch fields that can change an item's status or where it is shown. */
const STATUS_FIELDS = ["stage", "blocked_on", "blocked_reason", "close_reason", "change_ref"] as const;

/** Every decided item transition: re-read, decide, the budget hold, the WorkItem state table check, a conditional write. */
export class TransitionsUnit {
  constructor(private readonly c: Ctx) {}

  /** False, with a warning, when `patch` moves the item's stage along no edge of the WorkItem state table. */
  inTable(it: WorkItem, patch: Pick<WorkItemPatch, "stage">): boolean {
    if (patch.stage === undefined || allowed(workItemActor, it.stage, patch.stage)) return true;
    this.c.k.d.log.warn("transition refused: not in the WorkItem state table", { work_item_id: it.id, from: it.stage, to: patch.stage });
    return false;
  }

  // Internals

  /** Whether the item is in the state a finished run of this kind should advance. */
  expects(it: WorkItem, kind: RunKind): boolean {
    // An update runs while the PR waits for a human merge, so the item stays blocked on that human throughout, or
    // before the implement run of a failed-checks loop (design §5 CI gate).
    if (kind === "update") return awaitingMerge(it) || updatingForChecks(it);
    if (kind === "manual") return false;
    // A dependency hold is lifted by the claim reading the store; the controller may clear the field after it.
    if (kind === "implement" && it.stage === "RUNNING" && it.blocked_on === "dependency") return true;
    if (it.stage === "CLOSED" || it.blocked_on !== "none") return false;
    if (kind === "triage") return it.stage === "NEW";
    if (kind === "implement" || kind === "resolve" || kind === "interactive") return it.stage === "RUNNING";
    return it.stage === "REVIEW";
  }

  /**
   * Re-read → decide → conditional transition, retrying on version conflicts. Returns the refusal reason
   * when `fn` refused, else null (applied, or a silent no-op).
   */
  async decide(
    id: WorkItemId,
    fn: (item: WorkItem) => Decision | Refusal | Promise<Decision | Refusal>,
  ): Promise<string | null> {
    for (let i = 0; i < MAX_CONFLICT_RETRIES; i++) {
      const item = await this.c.k.d.store.getWorkItem(id);
      if (!item) return null;
      // No adapter for the item's source type here (a source left out of this process's `plugins.source`, e.g.
      // an older version still draining): the item keeps its state for a process that has one, so its replies
      // are not dropped (2026-11-07).
      if (!this.c.k.serves(item.source.type)) {
        this.c.k.d.log.warn("no source adapter for the item's source type; transition left to another process", {
          work_item_id: id,
          source_type: item.source.type,
        });
        return null;
      }
      const wanted = await fn(item);
      if (!wanted) return null;
      if ("refuse" in wanted) return wanted.refuse;
      if (!this.inTable(item, wanted.patch)) return null;
      // The one budget check: every implement or review run the factory would queue passes here (design §6).
      const hold = await this.budgetHold(item, wanted);
      const decision = hold ?? wanted;
      const at = { id, expected_version: item.version };
      const r = hold
        ? await this.c.k.d.store.openBudgetCheckpoint({ ...hold, ...at })
        : await this.c.k.d.store.transition({ ...wanted, ...at });
      if (r.ok) {
        this.c.k.d.log.info("transition", { work_item_id: id, reason: decision.reason, version: r.item.version });
        if (STATUS_FIELDS.some((k) => k in decision.patch)) await this.c.unit("outbox").showStatus(r.item);
        // A budget checkpoint stops auto mode (design 03-risk).
        if (hold) await this.c.k.guard("auto stop", () => this.c.unit("local-merge").stopAuto(r.item.project, "budget_checkpoint", `${r.item.id} reached its token budget`));
        return null;
      }
      if (r.reason !== "version_conflict") {
        this.c.k.d.log.warn("transition refused", { work_item_id: id, reason: r.reason });
        return null;
      }
    }
    this.c.k.d.log.warn("transition gave up after conflicts", { work_item_id: id });
    return null;
  }

  /**
   * A token-budget checkpoint in place of `d`, when `d` queues an implement or review run and the item, after
   * `d`'s patch, is at or over its current budget; else null. The rest of `d` (the outcome it applies, the
   * run it acks) stands; the run is not queued but kept on the checkpoint row. Posts the one checkpoint
   * comment first, keyed on the held run's key, so a re-decide after a conflict posts nothing new.
   */
  async budgetHold(it: WorkItem, d: NonNullable<Decision>): Promise<Hold | null> {
    const run = d.enqueue;
    if (!run || (run.kind !== "implement" && run.kind !== "review")) return null;
    const next = { ...it, ...d.patch };
    if (next.tier === null) return null;
    const base = tierBudget(this.c.k.settings(it.project).budgets, next.tier);
    if (base === null) return null;
    const budget = currentBudget(base, await this.c.k.d.store.listBudgetCheckpoints(it.id));
    if (!overBudget(next.token_cost, budget)) return null;

    const suggestion = suggestBudget({
      current: budget,
      base,
      history: await this.c.k.d.store.getTierHistory(it.project, next.tier),
      min_sample: this.c.k.cfg.budget_min_sample ?? DEFAULT_BUDGET_MIN_SAMPLE,
    });
    const runs = (await this.c.k.d.store.listRuns(it.id)).length;
    await this.c.unit("outbox").comment(it, `budget:${run.idempotency_key}`, checkpointComment({
      tier: next.tier,
      stage: next.stage,
      pr_number: prNumber(next),
      runs,
      tokens: next.token_cost,
      budget,
      held_run_kind: run.kind,
      suggestion,
    }));
    const { enqueue: _held, ...rest } = d;
    return {
      ...rest,
      patch: { ...d.patch, blocked_on: "budget", blocked_reason: BUDGET_CHECKPOINT },
      reason: BUDGET_CHECKPOINT,
      detail: {
        ...d.detail,
        held_reason: d.reason,
        held_run_kind: run.kind,
        held_run_key: run.idempotency_key,
        tokens_spent: next.token_cost,
        budget,
        suggested_budget: suggestion.budget,
        suggestion_method: suggestion.method,
        merged_sample: suggestion.merged_sample,
      },
      checkpoint: {
        tier: next.tier,
        tokens_spent: next.token_cost,
        budget,
        suggested_budget: suggestion.budget,
        held_run_kind: run.kind,
        held_run_key: run.idempotency_key,
        held_run_not_before: run.not_before ?? null,
      },
    };
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "transitions": TransitionsUnit;
  }
}

export default controllerUnit({
  name: "transitions",
  create: (c: Ctx) => new TransitionsUnit(c),
});
