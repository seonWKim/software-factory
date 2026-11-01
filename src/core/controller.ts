import {
  BUDGET_CHECKPOINT,
  DEFAULT_BUDGET_MIN_SAMPLE,
  checkpointComment,
  currentBudget,
  overBudget,
  parseBudgetAmount,
  suggestBudget,
  tierBudget,
} from "./budget.js";
import { commandFooter, commandState, failedRunKind, helpReply, unknownCommandReply } from "./commands.js";
import type { FactoryConfig } from "./config.js";
import { Listener } from "./listener.js";
import { parseFixReferences, parseRevert } from "./links.js";
import type { Logger } from "./log.js";
import { parseReview, parseTriage } from "./outputs.js";
import {
  type FailureClass,
  effectiveTier,
  failureClass,
  floorTier,
  needsSpecApproval,
  retryDelayMs,
  retryKey,
  runKey,
  sameStep,
  workItemIdFromBranch,
} from "./policy.js";
import { renderSpec } from "./spec-comment.js";
import { type WorkStatus, statusOf } from "./status-label.js";
import type { Actor, Run, RunKind, SourceRef, StateChangeDetail, Tier, Timestamp, WorkItem, WorkItemId } from "./types.js";
import { type ParsedVerdict, parseVerdict } from "./verdict.js";
import type { AuthAction, AuthProvider, ExternalIdentity, Principal } from "../interfaces/auth-provider.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore, NewBudgetCheckpoint, TransitionInput } from "../interfaces/factory-store.js";
import type { PollSource, SourceAdapter, SourceEvent, StreamSource } from "../interfaces/source-adapter.js";

export interface ControllerDeps {
  store: FactoryStore;
  source: SourceAdapter;
  auth: AuthProvider;
  clock: Clock;
  config: FactoryConfig;
  log: Logger;
  /** G5: the last-attempt comment carries run output, so it is scanned before it is posted. */
  scanner: EgressScanner;
  /**
   * This replica's id, the owner of a stream source's listener lease while it holds it. Absent: a random
   * id per Controller. Unused for poll sources.
   */
  replica_id?: string;
}

type Decision = Omit<TransitionInput, "id" | "expected_version"> | null;
/** A decision whose implement or review run is held at a budget checkpoint instead of queued. */
type Hold = Omit<TransitionInput, "id" | "expected_version" | "enqueue"> & { checkpoint: NewBudgetCheckpoint };
/** Why a human's command was not applied; posted back to them. Plain null stays a silent no-op. */
type Refusal = { refuse: string };
type CommandEvent = Extract<SourceEvent, { kind: "spec_approved" | "spec_rejected" | "revise_requested" | "retry_requested" | "budget_continue" | "resolve_requested" }>;
type ItemCommandEvent = Exclude<CommandEvent, { kind: "budget_continue" }>;
type ResolveEvent = Extract<SourceEvent, { kind: "resolve_requested" }>;
type BaseCommitEvent = Extract<SourceEvent, { kind: "base_commit" }>;
type VerdictEvent = Extract<SourceEvent, { kind: "verdict_submitted" }>;
type SourceClosedEvent = Extract<SourceEvent, { kind: "source_closed" }>;
type InfoEvent = Extract<SourceEvent, { kind: "help_requested" | "unknown_command" }>;

const COMMAND: Record<CommandEvent["kind"], string> = {
  spec_approved: "/approve",
  spec_rejected: "/reject",
  revise_requested: "/revise",
  retry_requested: "/retry",
  resolve_requested: "/resolve",
  budget_continue: "/budget",
};
/** Tells applyCommand to re-read the item and try again (a version conflict or a concurrent answer). */
const RETRY = Symbol("retry");

const SYSTEM: Actor = { kind: "system", id: "system:controller" };
/** Records reverts and fix-forwards (design §6). */
const LINKS: Actor = { kind: "system", id: "system:links" };
/** Closes an item whose source was closed by someone the factory cannot name (design §4). */
const INTAKE: Actor = { kind: "system", id: "system:intake" };
const MAX_CONFLICT_RETRIES = 5;
/** Characters of an approval note kept on the state change (design §4). */
const MAX_NOTE_CHARS = 2000;
/** blocked_reason of an item whose diff touches a floor above its tier (design §4). */
const FLOOR_TIER = "floor_tier";
/** blocked_reason of a PR whose base no longer merges cleanly; `/resolve` starts a resolve run (design §5). */
const CONFLICT_PENDING = "merge_conflict_pending";
/** error_code of an implement run whose diff is over max_diff_lines or max_diff_files (design §4). */
const DIFF_TOO_LARGE = "diff_too_large";
/** Items the start-up status catch-up reads (newest first). Past this, a warning; the rest stay as they are. */
const CATCH_UP_LIMIT = 1000;
/** Patch fields that can change an item's status or where it is shown. */
const STATUS_FIELDS = ["stage", "blocked_on", "blocked_reason", "close_reason", "pr_number"] as const;
/**
 * A rejected item whose source still needs the reject comment and the close: `CLOSED` with
 * `blocked_on: upstream` and this reason until both are done (design §4, gate commands).
 */
const SOURCE_CLOSE_PENDING = "source_close_pending";
/** Rejected items finished per intake tick. */
const CLOSE_BATCH = 50;
/** Inbox rows a stream intake step reads at most per tick. */
const INBOX_BATCH = 100;
const DAY_MS = 86_400_000;

/** The cursor a stream source's inbox is read through (one per source type, shared by every replica). */
export function inboxCursorName(type: SourceAdapter["type"]): string {
  return `inbox:${type}`;
}

/**
 * Control plane: intake, applying run outcomes, the reaper. Deterministic, no LLM: every decision re-reads
 * the store and lands as a conditional transition, so N replicas are safe. The only in-process state is the
 * reaper's own tick time (see tickReaper), which no other replica needs.
 */
export class Controller {
  /**
   * Reaper grace after this process's own sleep. Per process, not shared between replicas, and not stored:
   * it only stops this reaper from reaping workers on the same host that slept with it before they can
   * renew. Losing it (restart) just means no grace for one tick. A reaper on a host that did not sleep
   * gets no grace and can still requeue a sleeping worker's run once lease_ms passes (design §5).
   */
  private lastReaperTick: number | null = null;
  private reaperGraceUntil = -Infinity;

  constructor(private readonly d: ControllerDeps) {}

  async run(signal: AbortSignal): Promise<void> {
    const source = this.d.source;
    // Stream source: this process also runs a listener; the store lease lets only one replica's subscribe.
    const listening = source.intake === "stream" ? this.listener(source).run(signal) : Promise.resolve();
    await this.guard("status catch-up", () => this.catchUpStatus());
    let lastPoll = -Infinity;
    while (!signal.aborted) {
      const now = this.d.clock.now().getTime();
      const due = now - lastPoll >= this.d.config.poll_interval_ms;
      if (due) lastPoll = now;
      // A poll source is asked on its interval; an inbox is a store read, so it is read every tick.
      if (due || source.intake === "stream") await this.guard("intake", () => this.tickIntake());
      if (due && source.intake === "stream") await this.guard("inbox cleanup", () => this.cleanupInbox());
      await this.guard("runs", () => this.tickRuns());
      await this.guard("reaper", () => this.tickReaper());
      await this.d.clock.sleep(this.d.config.tick_ms, signal).catch(() => undefined);
    }
    await listening;
  }

  /** The listener for a stream source, owned by this replica. */
  listener(source: StreamSource): Listener {
    return new Listener({
      store: this.d.store,
      source,
      clock: this.d.clock,
      config: this.d.config,
      log: this.d.log,
      owner: this.d.replica_id ?? `controller:${Math.random().toString(36).slice(2, 12)}`,
    });
  }

