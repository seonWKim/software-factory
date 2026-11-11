// Every decided item transition: re-read, decide, the Rule of Two and budget holds, the WorkItem state table check, a
// conditional write. It reads through the kernel's reader, decides with no I/O of its own (each hold is a pure function
// of what it read), and the kernel commits the decision: the hold's comment, then the conditional write (RFC 0015 §7).

import { BUDGET_CHECKPOINT, DEFAULT_BUDGET_MIN_SAMPLE, checkpointComment, currentBudget, overBudget, suggestBudget, tierBudget } from "../../../core/budget.js";
import {
  RECURRING_FAILURE, type Actor, type RunInput, type RunKind, type StateChange, type StateChangeDetail, type Timestamp, type WorkItem, type WorkItemId, type WorkItemPatch,
} from "../../../core/types.js";
import type { NewBudgetCheckpoint, NewRun, TransitionInput } from "../../../interfaces/factory-store.js";
import { loadRoles } from "../../../runtime/index.js";
import { holdsAllFacts, ruleOfTwoRefusal } from "../../../shared/role.js";
import { type CommandEvent, type Decision, type Refusal, AUTO, MAX_CONFLICT_RETRIES, RULE_OF_TWO, footerAfter, updatingForChecks, awaitingMerge } from "../support.js";
import workItemActor from "../../actors/work-item/work-item.actor.js";
import { allowed } from "../../router/actor.js";
import type { Ctx } from "../context.js";
import { type ControllerReader, threadEntry } from "../kernel.js";
import { controllerUnit } from "../context.js";

type ThreadEntry = ReturnType<typeof threadEntry>;
/** A decision whose implement or review run is held at a budget checkpoint instead of queued. */
type Hold = Omit<TransitionInput, "id" | "expected_version" | "enqueue"> & { checkpoint: NewBudgetCheckpoint };
/** Patch fields that can change an item's status or where it is shown. */
const STATUS_FIELDS = ["stage", "blocked_on", "blocked_reason", "close_reason", "change_ref"] as const;
/** The state change of a person's `/approve` on a `rule_of_two` block. */
const RULE_OF_TWO_APPROVED = "rule_of_two_approved";

/**
 * Whether a person approved the item's runs (RFC 0015 §8), from its state changes in order with the decision being
 * made last: the newest change by a person or by auto mode decides. A person's command approves; auto mode's approval
 * does not. With neither (manual mode: the dials, a standing rule, a parent's approval) the item runs as before.
 */
export function personApproved(changes: readonly Pick<StateChange, "actor">[]): boolean {
  for (let i = changes.length - 1; i >= 0; i--) {
    const a = changes[i]!.actor;
    if (a.kind === "user") return true;
    if (a.kind === "system" && a.id === AUTO.id) return false;
  }
  return true;
}

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
    // A held item (design 05-alarms) still takes its runs' results: a failure queues its retry, which waits for the release.
    if (it.stage === "CLOSED" || (it.blocked_on !== "none" && it.blocked_reason !== RECURRING_FAILURE)) return false;
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
    const k = this.c.k;
    for (let i = 0; i < MAX_CONFLICT_RETRIES; i++) {
      const item = await k.reader.getWorkItem(id);
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
      // The Rule of Two: every run the factory queues passes here; one no person approved is held (design 10-event-driven).
      const refused = await this.ruleOfTwoRefusal(item, wanted);
      const personHold = refused === null ? null : ruleOfTwoHold(item, wanted, refused);
      // The one budget check: every implement or review run the factory would queue passes here (design §6).
      const held = personHold ? null : budgetHold(item, wanted, await this.loadBudget(item, wanted));
      const hold = held?.hold ?? null;
      const decision = personHold?.hold ?? hold ?? wanted;
      const at = { id, expected_version: item.version };
      const r = held
        ? await k.commitItem([{ kind: "thread_entry", entry: held.comment }], { kind: "budget_checkpoint", input: { ...held.hold, ...at } })
        : await k.commitItem(personHold ? [{ kind: "thread_entry", entry: personHold.comment }] : [], { kind: "transition", input: { ...decision, ...at } });
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

  /** Why `d`'s run may not be queued on `it` now, or null. Reads the item's state changes only for a three-fact role. */
  async ruleOfTwoRefusal(it: WorkItem, d: NonNullable<Decision>): Promise<string | null> {
    const role = d.enqueue ? (await loadRoles()).get(d.enqueue.kind) : null;
    if (!role || !holdsAllFacts(role.rule_of_two)) return null;
    const changes = d.actor.kind === "user" ? [] : await this.c.k.reader.listStateChanges(it.id);
    return ruleOfTwoRefusal(role, { person_approved: personApproved([...changes, d]) });
  }

  /**
   * A command on a `rule_of_two` block. A person's `/approve` queues the held run (its key, input and not-before as
   * held) and clears the block; `/reject` closes the item. Any other command is refused.
   */
  async ruleOfTwoCommand(
    e: Exclude<CommandEvent, { kind: "budget_continue" }>, it: WorkItem, actor: Actor, note: string | null, paths: readonly string[],
  ): Promise<Decision | Refusal> {
    if (e.kind === "spec_rejected") {
      return { patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null }, actor, reason: "rule_of_two_rejected" };
    }
    if (e.kind !== "spec_approved" || paths.length > 0) {
      return { refuse: "the item waits for a person to approve its run (Rule of Two); reply `/approve` to start it or `/reject <reason>` to close" };
    }
    const held = (await this.c.k.reader.listStateChanges(it.id)).filter((c) => c.detail?.held_by === RULE_OF_TWO).at(-1)?.detail;
    if (typeof held?.held_run_kind !== "string" || typeof held.held_run_key !== "string") return { refuse: "the Rule of Two block has no held run" };
    const run: Omit<NewRun, "work_item_id"> = {
      kind: held.held_run_kind as RunKind,
      idempotency_key: held.held_run_key,
      ...(typeof held.held_run_input === "string" ? { input: JSON.parse(held.held_run_input) as RunInput } : {}),
      ...(typeof held.held_run_not_before === "string" ? { not_before: held.held_run_not_before as Timestamp } : {}),
    };
    return { patch: { blocked_on: "none", blocked_reason: null }, actor, reason: RULE_OF_TWO_APPROVED, ...(note ? { detail: { note } } : {}), enqueue: run };
  }

  /**
   * What the budget check of `d` reads: none when `d` queues no implement or review run or the item, after `d`'s
   * patch, has no tier budget; else the current budget, and the suggestion and run count only once it is over.
   */
  async loadBudget(it: WorkItem, d: NonNullable<Decision>): Promise<BudgetLoaded | null> {
    const run = d.enqueue;
    if (!run || (run.kind !== "implement" && run.kind !== "review")) return null;
    const next = { ...it, ...d.patch };
    if (next.tier === null) return null;
    const base = tierBudget(this.c.k.settings(it.project).budgets, next.tier);
    if (base === null) return null;
    const r = this.c.k.reader;
    const budget = currentBudget(base, await r.listBudgetCheckpoints(it.id));
    if (!overBudget(next.token_cost, budget)) return { base, budget, over: null };
    const history = await r.getTierHistory(it.project, next.tier);
    const min_sample = this.c.k.cfg.budget_min_sample ?? DEFAULT_BUDGET_MIN_SAMPLE;
    return { base, budget, over: { history, min_sample, runs: (await r.listRuns(it.id)).length } };
  }
}

