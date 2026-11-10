// The CI gate: a reviewed PR waits for its checks; failed checks send it back or block it.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { prNumber } from "../../../core/change-ref.js";
import { errorText } from "../../../core/log.js";
import { parseReview } from "../../../core/outputs.js";
import { runKey, branchFor } from "../../../core/policy.js";
import { lastPrNotes } from "../../../core/pr-body.js";
import { type Run, type RunId, type RunInput, type Tier, type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { PrChecks } from "../../../interfaces/forge.js";
import { type Decision, SYSTEM, UNCHANGED_HEAD, CHECKS_FAILED, CHECKS_FAILED_UPDATE, footerAfter, updateKey } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** blocked_reason (with `blocked_on: ci`) of a reviewed PR whose checks have not finished (design §5 CI gate). */
const CHECKS_PENDING = "checks_pending";
/** Items waiting on checks looked at per tick. */
const CHECKS_BATCH = 50;
/** Check names kept per decision and per review input, and characters per name. */
const MAX_CHECK_NAMES = 20;
const MAX_CHECK_NAME_CHARS = 100;
/** A reviewed PR whose checks have not finished (design §5 CI gate). */
function waitingOnChecks(it: WorkItem): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "ci" && it.blocked_reason === CHECKS_PENDING;
}

