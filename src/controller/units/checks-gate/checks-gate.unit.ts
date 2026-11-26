// The CI gate: a reviewed PR waits for its checks; failed checks send it back or block it.
// Moved out of the legacy controller (RFC 0015 M5); it reads through the kernel's reader and writes through the kernel.

import { prNumber } from "../../../core/change-ref.js";
import { redact } from "../../../core/checks.js";
import { errorText } from "../../../core/log.js";
import { type ReviewOutput, parseReview } from "../../../core/outputs.js";
import { failingTestDetails } from "../../../core/output-summary.js";
import { lastPrNotes } from "../../../core/pr-body.js";
import type { BaseChecks, PrChecks } from "../../../interfaces/forge.js";
import {
  type Decision, type Run, type RunId, type RunInput, type Tier, type WorkItem, type WorkItemId, SYSTEM, UNCHANGED_HEAD, CHECKS_FAILED, CHECKS_FAILED_UPDATE,
  branchFor, footerAfter, runKey, updateKey,
} from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** blocked_reason (with `blocked_on: ci`) of a reviewed PR whose checks have not finished (design §5 CI gate). */
const CHECKS_PENDING = "checks_pending";
/**
 * blocked_reason (with `blocked_on: ci`) while a PR head's failed CI jobs rerun once (design 05-ci-gate, Rerun once);
 * also the reason of the state change that records the rerun, its detail's `rerun_head` the head rerun.
 */
const CHECKS_RERUN = "checks_rerun";
/**
 * Reruns of checks that were only cancelled or timed out, per PR head (design 05-ci-gate, Cancelled checks); after
 * them the item waits on checks_pending with a `ci_rerun_failed` alert.
 */
const MAX_CANCELLED_RERUNS = 3;
/** One `ci_rerun_failed` alert per item and head in this window, the alarms' 6 hours (core/alarms.ts, ALERT_DEDUPE_MS). */
const RERUN_ALERT_DEDUPE_MS = 6 * 3_600_000;
/** Failing tests, and characters, of a failed job's log kept for the implement run's input. */
const MAX_FAILING_TESTS = 10;
const MAX_FAILING_CHARS = 4000;
/** Failing tests read from each log for the red-main comparison (design 05-ci-gate, Red main). */
const MAX_COMPARED_TESTS = 200;
/** blocked_reason prefix (with `blocked_on: ci`) of a PR whose every failed check fails on the base too; the first name follows. */
const MAIN_RED = "main is red: ";
/** The state changes whose `note` the review's "Notes from the approver" reads (the worker's approverNotes; `owner_note`: commands/note.ts). */
const NOTE_REASONS = ["spec_approved", "floor_tier_approved", "rule_of_two_approved", "retry_requested", "owner_note"];
/** The item fields that hold the spec the review reads; a state change that changes one wrote a new spec. */
const SPEC_FIELDS = ["problem", "done_criteria", "allowed_paths"] as const;
/** Items waiting on checks looked at per tick. */
const CHECKS_BATCH = 50;
/** Check names kept per decision and per review input, and characters per name. */
const MAX_CHECK_NAMES = 20;
const MAX_CHECK_NAME_CHARS = 100;
/** A reviewed PR whose checks have not finished (design §5 CI gate), or whose failed jobs rerun (design 05-ci-gate). */
function waitingOnChecks(it: WorkItem): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "ci" && (it.blocked_reason === CHECKS_PENDING || it.blocked_reason === CHECKS_RERUN);
}
/** A reviewed PR waiting for its base to turn green (design 05-ci-gate, Red main). */
function waitingOnMain(it: WorkItem): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "ci" && (it.blocked_reason?.startsWith(MAIN_RED) ?? false);
}
/** An item the checks step reads again each tick: its checks pending, or its base red. */
function waitingOnCi(it: WorkItem): boolean {
  return waitingOnChecks(it) || waitingOnMain(it);
}