  async tickIntake(): Promise<void> {
    const source = this.d.source;
    if (source.intake === "stream") return this.tickInbox(source);
    return this.tickPoll(source);
  }

  private async tickPoll(source: PollSource): Promise<void> {
    const name = `intake:${source.type}`;
    const cursor = await this.d.store.getCursor(name);
    const { events, next_cursor } = await source.poll(cursor);
    for (const e of events) await this.guard(`event:${e.kind}`, () => this.handleEvent(e));
    await this.d.store.advanceCursor(name, cursor, next_cursor);
    await this.guard("source closes", () => this.tickSourceCloses());
  }

  /**
   * Finishes rejects whose comment or close did not happen (the factory stopped, or the source failed):
   * every rejected item still marked `source_close_pending` gets them now. Safe to repeat: the comment
   * carries a marker and is posted once; closing a closed issue changes nothing.
   */
  async tickSourceCloses(): Promise<void> {
    const pending = await this.d.store.listWorkItemsWhere({ stage: "CLOSED", blocked_on: "upstream", limit: CLOSE_BATCH });
    for (const it of pending) {
      if (closePending(it)) await this.guard("source close", () => this.finishReject(it.id));
    }
  }

  /**
   * Stream intake, controller side: the inbox rows after the cursor, each handled like a polled event, then
   * the cursor moves to the last one. Any replica may run it; handling is idempotent and the cursor moves
   * only from the value read, so two replicas at once at worst handle a row twice.
   */
  private async tickInbox(source: StreamSource): Promise<void> {
    const name = inboxCursorName(source.type);
    const cursor = await this.d.store.getCursor(name);
    const rows = await this.d.store.listInboxAfter(source.type, inboxSeq(cursor), INBOX_BATCH);
    if (rows.length === 0) return;
    for (const row of rows) await this.guard(`event:${row.event.kind}`, () => this.handleEvent(row.event));
    await this.d.store.advanceCursor(name, cursor, String(rows.at(-1)!.seq));
  }

  /**
   * Deletes inbox rows older than inbox_retention_days that the cursor has passed. A source with no cursor
   * yet keeps every row.
   */
  async cleanupInbox(): Promise<void> {
    const source = this.d.source;
    if (source.intake !== "stream") return;
    const cursor = await this.d.store.getCursor(inboxCursorName(source.type));
    if (cursor === null) return;
    const deleted = await this.d.store.pruneInbox(source.type, inboxSeq(cursor), this.d.config.inbox_retention_days * DAY_MS);
    if (deleted > 0) this.d.log.info("inbox cleanup", { source_type: source.type, deleted });
  }

  async tickRuns(): Promise<void> {
    for (const run of await this.d.store.listUnacknowledgedRuns(20)) {
      await this.guard(`run:${run.kind}`, () => this.applyRun(run));
    }
  }

  /**
   * Re-applies the status of every open item, so items from before status labels existed, and any label
   * write that failed or landed out of order, are corrected on start. Each call is idempotent and guarded.
   */
  async catchUpStatus(): Promise<void> {
    const items = await this.d.store.listWorkItems(CATCH_UP_LIMIT);
    if (items.length >= CATCH_UP_LIMIT) {
      this.d.log.warn("status catch-up hit its limit", { limit: CATCH_UP_LIMIT });
    }
    for (const it of items) if (it.stage !== "CLOSED") await this.showStatus(it);
  }

  async tickReaper(): Promise<void> {
    const now = this.d.clock.now().getTime();
    const previous = this.lastReaperTick;
    this.lastReaperTick = now;
    if (previous !== null && now - previous > this.d.config.lease_ms) {
      // This process slept (or stalled) longer than a lease: every lease looks expired, including those of
      // workers that slept with us and are about to renew. Give them one heartbeat_ms first.
      this.reaperGraceUntil = now + this.d.config.heartbeat_ms;
      this.d.log.warn("reaper woke after a gap; grace before expiring leases", { gap_ms: now - previous });
    }
    if (now < this.reaperGraceUntil) return;
    const { max_attempts, retry_base_ms, retry_max_ms } = this.d.config;
    // An expired lease waits out the same backoff as any retry before another claim (design §5 Restarts).
    const ids = await this.d.store.expireLeases(max_attempts, (attempt) => retryDelayMs(attempt, retry_base_ms, retry_max_ms));
    for (const id of ids) this.d.log.warn("lease expired", { run_id: id });
  }

  // Source events