/** The CI gate: a reviewed PR waits for its checks; failed checks send it back or block it. */
export class ChecksGateUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * The CI gate (design §5): a PR that passed review is offered for a human merge only once its checks
   * passed. Pending (or the source could not say): the item waits in `REVIEW` with `blocked_on: ci` /
   * `checks_pending`, and tickChecks looks again. Failed: back to implement like a review bug (loop_count + 1,
   * max_loops applies), with the failing check names on the state change for the next implementer.
   * `review` is the review that passed; its id keys the comments, so a re-decide posts each once.
   * `ackRun` acks the run being applied (that review, or an update run); tickChecks passes null.
   */
  async checkGate(
    it: WorkItem,
    review: Run,
    fields: { tier?: Tier; token_cost?: number },
    ackRun: RunId | null,
  ): Promise<Decision> {
    const reviewRunId = review.id;
    const checks = await this.readChecks(it);
    const ack = ackRun ? { ack_run: ackRun } : {};
    const tier = fields.tier ?? it.tier;
    if (checks.state === "pending") {
      if (waitingOnChecks(it)) return null;
      return {
        patch: { ...fields, blocked_on: "ci", blocked_reason: CHECKS_PENDING },
        actor: SYSTEM,
        reason: "checks_pending",
        detail: { review_run_id: reviewRunId },
        ...ack,
      };
    }
    if (checks.state === "failed") return this.checksFailed(it, review, checks.failed, fields, ack);
    // Every change waits here for a merge; in auto mode the auto-merge step merges a local one it may (design 03-risk).
    // An incomplete PR (its implementer reported missing work, issue #229) is never auto-merged, and the comment says so first.
    const patch = { ...fields, blocked_on: "human" as const, blocked_reason: "merge_pending" };
    const missing = it.origin === "adopted" ? [] : (lastPrNotes(await this.c.k.reader.listRuns(it.id))?.missing ?? []);
    // No PR (a local item, design 05-sources): no checks to wait for, and the merge is `factory merge`, by a human.
    const local = it.change_ref === null && it.origin !== "adopted";
    const ready = local
      ? `The local branch \`${branchFor(it, this.c.k.cfg.branch_prefix)}\` passed review (tier ${tier}).`
      : `PR #${it.change_ref} passed review (tier ${tier}) and its checks passed.`;
    const text = missing.length > 0
      ? [
        `${ready} It is **incomplete**: the implementer reports work the spec asks for that it does not do. Merging it does not finish this issue.`,
        "",
        ...missing.map((m) => `- ${m}`),
        "",
        "Merge it only with a follow-up issue for the rest, or comment `/revise <feedback>` on the PR to send it back to the implementer.",
      ].join("\n")
      : `${ready} A human merge is required${local ? `: \`factory merge ${it.id}\` (approver role) merges it into the local \`${this.c.k.cfg.repo.base_branch}\`, ${this.c.unit("local-merge").pushesBase() ? "then queues its push to origin" : "with no push"}` : ""}.`;
    await this.c.unit("outbox").comment(it, `merge:${reviewRunId}`, `${text}\n\n${footerAfter(it, patch)}`);
    return { patch, actor: SYSTEM, reason: "review_passed", ...ack };
  }

  /**
   * Failed checks after `review` (design §5 CI gate). An adopted PR blocks on its author. A factory PR whose stored
   * merge check conflicts for the reviewed head gets one update run first (keyed as from the merge check, no loop
   * counted), and the item waits in REVIEW on `checks_failed_update`. Otherwise back to implement like a review
   * bug (loop_count + 1), or at `max_loops` a block on a human. A review that skipped an unchanged head marks the
   * state change `unchanged_head: true`, so the next implement prompt says its previous attempt pushed nothing.
   */
  async checksFailed(
    it: WorkItem,
    review: Run,
    failed: readonly string[],
    fields: { tier?: Tier; token_cost?: number },
    ack: { ack_run?: RunId },
  ): Promise<Decision> {
    const reviewRunId = review.id;
    const data = review.outcome?.status === "succeeded" ? review.outcome.data : {};
    const names = failed.slice(0, MAX_CHECK_NAMES).map((n) => n.slice(0, MAX_CHECK_NAME_CHARS));
    const detail = {
      failed_checks: JSON.stringify(names),
      review_run_id: reviewRunId,
      ...(data.no_agent === UNCHANGED_HEAD ? { unchanged_head: true } : {}),
    };
    if (it.origin === "adopted") {
      const patch = { ...fields, blocked_on: "human" as const, blocked_reason: CHECKS_FAILED };
      await this.checksComment(it, `checks-failed:${reviewRunId}`, names, (list) =>
        `PR #${it.change_ref} passed review but its checks failed${list}. The factory does not push to a change a person opened; push a fix.\n\n${footerAfter(it, patch)}`);
      return { patch, actor: SYSTEM, reason: CHECKS_FAILED, detail, ...ack };
    }
    const update = await this.updateBeforeImplement(it, typeof data.head_sha === "string" ? data.head_sha : "");
    if (update) {
      return {
        patch: { ...fields, blocked_on: "ci", blocked_reason: CHECKS_FAILED_UPDATE },
        actor: SYSTEM,
        reason: "update_started",
        detail,
        ...ack,
        enqueue: { kind: "update", idempotency_key: update },
      };
    }
    const loop = it.loop_count + 1;
    if (loop >= this.c.k.cfg.max_loops) {
      const patch = { ...fields, blocked_on: "human" as const, blocked_reason: "max_loops" };
      await this.checksComment(it, `max-loops:${reviewRunId}`, names, (list) =>
        `PR #${it.change_ref} passed review but its checks failed${list}. That makes ${loop} loops (limit ${this.c.k.cfg.max_loops}). A human needs to decide.\n\n${footerAfter(it, patch)}`);
      return { patch, actor: SYSTEM, reason: "max_loops", detail, ...ack };
    }
    const next = { ...it, loop_count: loop };
    await this.checksComment(it, `checks-failed:${reviewRunId}`, names, (list) =>
      `PR #${it.change_ref} passed review but its checks failed${list}. The factory sent it back to the implementer (loop ${loop} of ${this.c.k.cfg.max_loops}).`);
    return {
      patch: { ...fields, stage: "RUNNING", blocked_on: "none", blocked_reason: null, loop_count: loop },
      actor: SYSTEM,
      reason: "checks_failed",
      detail,
      ...ack,
      enqueue: { kind: "implement", idempotency_key: runKey(next, "implement") },
    };
  }

  /**
   * The update run's key when the item's stored merge check is not mergeable for `head` (the reviewed head), the
   * same key the merge check would use, and no run of it exists yet; else null. No stored check: none, as before.
   */
  async updateBeforeImplement(it: WorkItem, head: string): Promise<string | null> {
    const pr = prNumber(it);
    if (pr === null || head === "" || it.head_branch !== null) return null;
    const check = await this.c.k.reader.getMergeCheck(it.id);
    if (!check || check.mergeable || check.head_sha !== head) return null;
    const key = updateKey(it.id, String(pr), check.head_sha, check.base_sha);
    return (await this.c.k.reader.listRuns(it.id)).some((r) => r.idempotency_key === key) ? null : key;
  }

  /** Whether the item's latest review with a verdict, other than run `self`, passed. */
  async lastVerdictPassed(id: WorkItemId, self: RunId): Promise<boolean> {
    const last = (await this.c.k.reader.listRuns(id))
      .filter((r) => r.kind === "review" && r.id !== self && r.outcome?.status === "succeeded" && r.outcome.data.review != null)
      .at(-1);
    if (last?.outcome?.status !== "succeeded") return false;
    const parsed = parseReview(last.outcome.data.review);
    return parsed.ok && parsed.value.verdict === "pass";
  }

  /** The PR's checks, from the forge whatever source the item came from; no forge counts as passed, a forge error as pending (logged). */
  async readChecks(it: WorkItem): Promise<PrChecks> {
    const forge = this.c.k.reader.forge;
    const pr_number = prNumber(it);
    if (!forge || pr_number === null) return { state: "passed" };
    try {
      return await forge.prChecks(pr_number);
    } catch (err) {
      this.c.k.d.log.warn("reading PR checks failed", {
        work_item_id: it.id,
        pr_number,
        error: errorText(err),
      });
      return { state: "pending" };
    }
  }

  /**
   * A review run's input (design §4, issue #223): the PR's CI results through the forge, at most MAX_CHECK_NAMES
   * checks of MAX_CHECK_NAME_CHARS. No forge: no checks ran (an empty list). A read error: null (logged), so the
   * prompt says the results could not be read; the review still runs.
   */
  async reviewInput(pr_number: number | null, work_item_id: WorkItemId | null): Promise<RunInput> {
    const forge = this.c.k.reader.forge;
    if (!forge || pr_number === null) return { ci_checks: [] };
    try {
      const results = await forge.prCheckResults(pr_number);
      return { ci_checks: results.slice(0, MAX_CHECK_NAMES).map((r) => ({ name: r.name.slice(0, MAX_CHECK_NAME_CHARS), result: r.result })) };
    } catch (err) {
      this.c.k.d.log.warn("reading PR check results failed", {
        ...(work_item_id ? { work_item_id } : {}),
        pr_number,
        error: errorText(err),
      });
      return { ci_checks: null };
    }
  }

  /** A checks comment naming the failed checks; the names are forge text (G5), so they are left out if the scan flags them. */
  async checksComment(it: WorkItem, key: string, names: string[], body: (list: string) => string): Promise<void> {
    const list = names.length ? `: ${names.map((n) => `\`${n.replace(/`/g, "'")}\``).join(", ")}` : "";
    const scan = await this.c.k.d.scanner.scan("comment", body(list));
    await this.c.unit("outbox").comment(it, key, body(scan.clean ? list : ""));
  }

  async checksStep(): Promise<void> {
    await this.c.k.guard("sync", () => this.c.unit("sync").syncStep());
    // Check reads are optional: with the budget low, or another replica syncing, they wait for a later tick.
    if (this.c.unit("sync").lowBudget()) return;
    const waiting = await this.c.k.reader.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "ci", limit: CHECKS_BATCH });
    for (const w of waiting) {
      if (!waitingOnChecks(w)) continue;
      const review = await this.c.unit("run-results").latestReview(w.id);
      if (!review) continue;
      await this.c.k.guard("checks", () => this.c.unit("transitions").decide(w.id, (it) => (waitingOnChecks(it) ? this.checkGate(it, review, {}, null) : null)).then(() => undefined));
    }
    // Items stalled before failed checks on an unchanged head looped (PR #399): in REVIEW, unblocked, with no run.
    const unblocked = await this.c.k.reader.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "none", limit: CHECKS_BATCH });
    for (const w of unblocked) {
      if (!(await this.stalled(w))) continue;
      const review = await this.c.unit("run-results").latestReview(w.id);
      if (!review || !(await this.lastVerdictPassed(w.id, review.id))) continue;
      await this.c.k.guard("checks", () => this.c.unit("transitions").decide(w.id, async (it) => {
        if (!(await this.stalled(it))) return null;
        const checks = await this.readChecks(it);
        return checks.state === "failed" ? this.checksFailed(it, review, checks.failed, {}, {}) : null;
      }).then(() => undefined));
    }
  }

  /** In REVIEW with no block and no blocked reason, and no run queued, running or not yet applied: nothing will look at it again. */
  async stalled(it: WorkItem): Promise<boolean> {
    if (it.stage !== "REVIEW" || it.blocked_on !== "none" || it.blocked_reason !== null) return false;
    return !(await this.c.k.reader.listRuns(it.id)).some((r) => r.status === "queued" || r.status === "running" || r.acknowledged_at === null);
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "checks-gate": ChecksGateUnit;
  }
}

export default controllerUnit({
  name: "checks-gate",
  create: (c: Ctx) => new ChecksGateUnit(c),
  steps: [
    { name: "checks", every: "poll", order: 40, run: (u) => u.checksStep() },
  ],
});