/** The CI gate: a reviewed PR waits for its checks; failed checks send it back or block it. */
export class ChecksGateUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * The base checks read during one checks step, shared by every item that step decides (so items on one base head
   * share one read); dropped when the step ends. Null outside a step, where each decision reads once.
   */
  private stepBase: Promise<BaseChecks | null> | null = null;
  /** The base head's failed job log read during one checks step, shared like stepBase; dropped when the step ends. */
  private stepBaseLog: Promise<string | null> | null = null;
  private inStep = false;

  /**
   * The CI gate (design §5): a PR that passed review is offered for a human merge only once its checks
   * passed. Pending (or the source could not say): the item waits in `REVIEW` with `blocked_on: ci` /
   * `checks_pending`, and tickChecks looks again. Failed: checksFailed (an update first, a red-base wait, a
   * failed-jobs rerun once, an unchanged-head block, or back to implement like a review bug), with the failing check
   * names on the state change.
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
    if (checks.state === "failed") return this.checksFailed(it, review, checks, fields, ack);
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
   * counted), and the item waits in REVIEW on `checks_failed_update`. When every failed check also fails on the base
   * branch, and every failing test the PR head's failed job log names also fails in the base head's log (when both
   * logs name tests), the item waits in REVIEW on `main is red: <first name>` (no run, no loop); the checks step reads
   * it again. Tests failing on both are main's: the sent-back comment and `ci_failing_tests` name only the others.
   * Checks that were all cancelled or timed out (no update due) are no code failure: rerunCancelled, never a loop.
   * A first failure on the reviewed head reruns its failed jobs once and waits in REVIEW on `checks_rerun` (no run, no
   * loop); back to implement after that rerun, the run's input carries the failing tests of the failed job's log. A
   * review that skipped an unchanged head blocks on a human with `unchanged_head` (no run, no loop). Otherwise
   * back to implement like a review bug (loop_count + 1), or at `max_loops` a block on a human. The state change of
   * a review that skipped an unchanged head carries `unchanged_head: true`.
   */
  async checksFailed(
    it: WorkItem,
    review: Run,
    checks: { failed: readonly string[]; cancelled?: readonly string[] },
    fields: { tier?: Tier; token_cost?: number },
    ack: { ack_run?: RunId },
  ): Promise<Decision> {
    const { failed } = checks;
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
    const head = typeof data.head_sha === "string" ? data.head_sha : "";
    if (failed.length > 0 && failed.every((n) => checks.cancelled?.includes(n))) return this.rerunCancelled(it, reviewRunId, head, names, fields, detail, ack);
    let prLog: Promise<string | null> | null = null;
    const readPrLog = () => (prLog ??= this.readLog(it, head));
    const red = await this.redMain(it, failed, readPrLog);
    if (red.main) {
      const blocked_reason = `${MAIN_RED}${names[0]}`;
      // Still red on a later step: nothing changes (a review being applied is still acked).
      if (!ack.ack_run && it.blocked_on === "ci" && it.blocked_reason === blocked_reason) return null;
      const base = this.c.k.cfg.repo.base_branch;
      await this.checksComment(it, `main-red:${reviewRunId}`, names, (list) =>
        `PR #${it.change_ref} passed review but its checks failed${list}, and the same checks fail on \`${base}\`. The factory starts no loop: it waits, and goes on by itself once \`${base}\` is green again.`);
      return { patch: { ...fields, blocked_on: "ci", blocked_reason }, actor: SYSTEM, reason: "main_red", detail, ...ack };
    }
    const rerun = await this.rerunOnce(it, head);
    if (rerun === "rerun") {
      await this.checksComment(it, `checks-rerun:${reviewRunId}`, names, (list) =>
        `PR #${it.change_ref} passed review but its checks failed${list}. The factory reran the failed jobs once on the same head and waits for them; if they fail again, it sends the change back to the implementer.`);
      return {
        patch: { ...fields, blocked_on: "ci", blocked_reason: CHECKS_RERUN },
        actor: SYSTEM,
        reason: CHECKS_RERUN,
        detail: { ...detail, rerun_head: head },
        ...ack,
      };
    }
    if (data.no_agent === UNCHANGED_HEAD) {
      const patch = { ...fields, blocked_on: "human" as const, blocked_reason: UNCHANGED_HEAD };
      await this.checksComment(it, `unchanged-head:${reviewRunId}`, names, (list) =>
        `PR #${it.change_ref} passed review but its checks failed${list}, and the last implement run pushed no commit. The factory starts no new loop (loop ${it.loop_count} of ${this.c.k.cfg.max_loops}). A human needs to decide.\n\n${footerAfter(it, patch)}`);
      return { patch, actor: SYSTEM, reason: UNCHANGED_HEAD, detail, ...ack };
    }
    const loop = it.loop_count + 1;
    if (loop >= this.c.k.cfg.max_loops) {
      const patch = { ...fields, blocked_on: "human" as const, blocked_reason: "max_loops" };
      await this.checksComment(it, `max-loops:${reviewRunId}`, names, (list) =>
        `PR #${it.change_ref} passed review but its checks failed${list}. That makes ${loop} loops (limit ${this.c.k.cfg.max_loops}). A human needs to decide.\n\n${footerAfter(it, patch)}`);
      return { patch, actor: SYSTEM, reason: "max_loops", detail, ...ack };
    }
    const next = { ...it, loop_count: loop };
    const log = rerun === "reran" ? await readPrLog() : null;
    const tests = log === null ? null : await this.failingTests(log, red.excused);
    const own = red.own?.length ? red.own.slice(0, MAX_CHECK_NAMES).map((n) => n.slice(0, MAX_CHECK_NAME_CHARS)) : null;
    const what = own ? `tests failed that pass on \`${this.c.k.cfg.repo.base_branch}\`` : "its checks failed";
    await this.checksComment(it, `checks-failed:${reviewRunId}`, own ?? names, (list) =>
      `PR #${it.change_ref} passed review but ${what}${list}. The factory sent it back to the implementer (loop ${loop} of ${this.c.k.cfg.max_loops}).`);
    return {
      patch: { ...fields, stage: "RUNNING", blocked_on: "none", blocked_reason: null, loop_count: loop },
      actor: SYSTEM,
      reason: "checks_failed",
      detail,
      ...ack,
      enqueue: { kind: "implement", idempotency_key: runKey(next, "implement"), ...(tests ? { input: { ci_failing_tests: tests } } : {}) },
    };
  }

  /**
   * Rerun once (design 05-ci-gate): with a forge that can rerun and a known reviewed `head`, the first failure on that
   * head reruns its failed jobs ("rerun"). The rerun is recorded only by the `checks_rerun` state change the caller
   * writes, in the store with the item, so a restart or another replica never reruns the same head again: a failure
   * after it is "reran". No such forge, no head, or a rerun that throws (logged; e.g. a token without the Actions
   * write permission): "none", nothing recorded, the path as before.
   */
  private async rerunOnce(it: WorkItem, head: string): Promise<"rerun" | "reran" | "none"> {
    const forge = this.c.k.reader.forge;
    if (!forge?.rerunFailedJobs || head === "") return "none";
    const reran = (await this.c.k.reader.listStateChanges(it.id)).some((c) => c.reason === CHECKS_RERUN && c.detail?.rerun_head === head && c.detail.cancelled !== true);
    if (reran) return "reran";
    try {
      await forge.rerunFailedJobs(head);
      return "rerun";
    } catch (err) {
      this.c.k.d.log.warn("rerunning failed CI jobs failed", { work_item_id: it.id, head_sha: head, error: errorText(err) });
      return "none";
    }
  }

  /**
   * Checks that were all cancelled or timed out (design 05-ci-gate, Cancelled checks): a stopped job, not a code
   * failure, so no loop is counted and `max_loops` is never reached this way. Up to MAX_CANCELLED_RERUNS times per
   * head the cancelled jobs rerun (the forge's rerunFailedJobs reruns cancelled jobs too) and the item waits on
   * `checks_rerun`, the state change's detail `cancelled: true` so the rerun-once of a real failure stays its own.
   * No rerun (no forge rerun, no head, the cap reached, or a rerun that throws, logged): the item waits on
   * `checks_pending` with one `ci_rerun_failed` alert per item and head; the checks step tries again each tick.
   */
  private async rerunCancelled(
    it: WorkItem,
    reviewRunId: RunId,
    head: string,
    names: string[],
    fields: { tier?: Tier; token_cost?: number },
    detail: NonNullable<NonNullable<Decision>["detail"]>,
    ack: { ack_run?: RunId },
  ): Promise<Decision> {
    const forge = this.c.k.reader.forge;
    const prior = (await this.c.k.reader.listStateChanges(it.id))
      .filter((c) => c.reason === CHECKS_RERUN && c.detail?.rerun_head === head && c.detail.cancelled === true).length;
    let why: string | null = null;
    if (!forge?.rerunFailedJobs) why = "the forge cannot rerun CI jobs";
    else if (head === "") why = "the review recorded no head commit";
    else if (prior >= MAX_CANCELLED_RERUNS) why = `they were cancelled again after ${prior} reruns`;
    else {
      try {
        await forge.rerunFailedJobs(head);
      } catch (err) {
        why = errorText(err);
        this.c.k.d.log.warn("rerunning cancelled CI jobs failed", { work_item_id: it.id, head_sha: head, error: why });
      }
    }
    if (why === null) {
      await this.checksComment(it, `checks-cancelled:${reviewRunId}:${prior + 1}`, names, (list) =>
        `PR #${it.change_ref} passed review but its checks were cancelled${list}. That is no code failure: the factory reran the cancelled jobs on the same head (rerun ${prior + 1} of ${MAX_CANCELLED_RERUNS}) and waits for them, with no loop counted.`);
      return {
        patch: { ...fields, blocked_on: "ci", blocked_reason: CHECKS_RERUN },
        actor: SYSTEM,
        reason: CHECKS_RERUN,
        detail: { ...detail, rerun_head: head, cancelled: true },
        ...ack,
      };
    }
    const text = `The cancelled CI jobs of PR #${it.change_ref} (${it.id}) at ${head.slice(0, 12) || "an unknown head"} were not rerun: ${why}. The item waits on its checks with no loop counted; rerun them on the forge or push a new commit.`;
    const scan = await this.c.k.reader.scan("ui", text);
    await this.c.k.commit({ writes: [{
      kind: "alert", dedupe_ms: RERUN_ALERT_DEDUPE_MS,
      alert: { pattern: "ci_rerun_failed", pattern_key: `ci_rerun_failed:${it.id}:${head}`, error_code: "ci_rerun_failed", count: prior, detail: scan.clean ? text : null },
    }] });
    if (!ack.ack_run && it.blocked_on === "ci" && it.blocked_reason === CHECKS_PENDING) return null;
    return { patch: { ...fields, blocked_on: "ci", blocked_reason: CHECKS_PENDING }, actor: SYSTEM, reason: CHECKS_PENDING, detail, ...ack };
  }

  /**
   * The failed job's log of commit `sha`; null when the forge has no log read, there is no sha, or the read throws
   * (logged; e.g. a token without the Actions read permission).
   */
  private async readLog(it: WorkItem, sha: string): Promise<string | null> {
    const forge = this.c.k.reader.forge;
    if (!forge?.failedJobLog || sha === "") return null;
    try {
      return await forge.failedJobLog(sha);
    } catch (err) {
      this.c.k.d.log.warn("reading the failed CI job's log failed", { work_item_id: it.id, head_sha: sha, error: errorText(err) });
      return null;
    }
  }

  /**
   * The failing tests in a PR head's failed job `log`, for the implement run's input: each vitest `FAIL` line with
   * its first error line, those in `excused` (failing on the base too) left out, at most MAX_FAILING_TESTS tests and
   * MAX_FAILING_CHARS characters, whole tests only. Forge text (G5): every test name and message the egress scan flags
   * is redacted before the cut. Null when the log names no failing test of the item's own.
   */
  private async failingTests(log: string, excused: ReadonlySet<string>): Promise<string | null> {
    const tests = failingTestDetails(log, MAX_COMPARED_TESTS).filter((t) => !excused.has(t.test)).slice(0, MAX_FAILING_TESTS);
    const flagged: string[] = [];
    for (const text of tests.flatMap((t) => (t.message ? [t.test, t.message] : [t.test]))) {
      if (!(await this.c.k.reader.scan("tool_result", text)).clean) flagged.push(text);
    }
    const blocks = tests.map((t) => [`FAIL ${redact(t.test, flagged)}`, ...(t.message ? [`  ${redact(t.message, flagged)}`] : [])].join("\n"));
    const kept: string[] = [];
    let chars = 0;
    for (const block of blocks) {
      chars += block.length + (kept.length ? 1 : 0);
      if (chars > MAX_FAILING_CHARS) break;
      kept.push(block);
    }
    if (kept.length === 0 && blocks.length > 0) kept.push(blocks[0]!.slice(0, MAX_FAILING_CHARS));
    return kept.length ? kept.join("\n") : null;
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

  /**
   * Red main (design 05-ci-gate): whether the PR's failure is the base branch's. A base that is not read (no forge
   * read for it, pending, or an error, logged) is not red: the normal path. Every one of the PR's `failed` checks must
   * also fail on the base. Then the failing tests are compared: those in the PR head's failed job log (`prLog`) that
   * also fail in the base head's log are `excused`; any other (`own`) counts against the item. When either log is not
   * read or names no test, the check names alone decide (`own` null).
   */
  private async redMain(
    it: WorkItem,
    failed: readonly string[],
    prLog: () => Promise<string | null>,
  ): Promise<{ main: boolean; own: string[] | null; excused: ReadonlySet<string> }> {
    const none = { own: null, excused: new Set<string>() };
    if (failed.length === 0) return { main: false, ...none };
    const base = await this.readBase(it);
    if (base?.state !== "failed" || !failed.every((n) => base.failed.includes(n))) return { main: false, ...none };
    const prTests = testNames(await prLog());
    if (prTests.length === 0) return { main: true, ...none };
    const baseTests = new Set(testNames(await this.readBaseLog(it, base.head_sha ?? "")));
    if (baseTests.size === 0) return { main: true, ...none };
    const own = prTests.filter((t) => !baseTests.has(t));
    return { main: own.length === 0, own, excused: new Set(prTests.filter((t) => baseTests.has(t))) };
  }

  /** The base head's failed job log: once per checks step (shared), else once per call. */
  private readBaseLog(it: WorkItem, sha: string): Promise<string | null> {
    if (!this.inStep) return this.readLog(it, sha);
    return (this.stepBaseLog ??= this.readLog(it, sha));
  }

  /** The base checks: once per checks step (shared), else once per call; null when the forge has no such read or it failed. */
  private readBase(it: WorkItem): Promise<BaseChecks | null> {
    const forge = this.c.k.reader.forge;
    if (!forge?.baseChecks) return Promise.resolve(null);
    const read = () => forge.baseChecks!().catch((err: unknown) => {
      this.c.k.d.log.warn("reading base checks failed", { work_item_id: it.id, error: errorText(err) });
      return null;
    });
    if (!this.inStep) return read();
    return (this.stepBase ??= read());
  }

  /** Whether the item's latest review with a verdict, other than run `self`, passed. */
  async lastVerdictPassed(id: WorkItemId, self: RunId): Promise<boolean> {
    return (await this.lastVerdict(id, self))?.verdict === "pass";
  }

  /** The item's latest review with a verdict, other than run `self`, and that verdict; null when none parses. */
  async lastVerdict(id: WorkItemId, self: RunId | null = null): Promise<{ run: Run; verdict: ReviewOutput["verdict"] } | null> {
    const last = (await this.c.k.reader.listRuns(id))
      .filter((r) => r.kind === "review" && r.id !== self && r.outcome?.status === "succeeded" && r.outcome.data.review != null)
      .at(-1);
    if (last?.outcome?.status !== "succeeded") return null;
    const parsed = parseReview(last.outcome.data.review);
    return parsed.ok ? { run: last, verdict: parsed.value.verdict } : null;
  }

  /**
   * What the review reads that changed after `verdict` started (design 05-ci-gate, 2026-11-23): an approver note (an
   * approval's, a `/retry` note or an owner `/note`, as the worker's "Notes from the approver" reads them) or a new
   * spec (problem, done criteria or allowed paths). The newest note's text, or null for a spec; null when nothing is newer.
   */
  async newerThanVerdict(it: WorkItem, verdict: Run): Promise<{ what: "note" | "spec"; note: string | null } | null> {
    const since = verdict.started_at ?? verdict.created_at;
    const later = (await this.c.k.reader.listStateChanges(it.id)).filter((c) => c.at > since);
    const note = later.filter((c) => NOTE_REASONS.includes(c.reason) && typeof c.detail?.note === "string" && c.detail.note.trim() !== "").at(-1);
    if (note) return { what: "note", note: String(note.detail!.note) };
    return later.some((c) => SPEC_FIELDS.some((f) => f in c.changes)) ? { what: "spec", note: null } : null;
  }

  /**
   * A review's `bug` verdict on a factory branch (design 05-ci-gate): back to implement with its findings
   * (loop_count + 1), or at `max_loops` a block on a human with one comment keyed on `run`. A fresh verdict and an
   * unchanged head after one (run-results' unchangedHead) both send the item back here; `detail` says which.
   */
  async reviewBug(it: WorkItem, run: Run, fields: { tier?: Tier; token_cost?: number }, detail?: NonNullable<Decision>["detail"]): Promise<Decision> {
    const loop = it.loop_count + 1;
    const extra = detail ? { detail } : {};
    if (loop >= this.c.k.cfg.max_loops) {
      const patch = { ...fields, blocked_on: "human" as const, blocked_reason: "max_loops" };
      await this.c.unit("outbox").comment(it, `max-loops:${run.id}`,
        `Review found bugs ${loop} times (limit ${this.c.k.cfg.max_loops}). A human needs to decide.\n\n${footerAfter(it, patch)}`);
      return { patch, actor: SYSTEM, reason: "max_loops", ...extra, ack_run: run.id };
    }
    return {
      patch: { ...fields, stage: "RUNNING", blocked_on: "none", blocked_reason: null, loop_count: loop },
      actor: SYSTEM,
      reason: "review_bug",
      ...extra,
      ack_run: run.id,
      enqueue: { kind: "implement", idempotency_key: runKey({ ...it, loop_count: loop }, "implement") },
    };
  }

  /** The PR's checks, from the forge whatever source the item came from; no forge counts as passed, a forge error as pending (logged). */
  async readChecks(it: WorkItem): Promise<PrChecks> {
    const forge = this.c.k.reader.forge;
    const pr = prNumber(it);
    if (!forge || pr === null) return { state: "passed" };
    try {
      return await forge.prChecks(pr);
    } catch (err) {
      this.c.k.d.log.warn("reading PR checks failed", {
        work_item_id: it.id,
        change_ref: it.change_ref,
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
  async reviewInput(pr: number | null, work_item_id: WorkItemId | null): Promise<RunInput> {
    const forge = this.c.k.reader.forge;
    if (!forge || pr === null) return { ci_checks: [] };
    try {
      const results = await forge.prCheckResults(pr);
      return { ci_checks: results.slice(0, MAX_CHECK_NAMES).map((r) => ({ name: r.name.slice(0, MAX_CHECK_NAME_CHARS), result: r.result })) };
    } catch (err) {
      this.c.k.d.log.warn("reading PR check results failed", {
        ...(work_item_id ? { work_item_id } : {}),
        change_ref: String(pr),
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
    this.inStep = true;
    try {
      await this.decideWaiting();
    } finally {
      this.inStep = false;
      this.stepBase = null;
      this.stepBaseLog = null;
    }
  }

  /** The checks step's items: those waiting on CI, then those stalled after an unchanged head. */
  private async decideWaiting(): Promise<void> {
    const waiting = await this.c.k.reader.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "ci", limit: CHECKS_BATCH });
    for (const w of waiting) {
      if (!waitingOnCi(w)) continue;
      const review = await this.c.unit("run-results").latestReview(w.id);
      if (!review) continue;
      await this.c.k.guard("checks", () => this.c.unit("transitions").decide(w.id, (it) => (waitingOnCi(it) ? this.checkGate(it, review, {}, null) : null)).then(() => undefined));
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
        return checks.state === "failed" ? this.checksFailed(it, review, checks, {}, {}) : null;
      }).then(() => undefined));
    }
  }

  /** In REVIEW with no block and no blocked reason, and no run queued, running or not yet applied: nothing will look at it again. */
  async stalled(it: WorkItem): Promise<boolean> {
    if (it.stage !== "REVIEW" || it.blocked_on !== "none" || it.blocked_reason !== null) return false;
    return !(await this.c.k.reader.listRuns(it.id)).some((r) => r.status === "queued" || r.status === "running" || r.acknowledged_at === null);
  }
}

/** The failing tests a failed job's log names; none for no log. */
function testNames(log: string | null): string[] {
  return log === null ? [] : failingTestDetails(log, MAX_COMPARED_TESTS).map((t) => t.test);
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