  async handleEvent(e: SourceEvent): Promise<void> {
    switch (e.kind) {
      case "item_requested": {
        const principal = await this.authorize(e.requester, "submit_work", e.source.id);
        if ("refuse" in principal) return;
        const { item, created } = await this.d.store.createWorkItem(
          {
            source: e.source,
            title: e.title,
            requester_id: principal.user_id,
            project: this.project(),
            problem: `${e.title}\n\n${e.body}`.trim(),
            resources: [e.source.link],
          },
          { kind: "user", id: principal.user_id },
          { enqueue: { kind: "triage", idempotency_key: `${e.source.type}:${e.source.id}:triage` } },
        );
        if (created) {
          this.d.log.info("intake", { work_item_id: item.id });
          await this.setStatus(item.source, "triaging", null);
        }
        await this.markSeen(e.source, null);
        // Every delivery re-checks the link, so a re-polled issue finishes a link a crash interrupted.
        await this.linkFixForward(item.id, `${e.title}\n${e.body}`);
        return;
      }
      case "base_commit":
        return this.recordReverts(e);
      case "source_closed":
        return this.closeFromSource(e);
      case "spec_approved":
      case "spec_rejected":
      case "revise_requested":
      case "retry_requested":
      case "resolve_requested":
      case "budget_continue":
        return this.handleCommand(e);
      case "verdict_submitted":
        return this.handleVerdict(e);
      case "help_requested":
      case "unknown_command":
        return this.handleInfo(e);
      case "pr_merged":
      case "pr_closed": {
        const id = workItemIdFromBranch(e.head_branch, this.d.config.branch_prefix);
        if (!id) return;
        // The human who merged is the approver of record (design §8). GitHub already enforced their permission.
        const merger = e.kind === "pr_merged" && e.merger ? await this.d.auth.resolve(e.merger) : null;
        const actor: Actor = merger ? { kind: "user", id: merger.user_id } : { kind: "system", id: "system:post-merge" };
        await this.decide(id as WorkItemId, (it) => {
          if (it.stage === "CLOSED" || it.pr_number !== e.pr_number) return null;
          return e.kind === "pr_merged"
            ? {
                patch: { stage: "CLOSED", close_reason: "completed", merge_sha: e.merge_sha, blocked_on: "none", blocked_reason: null },
                actor,
                reason: "pr_merged",
              }
            : {
                patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null },
                actor: { kind: "system", id: "system:post-merge" },
                reason: "pr_closed_unmerged",
              };
        });
        return;
      }
      case "pr_unmergeable": {
        const id = workItemIdFromBranch(e.head_branch, this.d.config.branch_prefix);
        if (!id) return;
        const key = `${id}:update:${e.pr_number}:${e.head_sha}:${e.base_sha}`;
        await this.decide(id as WorkItemId, async (it) => {
          if (!awaitingMerge(it) || it.pr_number !== e.pr_number) return null;
          // One update per (head, base), and none while another update of this item is still in flight.
          // The event repeats on every poll, so a skipped one comes back.
          const updates = (await this.d.store.listRuns(it.id)).filter((r) => r.kind === "update");
          if (updates.some((r) => r.idempotency_key === key || r.acknowledged_at === null)) return null;
          return { patch: {}, actor: SYSTEM, reason: "update_started", enqueue: { kind: "update", idempotency_key: key } };
        });
        return;
      }
    }
  }

  /**
   * A human command on a work item. Applied or not, the comment gets 👀; a refusal also gets one reply
   * saying why, keyed on the comment id. Commands on issues that are not work items are ignored entirely
   * (no reaction, no reply): they may be ordinary conversation on an unrelated issue.
   */
  private async handleCommand(e: CommandEvent): Promise<void> {
    const item = e.kind === "resolve_requested" && e.pr
      ? await this.itemOfPr(e.pr)
      : await this.d.store.getWorkItemBySource(e.source.type, e.source.id);
    if (!item) return;
    // /resolve uses the same write-permission check as /approve and /retry; no new AuthAction.
    const who = e.kind === "retry_requested" || e.kind === "revise_requested" || e.kind === "resolve_requested" ? e.requester : e.approver;
    const principal = await this.authorize(who, "approve_spec", item.id);
    let refusal: string | null;
    if ("refuse" in principal) refusal = principal.refuse;
    else {
      // The note is untrusted text bound for the store and agent prompts: G5 before either.
      const note = e.kind === "spec_approved" ? await this.approvalNote(item.id, e.note) : { note: null };
      refusal = "refuse" in note
        ? note.refuse
        : await this.applyCommand(item.id, e, { kind: "user", id: principal.user_id }, note.note);
    }
    await this.markSeen(e.source, e.comment_id);
    if (e.kind === "spec_rejected" && refusal === null) {
      // Best effort here; tickSourceCloses retries whatever did not happen.
      try {
        await this.finishReject(item.id);
      } catch (err) {
        this.d.log.warn("reject comment or close failed; retried on the next tick", {
          work_item_id: item.id,
          error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
        });
      }
    }
    if (refusal === null) return;
    this.d.log.info("command refused", { work_item_id: item.id, command: e.kind, reason: refusal });
    // A /resolve sent on the PR is answered on the PR; every other command on the item's own issue.
    await this.d.source.postComment(
      e.kind === "resolve_requested" ? e.source : item.source,
      `\`${COMMAND[e.kind]}\` was not applied: ${refusal}.`,
      `<!-- factory:refused:${e.comment_id} -->`,
    );
  }

  /** The work item of a factory PR, from its head branch; null unless that item's PR is this one. */
  private async itemOfPr(pr: { pr_number: number; head_branch: string }): Promise<WorkItem | null> {
    const id = workItemIdFromBranch(pr.head_branch, this.d.config.branch_prefix);
    if (!id) return null;
    const it = await this.d.store.getWorkItem(id as WorkItemId);
    return it && it.pr_number === pr.pr_number ? it : null;
  }

  /**
   * `/budget` and `/reject` at a budget checkpoint answer it (design §6); every other command, and `/reject`
   * elsewhere, goes through `command`. Returns the refusal reason, else null.
   */
  private async applyCommand(
    id: WorkItemId,
    e: CommandEvent,
    actor: Extract<Actor, { kind: "user" }>,
    note: string | null,
  ): Promise<string | null> {
    for (let i = 0; i < MAX_CONFLICT_RETRIES; i++) {
      const it = await this.d.store.getWorkItem(id);
      if (!it) return null;
      const atCheckpoint = it.stage !== "CLOSED" && it.blocked_reason === BUDGET_CHECKPOINT;
      if (atCheckpoint && (e.kind === "budget_continue" || e.kind === "spec_rejected")) {
        const r = await this.answerCheckpoint(it, e, actor);
        if (r === RETRY) continue;
        return r;
      }
      if (e.kind === "budget_continue") {
        return it.stage === "CLOSED" ? "the work item is closed" : "the work item is not at a budget checkpoint";
      }
      return this.decide(id, async (x) => this.command(e, x, actor, await this.floorTierNeeded(x), note));
    }
    this.d.log.warn("command gave up after conflicts", { work_item_id: id, command: e.kind });
    return null;
  }

  /**
   * The answer to the item's pending checkpoint, with the checkpoint row and its state change in one store
   * transaction. `/budget` grants the suggestion, or a whole number above the checkpoint's budget, and queues
   * the held run with its kind, key and not_before, unchecked. `/reject` closes the item and leaves the
   * branch and the PR as they are.
   */
  private async answerCheckpoint(
    it: WorkItem,
    e: Extract<CommandEvent, { kind: "budget_continue" | "spec_rejected" }>,
    actor: Extract<Actor, { kind: "user" }>,
  ): Promise<string | null | typeof RETRY> {
    const cp = (await this.d.store.listBudgetCheckpoints(it.id)).filter((c) => c.answer === "pending").at(-1);
    if (!cp) return "the budget checkpoint has no pending record";
    const common = { id: it.id, expected_version: it.version, actor, checkpoint_id: cp.id };
    let input: Parameters<FactoryStore["answerBudgetCheckpoint"]>[0];
    if (e.kind === "spec_rejected") {
      input = {
        ...common,
        patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null },
        reason: "budget_rejected",
        answer: "rejected",
        granted_budget: null,
        detail: { checkpoint_id: cp.id, held_run_key: cp.held_run_key },
      };
    } else {
      const amount = parseBudgetAmount(e.amount, cp.budget);
      if (!amount.ok) return amount.refuse;
      const granted = amount.value ?? cp.suggested_budget;
      const answer = amount.value === null ? "continued_suggested" : "continued_custom";
      input = {
        ...common,
        patch: { blocked_on: "none", blocked_reason: null },
        reason: "budget_continued",
        answer,
        granted_budget: granted,
        detail: { checkpoint_id: cp.id, answer, previous_budget: cp.budget, granted_budget: granted, held_run_key: cp.held_run_key },
        enqueue: { kind: cp.held_run_kind, idempotency_key: cp.held_run_key, not_before: cp.held_run_not_before },
      };
    }
    const r = await this.d.store.answerBudgetCheckpoint(input);
    if (r.ok) {
      this.d.log.info("transition", { work_item_id: it.id, reason: input.reason, version: r.item.version });
      await this.showStatus(r.item);
      return null;
    }
    if (r.reason === "version_conflict" || r.reason === "checkpoint_not_pending") return RETRY;
    this.d.log.warn("transition refused", { work_item_id: it.id, reason: r.reason });
    return null;
  }

  /**
   * The source issue was closed (design §4): the item closes as `wont_do` and its queued runs are cancelled in
   * the same transition. Store first: an item already CLOSED (by /reject, a merge, or an earlier delivery of
   * this close) is left alone, so a repeat or the factory's own close writes nothing. No login is checked and
   * nothing is posted. A run already running finishes; applyRun ignores its result because the item is closed.
   */
  private async closeFromSource(e: SourceClosedEvent): Promise<void> {
    const item = await this.d.store.getWorkItemBySource(e.source.type, e.source.id);
    if (!item || item.stage === "CLOSED") return;
    const closer = e.closer ? await this.d.auth.resolve(e.closer) : null;
    if (!closer) {
      this.d.log.warn("source closed by an unknown user; recorded as the system actor", { work_item_id: item.id, source_id: e.source.id });
    }
    const actor: Actor = closer ? { kind: "user", id: closer.user_id } : INTAKE;
    await this.decide(item.id, (it) =>
      it.stage === "CLOSED"
        ? null
        : {
            patch: { stage: "CLOSED", close_reason: "wont_do", blocked_on: "none", blocked_reason: null },
            actor,
            reason: "source_closed",
            cancel_queued_runs: true,
          },
    );
  }

  /**
   * The approval note to store: trimmed, capped at MAX_NOTE_CHARS, null when empty. The whole note is
   * egress-scanned first; a finding refuses the approval, and neither the note nor the rule's match is kept.
   */
  private async approvalNote(id: WorkItemId, raw: string | undefined): Promise<{ note: string | null } | Refusal> {
    const text = (raw ?? "").trim();
    if (!text) return { note: null };
    const scan = await this.d.scanner.scan("comment", text);
    if (!scan.clean) {
      const rules = scan.findings.map((f) => f.rule).join(",");
      this.d.log.warn("approval note blocked by the egress scan; approval refused", { work_item_id: id, rules });
      return {
        refuse: `the note was blocked by the leak scanner (\`${rules}\`), so it was not stored and nothing changed; post \`/approve\` again without the secret`,
      };
    }
    return { note: text.slice(0, MAX_NOTE_CHARS).trim() };
  }

  /**
   * `/help` or an unknown command on a work item: 👀, then one reply keyed on the comment id, listing the
   * commands for the item's current state. Like other commands, ignored entirely on an issue that is not one.
   */
  private async handleInfo(e: InfoEvent): Promise<void> {
    const item = await this.d.store.getWorkItemBySource(e.source.type, e.source.id);
    if (!item) return;
    await this.markSeen(e.source, e.comment_id);
    const state = commandState(item);
    const help = e.kind === "help_requested";
    await this.d.source.postComment(
      item.source,
      help ? helpReply(state) : unknownCommandReply(e.command, state),
      `<!-- factory:${help ? "help" : "unknown"}:${e.comment_id} -->`,
    );
  }

  /** For an item in a floor block, the tier its latest `floor_blocked` row says it needs; else null. */
  private async floorTierNeeded(it: WorkItem): Promise<number | null> {
    if (it.blocked_reason !== FLOOR_TIER) return null;
    const row = (await this.d.store.listStateChanges(it.id)).filter((c) => c.reason === "floor_blocked").at(-1);
    const tier = row?.detail?.required_tier;
    return typeof tier === "number" ? tier : null;
  }

  /**
   * A `/verdict` on a work item's issue or PR (design §4): stores one verdict and changes no field but the
   * version. Like the other commands: 👀 on the comment, and a refusal gets one reply on the issue keyed on
   * the comment id. A comment already stored is a silent no-op, so a redelivery never replies.
   */
  private async handleVerdict(e: VerdictEvent): Promise<void> {
    const item = await this.verdictItem(e);
    if (!item) return;
    const principal = await this.authorize(e.approver, "record_verdict", item.id);
    let refusal: string | null;
    if ("refuse" in principal) refusal = principal.refuse;
    else {
      const parsed = parseVerdict(e.args);
      refusal = parsed.ok ? await this.recordVerdict(item.id, e, principal, parsed.value) : parsed.refuse;
    }
    await this.markSeen(item.source, e.comment_id);
    if (refusal === null) return;
    // A refused comment that was stored before (e.g. a since-revoked permission) is not answered either.
    if ((await this.d.store.listVerdicts(item.id)).some((v) => v.comment_id === e.comment_id)) return;
    this.d.log.info("command refused", { work_item_id: item.id, command: e.kind, reason: refusal });
    await this.d.source.postComment(
      item.source,
      `\`/verdict\` was not applied: ${refusal}.`,
      `<!-- factory:refused:${e.comment_id} -->`,
    );
  }

  /** The work item a verdict names: by issue, or by the PR's head branch when that PR is the item's. */
  private async verdictItem(e: VerdictEvent): Promise<WorkItem | null> {
    if (e.target.kind === "issue") return this.d.store.getWorkItemBySource(e.target.source.type, e.target.source.id);
    const id = workItemIdFromBranch(e.target.head_branch, this.d.config.branch_prefix);
    const item = id ? await this.d.store.getWorkItem(id as WorkItemId) : null;
    return item && (item.pr_number === null || item.pr_number === e.target.pr_number) ? item : null;
  }

  /** Re-read → check → recordVerdict, retrying on version conflicts. Returns the refusal reason, else null. */
  private async recordVerdict(
    id: WorkItemId,
    e: VerdictEvent,
    principal: Principal,
    v: ParsedVerdict,
  ): Promise<string | null> {
    for (let i = 0; i < MAX_CONFLICT_RETRIES; i++) {
      const it = await this.d.store.getWorkItem(id);
      if (!it) return null;
      if ((await this.d.store.listVerdicts(id)).some((x) => x.comment_id === e.comment_id)) return null;
      if (it.stage === "CLOSED") return "the work item is closed";
      if (it.pr_number === null) return "the work item has no PR yet";
      const r = await this.d.store.recordVerdict({
        id,
        expected_version: it.version,
        actor: { kind: "user", id: principal.user_id },
        ...v,
        comment_id: e.comment_id,
        target: e.target.kind,
      });
      if (r.ok) {
        this.d.log.info("verdict recorded", { work_item_id: id, verdict: v.verdict, severity: v.severity, version: r.item.version });
        return null;
      }
      if (r.reason !== "version_conflict") return null;
    }
    this.d.log.warn("verdict gave up after conflicts", { work_item_id: id });
    return null;
  }

  /**
   * The transition a command asks for, or why the item's current state cannot take it. Async only because
   * a `/revise` past the limit posts its comment before the transition (keyed, so a conflict re-run posts once).
   */
  private async command(
    e: ItemCommandEvent,
    it: WorkItem,
    actor: Actor,
    floorNeed: number | null,
    note: string | null,
  ): Promise<Decision | Refusal> {
    if (e.kind === "resolve_requested") return resolveCommand(e, it, actor);
    if (it.stage === "CLOSED") return { refuse: "the work item is closed" };
    if (it.blocked_reason === BUDGET_CHECKPOINT) {
      return { refuse: "the item is at a budget checkpoint; reply `/budget`, `/budget <tokens>` or `/reject <reason>`" };
    }
    if (it.blocked_reason === FLOOR_TIER) return floorCommand(e, it, actor, floorNeed, note);
    if (e.kind === "retry_requested") return retry(it, actor);
    if (!awaitingSpec(it)) return { refuse: `the spec is not waiting for approval (stage \`${it.stage}\`)` };
    switch (e.kind) {
      case "spec_rejected":
        // Recorded first; the comment and the close follow (finishReject), and survive a stop in between.
        return {
          patch: {
            stage: "CLOSED",
            close_reason: "rejected",
            blocked_on: "upstream",
            blocked_reason: SOURCE_CLOSE_PENDING,
            spec_feedback: e.reason.trim() || null,
          },
          actor,
          reason: "spec_rejected",
        };
      case "revise_requested": {
        const feedback = e.feedback.trim();
        if (!feedback) return { refuse: "it needs feedback after the command, e.g. `/revise keep the existing CLI flag`" };
        const limit = this.d.config.max_loops;
        if (it.blocked_reason === "max_revisions") {
          return { refuse: `the spec reached the revision limit (\`max_loops\` = ${limit}); reply \`/approve\` or \`/reject <reason>\`` };
        }
        if (it.revision_count >= limit) {
          const patch = { blocked_on: "human" as const, blocked_reason: "max_revisions" };
          await this.comment(it, `max-revisions:${it.id}`, [
            `The spec was revised ${it.revision_count} times (limit \`max_loops\` = ${limit}), so the factory started no new triage run (\`max_revisions\`).`,
            "",
            "Reply `/approve` to implement the spec above, or `/reject <reason>` to close.",
            "",
            footerAfter(it, patch),
          ].join("\n"));
          return { patch, actor, reason: "max_revisions" };
        }
        const n = it.revision_count + 1;
        return {
          patch: { stage: "NEW", blocked_on: "none", blocked_reason: null, revision_count: n, spec_feedback: feedback },
          actor,
          reason: "spec_revision_requested",
          // Differs from the intake key and from every earlier revision's key.
          enqueue: { kind: "triage", idempotency_key: `${runKey(it, "triage")}:v${n}` },
        };
      }
      case "spec_approved":
        return {
          patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null },
          actor,
          reason: "spec_approved",
          ...(note ? { detail: { note } } : {}),
          enqueue: { kind: "implement", idempotency_key: runKey(it, "implement") },
        };
    }
  }

  /**
   * The rest of a reject: one comment quoting the reason, then the source issue closed as not planned,
   * then the pending mark cleared. Each step is idempotent, so a repeat after a stop does no harm.
   */
  private async finishReject(id: WorkItemId): Promise<void> {
    const it = await this.d.store.getWorkItem(id);
    if (!it || !closePending(it)) return;
    const reason = it.spec_feedback?.trim() ?? "";
    const body = reason
      ? ["The spec was rejected, so the factory closed this issue as not planned. The reason given:", "", quote(reason)].join("\n")
      : "The spec was rejected with no reason given, so the factory closed this issue as not planned.";
    await this.comment(it, `rejected:${it.id}`, body);
    await this.d.source.closeIssue(it.source);
    await this.decide(id, (cur) =>
      closePending(cur)
        ? { patch: { blocked_on: "none", blocked_reason: null }, actor: SYSTEM, reason: "source_closed" }
        : null,
    );
  }

  /**
   * A base-branch commit that reverts a factory merge: one `reverted` row on each original item it names,
   * by merge sha (`This reverts commit <sha>`) or by PR number (a `Revert ...` subject). The row changes no
   * field. Dedupe key: (item, reason, reverting commit), checked inside decide so a conflict re-reads.
   */
  private async recordReverts(e: BaseCommitEvent): Promise<void> {
    const refs = parseRevert(e.message);
    const project = this.project();
    const targets = new Set<WorkItemId>();
    for (const sha of refs.shas) {
      const it = await this.d.store.getWorkItemByMergeSha(project, sha);
      if (it) targets.add(it.id);
    }
    for (const n of refs.pr_numbers) {
      const it = await this.d.store.getWorkItemByPr(project, n);
      if (it) targets.add(it.id);
    }
    const detail = { reverting_commit: e.sha, reverting_pr: refs.reverting_pr };
    for (const id of targets) {
      await this.decide(id, async (it) =>
        (await this.hasDetail(it.id, "reverted", "reverting_commit", e.sha))
          ? null
          : { patch: {}, actor: LINKS, reason: "reverted", detail },
      );
    }
  }

  /**
   * A new item that says `Fixes #N` or `Follow-up to #N`, where N is a factory PR: the first such N becomes
   * its `fixes_pr`, and the item with PR N gets one `fixed_forward` row. Numbers that are not factory PRs
   * are ignored. Both steps are no-ops when already done.
   */
  private async linkFixForward(id: WorkItemId, text: string): Promise<void> {
    const project = this.project();
    for (const n of parseFixReferences(text)) {
      const original = await this.d.store.getWorkItemByPr(project, n);
      if (!original || original.id === id) continue;
      await this.decide(id, (it) =>
        it.fixes_pr !== null
          ? null
          : { patch: { fixes_pr: n }, actor: LINKS, reason: "fixes_pr_linked", detail: { original_work_item_id: original.id } },
      );
      // An earlier delivery may have linked another PR first; record the forward link only for the one kept.
      if ((await this.d.store.getWorkItem(id))?.fixes_pr !== n) return;
      await this.decide(original.id, async (it) =>
        (await this.hasDetail(it.id, "fixed_forward", "fix_work_item_id", id))
          ? null
          : { patch: {}, actor: LINKS, reason: "fixed_forward", detail: { fix_work_item_id: id } },
      );
      return;
    }
  }

  private async hasDetail(id: WorkItemId, reason: string, key: string, value: StateChangeDetail[string]): Promise<boolean> {
    return (await this.d.store.listStateChanges(id)).some((c) => c.reason === reason && c.detail?.[key] === value);
  }

  private project(): string {
    return `${this.d.config.repo.owner}/${this.d.config.repo.name}`;
  }

  // Run outcomes

  async applyRun(run: Run): Promise<void> {
    const ack = (reason: string): Decision => ({ patch: {}, actor: SYSTEM, reason, ack_run: run.id });
    await this.decide(run.work_item_id, async (it) => {
      const tokens = it.token_cost + Number((run.outcome?.status === "succeeded" && run.outcome.data.tokens) || 0);
      if (!run.outcome || run.outcome.status !== "succeeded") {
        if (!this.expects(it, run.kind)) return ack("run_ignored");
        const code = run.outcome?.status === "failed" ? run.outcome.error_code : "cancelled";
        if (run.kind === "resolve") return this.resolveFailed(it, run, code);
        if (run.kind === "implement" && code === DIFF_TOO_LARGE) return this.diffTooLarge(it, run);
        if (run.kind !== "update") return this.retryOrBlock(it, run, failureClass(run.outcome), code);
        const patch = { blocked_on: "human" as const, blocked_reason: `run_failed:${run.kind}:${code}` };
        const url = await this.comment(it, `run-failed:${run.id}`,
          `The ${run.kind} run failed (\`${code}\`). Comment \`/retry\` to run it again.\n\n${footerAfter(it, patch)}`);
        return {
          patch: { ...patch, failure_comment_url: url },
          actor: SYSTEM,
          reason: "run_failed",
          ack_run: run.id,
        };
      }
      if (!this.expects(it, run.kind)) return ack("run_ignored");
      const data = run.outcome.data;

      switch (run.kind) {
        case "triage": {
          const parsed = parseTriage(data.spec);
          if (!parsed.ok) return this.retryOrBlock(it, run, "task", "invalid_output");
          const spec = parsed.value;
          const floor = floorTier(spec.allowed_paths, this.d.config.floors);
          const tier = effectiveTier(spec.tier, floor, it.tier);
          const fields = {
            problem: spec.problem,
            done_criteria: spec.done_criteria,
            desired_output: spec.desired_output,
            scope: spec.scope,
            allowed_paths: spec.allowed_paths,
            tier,
            token_cost: tokens,
          };
          if (!needsSpecApproval(tier, this.d.config.dials)) {
            const next = { ...it, ...fields };
            return {
              patch: { ...fields, stage: "RUNNING" },
              actor: SYSTEM,
              reason: "triaged_auto_approved",
              ack_run: run.id,
              enqueue: { kind: "implement", idempotency_key: runKey(next, "implement") },
            };
          }
          const patch = { ...fields, stage: "READY" as const, blocked_on: "human" as const, blocked_reason: "spec_pending" };
          const url = await this.comment(it, `spec:${run.id}`,
            renderSpec(spec, tier, { floor, previous: it.tier }, footerAfter(it, patch)));
          return {
            patch: { ...patch, spec_comment_url: url },
            actor: SYSTEM,
            reason: "triaged",
            ack_run: run.id,
          };
        }
        case "implement": {
          if (data.floor_block === true) return this.floorBlock(it, run, data, tokens);
          const pr = Number(data.pr_number);
          return {
            patch: { stage: "REVIEW", pr_number: pr, token_cost: tokens },
            actor: SYSTEM,
            reason: "implemented",
            ack_run: run.id,
            enqueue: { kind: "review", idempotency_key: runKey(it, "review") },
          };
        }
        case "review": {
          const parsed = parseReview(data.review);
          if (!parsed.ok) return this.retryOrBlock(it, run, "task", "invalid_output");
          const tier = effectiveTier(parsed.value.tier, floorTier(it.allowed_paths, this.d.config.floors), it.tier);
          if (parsed.value.verdict === "bug") {
            if (it.loop_count + 1 >= this.d.config.max_loops) {
              const patch = { tier, token_cost: tokens, blocked_on: "human" as const, blocked_reason: "max_loops" };
              await this.comment(it, `max-loops:${run.id}`,
                `Review found bugs ${it.loop_count + 1} times (limit ${this.d.config.max_loops}). A human needs to decide.\n\n${footerAfter(it, patch)}`);
              return {
                patch,
                actor: SYSTEM,
                reason: "max_loops",
                ack_run: run.id,
              };
            }
            const next = { ...it, loop_count: it.loop_count + 1 };
            return {
              patch: { tier, token_cost: tokens, stage: "RUNNING", loop_count: next.loop_count },
              actor: SYSTEM,
              reason: "review_bug",
              ack_run: run.id,
              enqueue: { kind: "implement", idempotency_key: runKey(next, "implement") },
            };
          }
          // Auto-merge does not exist yet: auto_merge_max_tier is fixed at 0, so every PR goes to a human.
          const patch = { tier, token_cost: tokens, blocked_on: "human" as const, blocked_reason: "merge_pending" };
          await this.comment(it, `merge:${run.id}`,
            `PR #${it.pr_number} passed review (tier ${tier}). A human merge is required.\n\n${footerAfter(it, patch)}`);
          return {
            patch,
            actor: SYSTEM,
            reason: "review_passed",
            ack_run: run.id,
          };
        }
        case "resolve":
          // The worker pushed the merge to the same PR branch. A fresh review checks it; its key comes from
          // this run's id, so it never collides with the review of an earlier loop or resolve.
          return {
            patch: { stage: "REVIEW", token_cost: tokens },
            actor: SYSTEM,
            reason: "resolved",
            detail: { run_id: run.id },
            ack_run: run.id,
            enqueue: { kind: "review", idempotency_key: `${it.id}:review:after-resolve:${run.id}` },
          };
        case "update": {
          // The worker already commented on the PR. The item stays in REVIEW waiting for a human either way.
          switch (data.result) {
            case "pushed":
              return { patch: {}, actor: SYSTEM, reason: "update_pushed", ack_run: run.id };
            case "up_to_date":
              return ack("update_up_to_date");
            case "conflict":
            case "tests_failed":
              return {
                patch: { blocked_reason: CONFLICT_PENDING },
                actor: SYSTEM,
                reason: data.result === "conflict" ? "update_conflict" : "update_tests_failed",
                ack_run: run.id,
              };
            default:
              return {
                // No comment is posted for this one, so an older failure link must not stand in for it.
                patch: { blocked_reason: "run_failed:update:invalid_output", failure_comment_url: null },
                actor: SYSTEM,
                reason: "run_failed",
                ack_run: run.id,
              };
          }
        }
      }
    });
  }

  /**
   * A failed triage, implement or review run (design §5 Restarts). Counts come from the run history of
   * this step (the first run and its automatic retries): a rate limit is never an attempt; infra failures
   * count toward max_restart (and add one to restart_count); task failures toward max_attempts. Under both
   * limits, a new run is enqueued in the same transition with `not_before` = failure + backoff (rate limit:
   * its reset time). At a limit, the item blocks on a human with the last error posted. The retry key comes
   * from the failed run's key, and the ack fences the run, so applying it twice enqueues one retry.
   */
  private async retryOrBlock(it: WorkItem, run: Run, cls: FailureClass, code: string): Promise<Decision> {
    const { max_attempts, max_restart, retry_base_ms, retry_max_ms } = this.d.config;
    const step = (await this.d.store.listRuns(it.id)).filter(
      (r) => r.kind === run.kind && sameStep(r.idempotency_key, run.idempotency_key) && (r.id === run.id || r.acknowledged_at !== null),
    );
    const count = (c: FailureClass) => step.filter((r) => failureClass(r.outcome) === c).length;
    const task = count("task");
    const infra = count("infra");
    const failedAt = Date.parse(run.finished_at ?? this.d.clock.now().toISOString());
    const restart = cls === "infra" ? { restart_count: it.restart_count + 1 } : {};
    const detail = { run_id: run.id, error_code: code, failure: cls, task_failures: task, infra_failures: infra };

    const limit = task >= max_attempts ? "max_attempts" : infra >= max_restart ? "max_restart" : null;
    if (cls !== "rate_limited" && limit) {
      const patch = { ...restart, blocked_on: "human" as const, blocked_reason: limit };
      const url = await this.lastAttemptComment(it, run, code, limit, limit === "max_attempts" ? task : infra, footerAfter(it, patch));
      return {
        patch: { ...patch, failure_comment_url: url },
        actor: SYSTEM,
        reason: limit,
        detail,
        ack_run: run.id,
      };
    }
    const reset = run.outcome?.status === "failed" ? run.outcome.reset_at : null;
    const notBefore = cls === "rate_limited"
      ? (reset ?? iso(failedAt + retry_max_ms))
      : iso(failedAt + retryDelayMs(task + infra, retry_base_ms, retry_max_ms));
    return {
      patch: restart,
      actor: SYSTEM,
      reason: cls === "rate_limited" ? "run_rate_limited" : "run_retry_scheduled",
      detail: { ...detail, not_before: notBefore },
      ack_run: run.id,
      enqueue: { kind: run.kind, idempotency_key: retryKey(run.idempotency_key), not_before: notBefore },
    };
  }

  /**
   * Any failed resolve run (agent, scope, tests, push, egress, rate limit, lease): nothing was pushed, so the
   * PR is as it was. The item goes back to waiting on the conflict, not to run_failed:*, so the next `/resolve`
   * is accepted. No automatic retry: a human starts every resolve. One comment, keyed on the run, names the code.
   */
  private async resolveFailed(it: WorkItem, run: Run, code: string): Promise<Decision> {
    const detail = run.outcome?.status === "failed" ? run.outcome.detail.trim() : "";
    const body = (withDetail: boolean) => [
      `The resolve run failed (\`${code}\`): ${describeFailure(code)}.${withDetail && detail ? ` ${detail}` : ""}`,
      "",
      `Nothing was pushed; PR #${it.pr_number} is unchanged and still has the merge conflict.`,
      "Comment `/resolve [notes]` to try again, or resolve it by hand.",
    ].join("\n");
    // The detail is run output (G5): post it only if the scan passes, else the comment without it.
    const scan = await this.d.scanner.scan("comment", body(true));
    await this.comment(it, `run-failed:${run.id}`, body(scan.clean));
    return {
      patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: CONFLICT_PENDING },
      actor: SYSTEM,
      reason: "resolve_failed",
      detail: { run_id: run.id, error_code: code },
      ack_run: run.id,
    };
  }

  /**
   * The pre-push size gate failed (design §4): no automatic retry, since the same spec would likely overreach
   * again. Blocks on a human with the usual run_failed reason, so `/retry` reruns the implement.
   */
  private async diffTooLarge(it: WorkItem, run: Run): Promise<Decision> {
    const detail = run.outcome?.status === "failed" ? run.outcome.detail : "";
    const { max_diff_lines, max_diff_files } = this.d.config;
    const patch = { blocked_on: "human" as const, blocked_reason: `run_failed:implement:${DIFF_TOO_LARGE}` };
    const url = await this.comment(it, `run-failed:${run.id}`, [
      "## Factory size check: push blocked",
      "",
      `The implement run's diff is too large to review, so nothing was pushed: ${detail}.`,
      "",
      `Limits: \`max_diff_lines\` = ${max_diff_lines} (added plus deleted lines), \`max_diff_files\` = ${max_diff_files}.`,
      "",
      "Split the work item, or comment `/retry` to run the implementer again; it must make a smaller change.",
      "",
      footerAfter(it, patch),
    ].join("\n"));
    return {
      patch: { ...patch, failure_comment_url: url },
      actor: SYSTEM,
      reason: "run_failed",
      detail: { run_id: run.id, error_code: DIFF_TOO_LARGE },
      ack_run: run.id,
    };
  }

  /**
   * The pre-push floor check found changed files under a floor above the item's tier (design §4). Nothing was
   * pushed. The item stays RUNNING, blocked on a human; `/approve` raises the tier and runs implement again.
   */
  private async floorBlock(it: WorkItem, run: Run, data: Record<string, unknown>, tokens: number): Promise<Decision> {
    const hits = parseFloorHits(data.floor_paths);
    const need = hits.reduce((m, h) => Math.max(m, h.tier), 0);
    if (hits.length === 0 || data.required_tier !== need) return this.retryOrBlock(it, run, "task", "invalid_output");
    const patch = { token_cost: tokens, blocked_on: "human" as const, blocked_reason: FLOOR_TIER };
    await this.comment(it, `floor:${run.id}`, [
      "## Factory floor check: push blocked",
      "",
      `This item is tier ${it.tier ?? 1}, but the implementer changed files under a floor that needs a higher tier, so nothing was pushed:`,
      "",
      ...hits.map((h) => `- \`${h.path}\` needs tier ${h.tier}`),
      "",
      `Reply \`/approve\` to raise the item to tier ${need} and run the implementer again, or \`/reject <reason>\` to close it.`,
      "",
      footerAfter(it, patch),
    ].join("\n"));
    return {
      patch,
      actor: SYSTEM,
      reason: "floor_blocked",
      detail: { run_id: run.id, item_tier: it.tier, required_tier: need, paths: hits.map((h) => h.path).join(",").slice(0, 1000) },
      ack_run: run.id,
    };
  }

  /**
   * The dead-letter note: what failed, its code, and the tail of the last output. Posted only if G5 passes.
   * Returns the comment's URL, or null when the scan withheld it.
   */
  private async lastAttemptComment(it: WorkItem, run: Run, code: string, limit: string, n: number, footer: string): Promise<string | null> {
    const out = run.outcome?.status === "failed" ? run.outcome : null;
    const what = limit === "max_attempts"
      ? `The ${run.kind} run failed ${n} times (limit \`max_attempts\` = ${this.d.config.max_attempts}), so the factory stopped retrying it.`
      : `The ${run.kind} run hit ${n} infrastructure failures (limit \`max_restart\` = ${this.d.config.max_restart}), so the factory stopped restarting it.`;
    const tail = (out?.output_tail || out?.detail || "").trim();
    const body = [
      what,
      "",
      `Last error: \`${code}\`: ${describeFailure(code)}.${out?.detail ? ` ${out.detail}` : ""}`,
      "",
      ...(tail ? ["Output tail of the last run:", "", fenced(tail), ""] : ["The last run left no output.", ""]),
      "Comment `/retry` to run it again.",
      "",
      footer,
    ].join("\n");
    const scan = await this.d.scanner.scan("comment", body);
    if (!scan.clean) {
      this.d.log.warn("last-attempt comment blocked by the egress scan; not posted", {
        work_item_id: it.id,
        run_id: run.id,
        rules: scan.findings.map((f) => f.rule).join(","),
      });
      return null;
    }
    return this.comment(it, `run-failed:${run.id}`, body);
  }

  // Internals

  /** Whether the item is in the state a finished run of this kind should advance. */
  private expects(it: WorkItem, kind: RunKind): boolean {
    // An update runs while the PR waits for a human merge, so the item stays blocked on that human throughout.
    if (kind === "update") return awaitingMerge(it);
    if (it.stage === "CLOSED" || it.blocked_on !== "none") return false;
    if (kind === "triage") return it.stage === "NEW";
    if (kind === "implement" || kind === "resolve") return it.stage === "RUNNING";
    return it.stage === "REVIEW";
  }

  /**
   * Re-read → decide → conditional transition, retrying on version conflicts. Returns the refusal reason
   * when `fn` refused, else null (applied, or a silent no-op).
   */
  private async decide(
    id: WorkItemId,
    fn: (item: WorkItem) => Decision | Refusal | Promise<Decision | Refusal>,
  ): Promise<string | null> {
    for (let i = 0; i < MAX_CONFLICT_RETRIES; i++) {
      const item = await this.d.store.getWorkItem(id);
      if (!item) return null;
      const wanted = await fn(item);
      if (!wanted) return null;
      if ("refuse" in wanted) return wanted.refuse;
      // The one budget check: every implement or review run the factory would queue passes here (design §6).
      const hold = await this.budgetHold(item, wanted);
      const decision = hold ?? wanted;
      const at = { id, expected_version: item.version };
      const r = hold
        ? await this.d.store.openBudgetCheckpoint({ ...hold, ...at })
        : await this.d.store.transition({ ...wanted, ...at });
      if (r.ok) {
        this.d.log.info("transition", { work_item_id: id, reason: decision.reason, version: r.item.version });
        if (STATUS_FIELDS.some((k) => k in decision.patch)) await this.showStatus(r.item);
        return null;
      }
      if (r.reason !== "version_conflict") {
        this.d.log.warn("transition refused", { work_item_id: id, reason: r.reason });
        return null;
      }
    }
    this.d.log.warn("transition gave up after conflicts", { work_item_id: id });
    return null;
  }

  /**
   * A token-budget checkpoint in place of `d`, when `d` queues an implement or review run and the item, after
   * `d`'s patch, is at or over its current budget; else null. The rest of `d` (the outcome it applies, the
   * run it acks) stands; the run is not queued but kept on the checkpoint row. Posts the one checkpoint
   * comment first, keyed on the held run's key, so a re-decide after a conflict posts nothing new.
   */
  private async budgetHold(it: WorkItem, d: NonNullable<Decision>): Promise<Hold | null> {
    const run = d.enqueue;
    if (!run || (run.kind !== "implement" && run.kind !== "review")) return null;
    const next = { ...it, ...d.patch };
    if (next.tier === null) return null;
    const base = tierBudget(this.d.config.budgets, next.tier);
    if (base === null) return null;
    const budget = currentBudget(base, await this.d.store.listBudgetCheckpoints(it.id));
    if (!overBudget(next.token_cost, budget)) return null;

    const suggestion = suggestBudget({
      current: budget,
      base,
      history: await this.d.store.getTierHistory(it.project, next.tier),
      min_sample: this.d.config.budget_min_sample ?? DEFAULT_BUDGET_MIN_SAMPLE,
    });
    const runs = (await this.d.store.listRuns(it.id)).length;
    await this.comment(it, `budget:${run.idempotency_key}`, checkpointComment({
      tier: next.tier,
      stage: next.stage,
      pr_number: next.pr_number,
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

  private async authorize(identity: ExternalIdentity, action: AuthAction, resource: string): Promise<Principal | Refusal> {
    const principal = await this.d.auth.resolve(identity);
    if (!principal) return { refuse: "the factory could not resolve your account" };
    const decision = await this.d.auth.authorize(principal, action, { kind: "work_item", id: resource });
    if (!decision.allow) {
      this.d.log.warn("unauthorized", { user_id: principal.user_id, action, reason: decision.reason });
      return { refuse: `it needs write permission on this repository (\`${decision.reason}\`)` };
    }
    return principal;
  }

  /** 👀 on the event. Best effort: a failure is a warning and never blocks the transition or the loop. */
  private async markSeen(source: SourceRef, commentId: string | null): Promise<void> {
    try {
      await this.d.source.markSeen(source, commentId);
    } catch (err) {
      this.d.log.warn("mark seen failed", {
        source_id: source.id,
        comment_id: commentId,
        error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
      });
    }
  }

  /** The item's status on its issue and, once it has one, on its PR. Best effort, each write on its own. */
  private async showStatus(it: WorkItem): Promise<void> {
    const status = statusOf(it);
    await this.setStatus(it.source, status, null);
    if (it.pr_number !== null) await this.setStatus(it.source, status, it.pr_number);
  }

  /** Best effort, like markSeen: a failure is a warning and never changes a transition's outcome. */
  private async setStatus(source: SourceRef, status: WorkStatus, pr_number: number | null): Promise<void> {
    try {
      await this.d.source.setStatus(source, status, pr_number);
    } catch (err) {
      this.d.log.warn("set status failed", {
        source_id: source.id,
        status,
        pr_number,
        error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
      });
    }
  }

  /** Posts once per key; returns the comment's URL (the existing one's on a repeat), null if the source has none. */
  private async comment(it: WorkItem, key: string, body: string): Promise<string | null> {
    return (await this.d.source.postComment(it.source, body, `<!-- factory:${key} -->`)).url;
  }

  private async guard(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.d.log.error("loop step failed", { step: what, error: err instanceof Error ? err.message.slice(0, 300) : "unknown" });
    }
  }
}

/** A human `/retry`: the failed run again, or why there is none. */
function retry(it: WorkItem, actor: Actor): Decision | Refusal {
  const kind = failedRunKind(it);
  if (it.blocked_on !== "human" || !kind) return { refuse: "there is no failed run to retry" };
  const next = { ...it, restart_count: it.restart_count + 1 };
  // A retried update goes back to waiting for the merge, which is the state an update run expects.
  const unblocked = kind === "update"
    ? { blocked_on: "human" as const, blocked_reason: "merge_pending" }
    : { blocked_on: "none" as const, blocked_reason: null };
  // A new step key with no not_before: a human retry starts at once, with a fresh retry budget.
  return {
    patch: { ...unblocked, restart_count: next.restart_count },
    actor,
    reason: "retry_requested",
    enqueue: { kind, idempotency_key: runKey(next, kind) },
  };
}

/** A spec waiting for `/approve`, `/reject` or `/revise`; past the revision limit, only the first two apply. */
function awaitingSpec(it: WorkItem): boolean {
  return it.stage === "READY" && (it.blocked_reason === "spec_pending" || it.blocked_reason === "max_revisions");
}

/** A rejected item whose reject comment or source close may not have happened yet. */
function closePending(it: WorkItem): boolean {
  return it.stage === "CLOSED" && it.blocked_on === "upstream" && it.blocked_reason === SOURCE_CLOSE_PENDING;
}

/** Markdown block quote of `text`, line by line. */
function quote(text: string): string {
  return text.split(/\r?\n/).map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");
}

/**
 * `/resolve [notes]` (design §5 Merge conflict). Only on an item waiting on a merge conflict. Starts a resolve
 * run under a new key: restart_count + 1, as /retry does, since the run key is per (loop, restart) and a second
 * /resolve would otherwise be a silent no-op. The notes go on the run for the worker; they are untrusted.
 */
function resolveCommand(e: ResolveEvent, it: WorkItem, actor: Actor): Decision | Refusal {
  if (!conflictPending(it)) {
    return {
      refuse: `the item is not waiting on a merge conflict (stage \`${it.stage}\`, blocked_on \`${it.blocked_on}\`, ` +
        `blocked_reason \`${it.blocked_reason ?? "none"}\`); \`/resolve\` needs blocked_reason \`${CONFLICT_PENDING}\``,
    };
  }
  const next = { ...it, restart_count: it.restart_count + 1 };
  return {
    patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null, restart_count: next.restart_count },
    actor,
    reason: "resolve_requested",
    detail: { comment_id: e.comment_id },
    enqueue: { kind: "resolve", idempotency_key: runKey(next, "resolve"), input: { notes: e.notes } },
  };
}

/** A PR whose base no longer merges cleanly, waiting for a human (set by the update run, design §5). */
function conflictPending(it: WorkItem): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "human" && it.blocked_reason === CONFLICT_PENDING;
}