/**
 * `d` with its run held by the Rule of Two: the rest of `d` stands (its reason too, so an auto approval is still
 * recorded as one), the item blocks on a human, and the run is kept on the state change's detail (`held_by`) for the
 * `/approve` that queues it. One comment, keyed on the held run's key.
 */
function ruleOfTwoHold(it: WorkItem, d: NonNullable<Decision>, refusal: string): { hold: NonNullable<Decision>; comment: ThreadEntry } {
  const run = d.enqueue!;
  const { enqueue: _held, ...rest } = d;
  const patch = { ...d.patch, blocked_on: "human" as const, blocked_reason: RULE_OF_TWO };
  const body = [
    `The ${run.kind} run was not started: ${refusal.replace(/^rule_of_two: /, "")}. Auto mode's approval is not a person's.`,
    "",
    "Reply `/approve` to start it, or `/reject <reason>` to close the item.",
    "",
    footerAfter(it, patch),
  ].join("\n");
  const detail: StateChangeDetail = {
    ...d.detail,
    held_by: RULE_OF_TWO,
    held_run_kind: run.kind,
    held_run_key: run.idempotency_key,
    held_run_input: run.input == null ? null : JSON.stringify(run.input),
    held_run_not_before: run.not_before ?? null,
  };
  return {
    hold: { ...rest, patch, detail },
    comment: threadEntry(it, it.source, body, `<!-- factory:rule-of-two:${run.idempotency_key} -->`),
  };
}

/** The budget check's reads (`loadBudget`). `over` is set only when the item is at or over its current budget. */
interface BudgetLoaded {
  base: number;
  budget: number;
  over: { history: Awaited<ReturnType<ControllerReader["getTierHistory"]>>; min_sample: number; runs: number } | null;
}

/**
 * A token-budget checkpoint in place of `d`, when `d` queues an implement or review run and the item, after `d`'s
 * patch, is at or over its current budget; else null. The rest of `d` (the outcome it applies, the run it acks)
 * stands; the run is not queued but kept on the checkpoint row. Its one checkpoint comment is keyed on the held run's
 * key, so a re-decide after a conflict writes nothing new. Pure: it decides on what `loadBudget` read.
 */
function budgetHold(it: WorkItem, d: NonNullable<Decision>, loaded: BudgetLoaded | null): { hold: Hold; comment: ThreadEntry } | null {
  const run = d.enqueue;
  if (!loaded?.over || !run) return null;
  const { base, budget, over } = loaded;
  const next = { ...it, ...d.patch };
  const tier = next.tier!;
  const suggestion = suggestBudget({ current: budget, base, history: over.history, min_sample: over.min_sample });
  const comment = threadEntry(it, it.source, checkpointComment({
    tier,
    stage: next.stage,
    change_ref: next.change_ref,
    runs: over.runs,
    tokens: next.token_cost,
    budget,
    held_run_kind: run.kind,
    suggestion,
  }), `<!-- factory:budget:${run.idempotency_key} -->`);
  const { enqueue: _held, ...rest } = d;
  const hold: Hold = {
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
      tier,
      tokens_spent: next.token_cost,
      budget,
      suggested_budget: suggestion.budget,
      held_run_kind: run.kind,
      held_run_key: run.idempotency_key,
      held_run_not_before: run.not_before ?? null,
    },
  };
  return { hold, comment };
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