/**
 * A command on a floor_tier block (design §4). `/approve` raises the tier to the one the floor needs (never
 * lowers it), clears the block and enqueues implement under a new key (restart_count + 1), so it is not a
 * no-op. `/reject` closes the item. `/retry` is refused: a floor block is not a failed run.
 */
function floorCommand(e: ItemCommandEvent, it: WorkItem, actor: Actor, need: number | null, note: string | null): Decision | Refusal {
  if (e.kind === "retry_requested") {
    return { refuse: "the item is blocked by the floor check (`floor_tier`), which is not a failed run; reply `/approve` to raise its tier" };
  }
  if (e.kind === "revise_requested") {
    return { refuse: "the item is blocked by the floor check (`floor_tier`), not waiting on a spec; reply `/approve` to raise its tier or `/reject <reason>` to close" };
  }
  if (e.kind === "spec_rejected") {
    return {
      patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null },
      actor,
      reason: "floor_rejected",
    };
  }
  if (it.stage !== "RUNNING" || need === null) return { refuse: "the floor block has no recorded tier to approve" };
  const next = { ...it, tier: effectiveTier(it.tier, need as Tier), restart_count: it.restart_count + 1 };
  return {
    patch: { tier: next.tier, restart_count: next.restart_count, blocked_on: "none", blocked_reason: null },
    actor,
    reason: "floor_tier_approved",
    detail: { previous_tier: it.tier, tier: next.tier, ...(note ? { note } : {}) },
    enqueue: { kind: "implement", idempotency_key: runKey(next, "implement") },
  };
}

/**
 * The command footer for a comment posted before its transition: the commands for the state the item will
 * be in once `patch` applies (design §4). Same table as the parser and the controller's checks.
 */
function footerAfter(it: WorkItem, patch: Partial<Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason" | "pr_number">>): string {
  return commandFooter(commandState({ ...it, ...patch }));
}

const FAILURES: Record<string, string> = {
  invalid_output: "the agent's answer did not have the expected shape",
  no_commits: "the implementer made no commits",
  scope_violation: "the branch changed files outside the allowed paths",
  diff_too_large: "the branch diff is over max_diff_lines or max_diff_files",
  merge_conflict: "the branch conflicts with the base branch and the conflict could not be resolved; nothing was pushed",
  untrusted_base: "the base fetched before pushing does not contain the base the run started from; nothing was pushed",
  out_of_scope: "the resolve run changed files that are neither conflicting nor under the allowed paths",
  tests_failed: "the install or test command failed on the resolved branch",
  unresolved_conflicts: "conflicts were left unresolved",
  head_moved: "the install or test command moved HEAD off the commit the gates checked",
  prompt_missing: "prompts/resolve.md is missing",
  push_failed: "the push was rejected",
  rate_limited: "the model provider's usage or rate limit was hit",
  egress_blocked: "the output was stopped by the leak scanner",
  agent_failed: "the agent exited with an error",
  agent_timed_out: "the agent run timed out",
  lease_lost: "the worker lost its lease on the run (stopped, crashed or slept)",
  lease_expired: "the run's lease expired with no heartbeat (the worker stopped, crashed or slept)",
  exception: "the worker hit an unexpected error",
  git_failed: "a git command failed",
  cancelled: "the run was cancelled",
};

function describeFailure(code: string): string {
  return FAILURES[code] ?? "the run failed";
}

/** A code block whose fence is longer than any backtick run in `text`, so the text cannot close it. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function parseFloorHits(v: unknown): { path: string; tier: number }[] {
  if (!Array.isArray(v)) return [];
  const hits = v.filter(
    (h): h is { path: string; tier: number } =>
      typeof h === "object" && h !== null && typeof h.path === "string" && Number.isInteger(h.tier) && h.tier >= 1 && h.tier <= 5,
  );
  return hits.length === v.length ? hits : [];
}

/** The seq an inbox cursor holds; no cursor means before the first row. */
function inboxSeq(cursor: string | null): number {
  if (cursor === null) return 0;
  const n = Number(cursor);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`inbox cursor is not a sequence number: ${cursor.slice(0, 40)}`);
  return n;
}

function iso(ms: number): Timestamp {
  return new Date(ms).toISOString() as Timestamp;
}

/** A PR that passed review and waits for a human merge: the only state an update run may change. */
function awaitingMerge(it: WorkItem): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "human" && it.blocked_reason === "merge_pending";
}
