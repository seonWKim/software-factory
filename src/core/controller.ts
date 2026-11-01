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
import { commandFooter, commandPhase, commandState, failedRunKind, helpReply, phaseLabel, unknownCommandReply } from "./commands.js";
import type { FactoryConfig } from "./config.js";
import { type LearnedSettingsSource, type ProjectSettings, settingValues } from "./settings.js";
import { Listener } from "./listener.js";
import { parseFixReferences, parseRevert } from "./links.js";
import type { Logger } from "./log.js";
import { parseReview, parseTriage } from "./outputs.js";
import {
  AUTO_RESOLVE_LIMIT,
  type FailureClass,
  SKIP_LABEL,
  autoResolveAttempts,
  autoResolveKey,
  effectiveTier,
  failureClass,
  floorTier,
  needsSpecApproval,
  nextAutoResolveAttempt,
  parseAutoResolveKey,
  retryDelayMs,
  retryKey,
  runKey,
  sameStep,
  workItemIdFromBranch,
} from "./policy.js";
import { MERGE_CONFLICT_PENDING, conflictCounts, conflictCountsLine } from "./resolve.js";
import { renderSpec } from "./spec-comment.js";
import { SUGGEST_MAX_CHARS, formatSuggestion, suggestCommand } from "./suggest.js";
import { type WorkStatus, statusOf } from "./status-label.js";
import type { Actor, CloseReason, Run, RunId, RunKind, SourceRef, SourceType, StateChangeDetail, Tier, Timestamp, WorkItem, WorkItemId } from "./types.js";
import { type ParsedVerdict, parseVerdict } from "./verdict.js";
import type { AuthAction, AuthProvider, ExternalIdentity, Principal } from "../interfaces/auth-provider.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore, NewBudgetCheckpoint, TransitionInput } from "../interfaces/factory-store.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { PollSource, PrChecks, SourceAdapter, SourceEvent, StreamSource } from "../interfaces/source-adapter.js";

export interface ControllerDeps {
  store: FactoryStore;
  /**
   * The configured sources (`plugins.source`), at most one per source type (design 2026-11-01). Each item's
   * comments, mark-seen, status and close go to the adapter of its own source type; status on a PR goes to
   * the `github_issue` adapter. Give `sources`, or `source` for exactly one.
   */
  sources?: readonly SourceAdapter[];
  /** One source: the same as `sources: [source]`. */
  source?: SourceAdapter;
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
  /**
   * Suggests a command for a plain-language comment (design §4). Absent: plain comments get no reply. The
   * controller's state decisions never use it.
   */
  llm?: LLMProvider;
  /** The learned settings layer (src/core/settings.ts). Absent: no learned values; none are written yet. */
  learned?: LearnedSettingsSource;
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
type PlainCommentEvent = Extract<SourceEvent, { kind: "plain_comment" }>;
type PrOpenEvent = Extract<SourceEvent, { kind: "pr_open" }>;
type PrFinishedEvent = Extract<SourceEvent, { kind: "pr_merged" | "pr_closed" }>;

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
/** The actor of a person's push whose commit author does not resolve to a user (design 2026-11-01). */
const PR_SYNC: Actor = { kind: "system", id: "system:pr-sync" };
/** blocked_reason of an adopted PR whose review found bugs: the factory never changes a person's branch. */
const CHANGES_REQUESTED = "changes_requested";
/** blocked_reason of an adopted PR that passed review but whose checks failed. */
const CHECKS_FAILED = "checks_failed";
const MAX_CONFLICT_RETRIES = 5;
/** Characters of an approval note kept on the state change (design §4). */
const MAX_NOTE_CHARS = 2000;
/** blocked_reason of an item whose diff touches a floor above its tier (design §4). */
const FLOOR_TIER = "floor_tier";
/**
 * blocked_reason of a PR whose base no longer merges cleanly and whose automatic resolve runs are used up (or
 * whose updated branch failed its tests); `/resolve` starts a resolve run (design §5).
 */
const CONFLICT_PENDING = MERGE_CONFLICT_PENDING;
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
/**
 * An item closed from its source whose open PR still needs its comment and its close: `CLOSED` with
 * `blocked_on: upstream` and this reason until both are done (design §4, source closed).
 */
const PR_CLOSE_PENDING = "pr_close_pending";
/** blocked_reason (with `blocked_on: ci`) of a reviewed PR whose checks have not finished (design §5 CI gate). */
const CHECKS_PENDING = "checks_pending";
/** Items waiting on checks looked at per tick. */
const CHECKS_BATCH = 50;
/** Failed check names kept per decision, and characters per name. */
const MAX_CHECK_NAMES = 20;
const MAX_CHECK_NAME_CHARS = 100;
/** Rejected items finished per intake tick. */
const CLOSE_BATCH = 50;
/** Inbox rows a stream intake step reads at most per tick. */
const INBOX_BATCH = 100;
const DAY_MS = 86_400_000;

/** PRs live on GitHub: status on a PR goes to the adapter of this type, whatever the item's source. */
const PR_SOURCE_TYPE: SourceType = "github_issue";

/**
 * The sources a controller runs (design 2026-11-01): at least one, no two of one type, and when there are
 * several, one of type github_issue, the only source of PR merge, close and unmergeable events. Errors name
 * `plugins.source`, the config key that lists them.
 */
function checkSources(d: Pick<ControllerDeps, "source" | "sources">): readonly SourceAdapter[] {
  if (d.source !== undefined && d.sources !== undefined) throw new Error("Controller takes `source` or `sources`, not both");
  const sources = d.sources ?? (d.source ? [d.source] : []);
  if (sources.length === 0) throw new Error("plugins.source selects no SourceAdapter: list at least one source");
  const seen = new Set<SourceType>();
  for (const s of sources) {
    if (seen.has(s.type)) {
      throw new Error(`plugins.source lists two sources of type "${s.type}"; each source type can be listed once`);
    }
    seen.add(s.type);
  }
  if (sources.length > 1 && !seen.has(PR_SOURCE_TYPE)) {
    throw new Error(
      `plugins.source lists ${sources.length} sources but none of type "${PR_SOURCE_TYPE}": PR merge, close and ` +
        "unmergeable events come only from it, so factory PRs would never close their items",
    );
  }
  return sources;
}

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
  /** The configured sources, in config order. Fixed at construction; the same on every replica. */
  private readonly sources: readonly SourceAdapter[];
  private readonly byType: ReadonlyMap<SourceType, SourceAdapter>;

  constructor(private readonly d: ControllerDeps) {
    this.sources = checkSources(d);
    this.byType = new Map(this.sources.map((s) => [s.type, s]));
  }

  async run(signal: AbortSignal): Promise<void> {
    // The label, never the key: log lines and comments name a project by its readable path.
    this.d.log.info("controller started", { project: this.d.config.project.label });
    const streams = this.sources.filter((s): s is StreamSource => s.intake === "stream");
    // Each stream source gets its own listener; its store lease (per source type) lets only one replica subscribe.
    const listening = Promise.all(streams.map((s) => this.listener(s).run(signal)));
    await this.guard("status catch-up", () => this.catchUpStatus());
    let lastPoll = -Infinity;
    while (!signal.aborted) {
      const now = this.d.clock.now().getTime();
      const due = now - lastPoll >= this.d.config.poll_interval_ms;
      if (due) lastPoll = now;
      // A poll source is asked on its interval; an inbox is a store read, so it is read every tick.
      if (due || streams.length > 0) await this.guard("intake", () => this.intake(due));
      if (due && streams.length > 0) await this.guard("inbox cleanup", () => this.cleanupInbox());
      // PR checks are read from the forge, so on the poll interval like a poll source.
      if (due) await this.guard("checks", () => this.tickChecks());
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

  /** One intake step of every source: each poll source is polled, each stream source's inbox is read. */
  async tickIntake(): Promise<void> {
    await this.intake(true);
  }

  /**
   * Each source's step runs on its own guard, so one source failing (a poll that throws, a bad cursor) never
   * stops the others in the same tick. Poll sources run only when `pollDue`. Unfinished rejects are retried
   * once per tick that polled.
   */
  private async intake(pollDue: boolean): Promise<void> {
    let polled = false;
    for (const s of this.sources) {
      if (s.intake === "stream") await this.guard(`intake:${s.type}`, () => this.tickInbox(s));
      else if (pollDue) {
        polled = true;
        await this.guard(`intake:${s.type}`, () => this.tickPoll(s));
      }
    }
    if (polled) await this.guard("source closes", () => this.tickSourceCloses());
  }

  /** One poll of one source, through its own cursor `intake:<type>`. */
  private async tickPoll(source: PollSource): Promise<void> {
    const name = `intake:${source.type}`;
    const cursor = await this.d.store.getCursor(name);
    const { events, next_cursor } = await source.poll(cursor);
    for (const e of events) await this.guard(`event:${e.kind}`, () => this.handleEvent(e));
    await this.d.store.advanceCursor(name, cursor, next_cursor);
  }

  /**
   * Finishes rejects whose comment or close did not happen (the factory stopped, or the source failed):
   * every rejected item still marked `source_close_pending` gets them now. Likewise every item closed from
   * its source still marked `pr_close_pending` gets its PR comment and PR close. Safe to repeat: comments
   * carry a marker and are posted once; closing a closed issue or PR changes nothing.
   */
  async tickSourceCloses(): Promise<void> {
    const pending = await this.d.store.listWorkItemsWhere({ stage: "CLOSED", blocked_on: "upstream", limit: CLOSE_BATCH });
    for (const it of pending) {
      if (closePending(it)) await this.guard("source close", () => this.finishReject(it.id));
      if (prClosePending(it)) await this.guard("pr close", () => this.finishPrClose(it.id));
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
    for (const s of this.sources) {
      if (s.intake === "stream") await this.guard(`inbox cleanup:${s.type}`, () => this.cleanupInboxOf(s));
    }
  }

  private async cleanupInboxOf(source: StreamSource): Promise<void> {
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
    const { retry_base_ms, retry_max_ms } = this.d.config;
    // One repository per factory today, so the configured repo's limit applies to every lease.
    const { max_attempts } = this.settings(this.project());
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
      case "plain_comment":
        return this.handlePlainComment(e);
      case "pr_merged":
      case "pr_closed":
        return this.prFinished(e);
      case "pr_open":
        return this.prOpen(e);
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
   * A merged or closed PR (design 2026-11-01). A factory branch maps to its item, any other PR to its adopted
   * item by number; either closes the same way (a merge: CLOSED / completed, the merger as approver of record).
   * A merge with no item (skipped, never adopted, a fork, merged before a poll) writes one unreviewed merge.
   */
  private async prFinished(e: PrFinishedEvent): Promise<void> {
    const item = await this.itemOfFinishedPr(e);
    if (!item) {
      if (e.kind === "pr_merged") await this.recordUnreviewedMerge(e);
      return;
    }
    // The human who merged is the approver of record (design §8). GitHub already enforced their permission.
    const merger = e.kind === "pr_merged" && e.merger ? await this.d.auth.resolve(e.merger) : null;
    const actor: Actor = merger ? { kind: "user", id: merger.user_id } : { kind: "system", id: "system:post-merge" };
    await this.decide(item.id, (it) => {
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
  }

  /** A factory branch's item (the decide checks its PR number), else the adopted item with this PR number. Forks have none. */
  private async itemOfFinishedPr(e: PrFinishedEvent): Promise<WorkItem | null> {
    if (e.fork) return null;
    const id = workItemIdFromBranch(e.head_branch, this.d.config.branch_prefix);
    if (id) return this.d.store.getWorkItem(id as WorkItemId);
    const it = await this.d.store.getWorkItemByPr(this.project(), e.pr_number);
    return it?.origin === "adopted" ? it : null;
  }

  /** One row per merged PR with no item; the merger by user ID, null when the forge names none or it does not resolve. */
  private async recordUnreviewedMerge(e: Extract<PrFinishedEvent, { kind: "pr_merged" }>): Promise<void> {
    const merger = e.merger ? await this.d.auth.resolve(e.merger) : null;
    const { created } = await this.d.store.recordUnreviewedMerge({
      project: this.project(),
      pr_number: e.pr_number,
      merge_sha: e.merge_sha,
      merger_id: merger?.user_id ?? null,
    });
    if (created) {
      this.d.log.warn("unreviewed merge", { pr_number: e.pr_number, merge_sha: e.merge_sha, user_id: merger?.user_id ?? null, fork: e.fork ?? false });
    }
  }

  /**
   * An open PR (design 2026-11-01). A factory PR or an adopted one: its head is compared with the recorded
   * head. Any other PR is adopted, unless a user with write permission put `factory: skip` on it.
   */
  private async prOpen(e: PrOpenEvent): Promise<void> {
    const id = workItemIdFromBranch(e.head_branch, this.d.config.branch_prefix);
    if (id) {
      const it = await this.d.store.getWorkItem(id as WorkItemId);
      if (it && it.pr_number === e.pr_number) await this.recordHead(it, e);
      return;
    }
    const known = await this.d.store.getWorkItemBySource(e.source.type, e.source.id);
    if (known) return this.recordHead(known, e);
    await this.adopt(e);
  }

  /**
   * Adoption: one item at REVIEW whose source is the PR, requested by its author, with the PR's files as
   * allowed_paths (so the floor tiers apply) and one review run, in one store transaction. The skip label is
   * checked here only; once adopted, a label changes nothing. The files are read only for a PR the store does
   * not know yet.
   */
  private async adopt(e: PrOpenEvent): Promise<void> {
    const log = { pr_number: e.pr_number };
    const author = e.author ? await this.d.auth.resolve(e.author) : null;
    if (!author) {
      this.d.log.warn("PR not adopted: its author does not resolve to a user", log);
      return;
    }
    const forge = this.byType.get(PR_SOURCE_TYPE);
    if (e.labels.includes(SKIP_LABEL)) {
      const adder = forge?.labelAddedBy ? await forge.labelAddedBy(e.pr_number, SKIP_LABEL) : null;
      const who = adder ? await this.authorize(adder, "approve_spec", e.source.id) : null;
      if (who && !("refuse" in who)) {
        this.d.log.info("PR skipped: factory: skip label", { ...log, user_id: who.user_id });
        return;
      }
      this.d.log.warn("factory: skip label ignored: not added by a user with write permission; PR adopted", log);
    }
    const files = forge?.prFiles ? await forge.prFiles(e.pr_number) : [];
    const { item, created } = await this.d.store.createWorkItem(
      {
        source: e.source,
        title: e.title,
        requester_id: author.user_id,
        project: this.project(),
        problem: `${e.title}\n\n${e.body}`.trim(),
        resources: [e.source.link],
        adopted: {
          pr_number: e.pr_number,
          head_branch: e.head_branch,
          head_sha: e.head_sha,
          allowed_paths: files,
          tier: floorTier(files, this.settings(this.project()).floors),
        },
      },
      { kind: "user", id: author.user_id },
      { enqueue: { kind: "review", idempotency_key: `${e.source.type}:${e.source.id}:adopt:review` } },
    );
    if (!created) return;
    this.d.log.info("PR adopted", { ...log, work_item_id: item.id });
    await this.showStatus(item);
  }

  /**
   * A head the factory did not record, on an open factory or adopted PR: one `manual` run with the pusher and
   * the range, changing no stage or blocked field (design 2026-11-01). Nothing is re-queued. While a run of the
   * item is running it may be pushing, and it records its own head; the PR is looked at again on a later poll.
   * An item with no recorded head (from before this) only takes the current head as its baseline.
   */
  private async recordHead(it: WorkItem, e: PrOpenEvent): Promise<void> {
    if (it.stage === "CLOSED" || it.last_head_sha === e.head_sha) return;
    if ((await this.d.store.listRuns(it.id)).some((r) => r.status === "running")) return;
    if (it.last_head_sha === null) {
      await this.d.store.recordPrHead({ id: it.id, expected_head: null, head_sha: e.head_sha, manual: null });
      return;
    }
    const actor = await this.pusher(it.id, e.head_sha);
    const r = await this.d.store.recordPrHead({
      id: it.id,
      expected_head: it.last_head_sha,
      head_sha: e.head_sha,
      manual: { actor, pr_number: e.pr_number },
    });
    if (r.ok && r.run) {
      this.d.log.info("manual push recorded", { work_item_id: it.id, run_id: r.run.id, pr_number: e.pr_number, actor: actor.id });
    }
  }

  /** The pushed head commit's author as a user: the forge does not name who pushed. Else system:pr-sync. */
  private async pusher(id: WorkItemId, sha: string): Promise<Actor> {
    const forge = this.byType.get(PR_SOURCE_TYPE);
    const author = forge?.commitAuthor ? await forge.commitAuthor(sha) : null;
    const principal = author ? await this.d.auth.resolve(author) : null;
    if (principal) return { kind: "user", id: principal.user_id };
    this.d.log.warn("pusher did not resolve to a user; recorded as system:pr-sync", { work_item_id: id, head_sha: sha });
    return PR_SYNC;
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
    await this.post(
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
   * The source issue was closed (design §4). The item closes as `completed` when the source says it was
   * closed as completed, else as `wont_do`; in the same transition its queued runs are cancelled and its
   * running runs are stopped (their next heartbeat, completion and tool calls get lease_lost, so nothing is
   * pushed and no outcome is stored). Store first: an item already CLOSED (by /reject, a merge, or an
   * earlier delivery of this close) is left alone, so a repeat or the factory's own close writes nothing. No
   * login is checked. An item with a PR is marked `pr_close_pending` in the same transition; the PR is then
   * closed with a comment (finishPrClose), retried on later ticks if that fails.
   */
  private async closeFromSource(e: SourceClosedEvent): Promise<void> {
    const item = await this.d.store.getWorkItemBySource(e.source.type, e.source.id);
    if (!item) return;
    if (item.stage !== "CLOSED") {
      const closer = e.closer ? await this.d.auth.resolve(e.closer) : null;
      if (!closer) {
        this.d.log.warn("source closed by an unknown user; recorded as the system actor", { work_item_id: item.id, source_id: e.source.id });
      }
      const actor: Actor = closer ? { kind: "user", id: closer.user_id } : INTAKE;
      const close_reason: CloseReason = e.state_reason === "completed" ? "completed" : "wont_do";
      await this.decide(item.id, (it) => {
        if (it.stage === "CLOSED") return null;
        const closesPr = it.pr_number !== null && this.prAdapter(it.source)?.closePr !== undefined;
        return {
          patch: {
            stage: "CLOSED",
            close_reason,
            blocked_on: closesPr ? "upstream" : "none",
            blocked_reason: closesPr ? PR_CLOSE_PENDING : null,
          },
          actor,
          reason: "source_closed",
          cancel_queued_runs: true,
          cancel_running_runs: true,
        };
      });
    }
    await this.finishPrClose(item.id);
  }

  /**
   * The rest of a source close for an item with a PR: one comment on the PR naming who closed the issue,
   * then the PR closed without a merge, then the pending mark cleared. A PR already merged or closed is left
   * alone. A failure is logged and the item stays pending, so tickSourceCloses tries again.
   */
  private async finishPrClose(id: WorkItemId): Promise<void> {
    const it = await this.d.store.getWorkItem(id);
    if (!it || !prClosePending(it) || it.pr_number === null) return;
    const adapter = this.prAdapter(it.source);
    if (!adapter?.closePr) return;
    try {
      const r = await adapter.closePr({
        pr_number: it.pr_number,
        closed: it.source,
        marker: `<!-- factory:pr-closed:${it.id} -->`,
        body: (closer) =>
          closer?.login ? `Closed because the issue was closed by @${closer.login}.` : "Closed because the issue was closed.",
      });
      this.d.log.info("pr closed after source close", { work_item_id: it.id, pr_number: it.pr_number, result: r });
    } catch (err) {
      this.d.log.warn("closing the PR after the source closed failed; retried on a later tick", {
        work_item_id: it.id,
        pr_number: it.pr_number,
        error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
      });
      return;
    }
    await this.decide(id, (cur) =>
      prClosePending(cur) ? { patch: { blocked_on: "none", blocked_reason: null }, actor: SYSTEM, reason: "pr_closed_for_source" } : null,
    );
  }

  /** The adapter PRs go through: the GitHub one, else the item's own source (as setStatus does). */
  private prAdapter(source: SourceRef): SourceAdapter | null {
    return this.byType.get(PR_SOURCE_TYPE) ?? this.byType.get(source.type) ?? null;
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
    await this.post(
      item.source,
      help ? helpReply(state) : unknownCommandReply(e.command, state),
      `<!-- factory:${help ? "help" : "unknown"}:${e.comment_id} -->`,
    );
  }

  /**
   * A plain-language comment on a work item (design §4): at most one reply, keyed on the comment id, that
   * names a suggested command or lists the commands for the item's state. Changes no state: the person
   * confirms by typing the command. In order: the work item, the commenter's write permission (no LLM call
   * and no reply without it), the length and open-item filters, the model call, validation, the egress scan.
   */
  private async handlePlainComment(e: PlainCommentEvent): Promise<void> {
    const llm = this.d.llm;
    if (!llm) return;
    const item = await this.d.store.getWorkItemBySource(e.source.type, e.source.id);
    if (!item) return;
    const principal = await this.authorize(e.author, "approve_spec", item.id);
    if ("refuse" in principal) return;
    const text = e.body.trim();
    if (text === "" || text.length > SUGGEST_MAX_CHARS || item.stage === "CLOSED") return;
    const state = commandState(item);
    const suggestion = await suggestCommand(text, state, llm);
    let body: string;
    if (suggestion === null) {
      body = ["The factory did not find a command in your comment, so nothing changed.", "", commandFooter(state)].join("\n");
    } else {
      const scan = suggestion.args ? await this.d.scanner.scan("comment", suggestion.args) : { clean: true as const };
      if (!scan.clean) {
        const rules = scan.findings.map((f) => f.rule).join(",");
        this.d.log.warn("suggestion blocked by the egress scan", { work_item_id: item.id, command: suggestion.command, rules });
        body = ["The factory could not suggest a command for your comment, so nothing changed.", "", commandFooter(state)].join("\n");
      } else {
        const typed = formatSuggestion(suggestion);
        const fence = "`".repeat(Math.max(3, ...[...typed.matchAll(/`+/g)].map((m) => m[0].length + 1)));
        body = [
          `Did you mean \`/${suggestion.command}\`? Nothing has changed. To apply it, reply with:`,
          "",
          fence,
          typed,
          fence,
        ].join("\n");
      }
    }
    this.d.log.info("plain comment answered", { work_item_id: item.id, suggested: suggestion?.command ?? null });
    await this.post(item.source, body, `<!-- factory:suggest:${e.comment_id} -->`);
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
    await this.post(
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
    const phase = commandPhase(it);
    const afterFailure = phase === "too_large" || phase === "failed_implement";
    if (afterFailure && e.kind === "revise_requested") return this.reviseAfterFailure(e, it, actor);
    if (!awaitingSpec(it) && !(afterFailure && e.kind === "spec_rejected")) {
      return { refuse: `the spec is not waiting for approval (the item is ${phaseLabel(phase)})` };
    }
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
   * `/revise <feedback>` at a failed implement run or a `diff_too_large` block (design §4): the item goes back
   * through triage with the feedback, then to the spec gate. The revision counter and `max_loops` apply as at
   * the spec gate, but at the limit nothing changes: the item keeps its block, where `/retry` and `/reject`
   * still apply. restart_count + 1 so the implement run after the next `/approve` gets a new run key; the old
   * failure comment is unlinked.
   */
  private reviseAfterFailure(e: Extract<ItemCommandEvent, { kind: "revise_requested" }>, it: WorkItem, actor: Actor): Decision | Refusal {
    const feedback = e.feedback.trim();
    if (!feedback) return { refuse: "it needs feedback after the command, e.g. `/revise keep the existing CLI flag`" };
    const limit = this.d.config.max_loops;
    if (it.revision_count >= limit) {
      return {
        refuse: `the spec was revised ${it.revision_count} times, the revision limit (\`max_loops\` = ${limit}); ` +
          "reply `/retry` to run the implementer again or `/reject <reason>` to close",
      };
    }
    const n = it.revision_count + 1;
    return {
      patch: {
        stage: "NEW",
        blocked_on: "none",
        blocked_reason: null,
        revision_count: n,
        restart_count: it.restart_count + 1,
        spec_feedback: feedback,
        failure_comment_url: null,
      },
      actor,
      reason: "spec_revision_requested",
      detail: { previous_blocked_reason: it.blocked_reason },
      // The spec-gate revision key: differs from the intake key and from every earlier revision's key.
      enqueue: { kind: "triage", idempotency_key: `${runKey(it, "triage")}:v${n}` },
    };
  }

  /**
   * The rest of a reject: one comment quoting the reason, then the source issue closed as not planned,
   * then the pending mark cleared. Each step is idempotent, so a repeat after a stop does no harm.
   */
  private async finishReject(id: WorkItemId): Promise<void> {
    const it = await this.d.store.getWorkItem(id);
    if (!it || !closePending(it)) return;
    // No adapter for the item's source: it stays pending (its state is kept) until one is configured.
    const source = this.adapterFor(it.source, "closeIssue");
    if (!source) return;
    const reason = it.spec_feedback?.trim() ?? "";
    const body = reason
      ? ["The spec was rejected, so the factory closed this issue as not planned. The reason given:", "", quote(reason)].join("\n")
      : "The spec was rejected with no reason given, so the factory closed this issue as not planned.";
    await this.comment(it, `rejected:${it.id}`, body);
    await source.closeIssue(it.source);
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

  /** The configured repo's project key (design 2026-11-01): what every write and lookup uses. Never shown. */
  private project(): string {
    return this.d.config.project.key;
  }

  /** The configured repo's `owner/name`, only to build PR source ids (`owner/name#N`, unchanged by project keys). */
  private repoPath(): string {
    return `${this.d.config.repo.owner}/${this.d.config.repo.name}`;
  }

  /** The per-project gate settings of `project` (design 2026-11-01): the only way core reads them. */
  private settings(project: string): ProjectSettings {
    return settingValues(project, this.d.config.settings, this.d.learned);
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
          const floor = floorTier(spec.allowed_paths, this.settings(it.project).floors);
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
          const tier = effectiveTier(parsed.value.tier, floorTier(it.allowed_paths, this.settings(it.project).floors), it.tier);
          if (parsed.value.verdict === "bug" && it.origin === "adopted") {
            // A person's branch: the review comment is on the PR, and the author fixes it. No implement run.
            return {
              patch: { tier, token_cost: tokens, blocked_on: "human", blocked_reason: CHANGES_REQUESTED },
              actor: SYSTEM,
              reason: CHANGES_REQUESTED,
              detail: { run_id: run.id },
              ack_run: run.id,
            };
          }
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
          return this.checkGate(it, run.id, { tier, token_cost: tokens }, run.id);
        }
        case "resolve": {
          // The worker pushed the merge to the same PR branch. A fresh review checks it; its key comes from
          // this run's id, so it never collides with the review of an earlier loop or resolve.
          const auto = parseAutoResolveKey(run.idempotency_key);
          if (auto) {
            const counts = await this.conflictCountsOf(it, 0);
            await this.prComment(it, `auto-resolved:${run.id}`, [
              `The factory resolved the merge conflict on PR #${it.pr_number} automatically (attempt ${auto.attempt} of ${AUTO_RESOLVE_LIMIT} for base \`${auto.base_sha.slice(0, 8)}\`) and pushed the merge. A fresh review runs next.`,
              "",
              conflictCountsLine(counts),
            ].join("\n"));
          }
          return {
            patch: { stage: "REVIEW", token_cost: tokens },
            actor: SYSTEM,
            reason: "resolved",
            detail: { run_id: run.id },
            ack_run: run.id,
            enqueue: { kind: "review", idempotency_key: `${it.id}:review:after-resolve:${run.id}` },
          };
        }
        case "manual":
          // Written already acknowledged, so never here; kept for exhaustiveness.
          return ack("run_ignored");
        case "update": {
          // The worker already commented on the PR. The item stays in REVIEW waiting for a human either way.
          switch (data.result) {
            case "pushed":
              return { patch: {}, actor: SYSTEM, reason: "update_pushed", ack_run: run.id };
            case "up_to_date":
              return ack("update_up_to_date");
            case "conflict":
              return this.autoResolve(it, run, typeof data.base_sha === "string" ? data.base_sha : "");
            case "tests_failed":
              return {
                patch: { blocked_reason: CONFLICT_PENDING },
                actor: SYSTEM,
                reason: "update_tests_failed",
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
   * The CI gate (design §5): a PR that passed review is offered for a human merge only once its checks
   * passed. Pending (or the source could not say): the item waits in `REVIEW` with `blocked_on: ci` /
   * `checks_pending`, and tickChecks looks again. Failed: back to implement like a review bug (loop_count + 1,
   * max_loops applies), with the failing check names on the state change for the next implementer.
   * `reviewRunId` is the review that passed; it keys the comments, so a re-decide posts each once.
   * `ackRun` acks that review when called from applyRun; tickChecks passes null.
   */
  private async checkGate(
    it: WorkItem,
    reviewRunId: RunId,
    fields: { tier?: Tier; token_cost?: number },
    ackRun: RunId | null,
  ): Promise<Decision> {
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
    if (checks.state === "failed") {
      const names = checks.failed.slice(0, MAX_CHECK_NAMES).map((n) => n.slice(0, MAX_CHECK_NAME_CHARS));
      const detail = { failed_checks: JSON.stringify(names), review_run_id: reviewRunId };
      if (it.origin === "adopted") {
        const patch = { ...fields, blocked_on: "human" as const, blocked_reason: CHECKS_FAILED };
        await this.checksComment(it, `checks-failed:${reviewRunId}`, names, (list) =>
          `PR #${it.pr_number} passed review but its checks failed${list}. The factory does not change a pull request a person opened; push a fix.\n\n${footerAfter(it, patch)}`);
        return { patch, actor: SYSTEM, reason: CHECKS_FAILED, detail, ...ack };
      }
      const loop = it.loop_count + 1;
      if (loop >= this.d.config.max_loops) {
        const patch = { ...fields, blocked_on: "human" as const, blocked_reason: "max_loops" };
        await this.checksComment(it, `max-loops:${reviewRunId}`, names, (list) =>
          `PR #${it.pr_number} passed review but its checks failed${list}. That makes ${loop} loops (limit ${this.d.config.max_loops}). A human needs to decide.\n\n${footerAfter(it, patch)}`);
        return { patch, actor: SYSTEM, reason: "max_loops", detail, ...ack };
      }
      const next = { ...it, loop_count: loop };
      await this.checksComment(it, `checks-failed:${reviewRunId}`, names, (list) =>
        `PR #${it.pr_number} passed review but its checks failed${list}. The factory sent it back to the implementer (loop ${loop} of ${this.d.config.max_loops}).`);
      return {
        patch: { ...fields, stage: "RUNNING", blocked_on: "none", blocked_reason: null, loop_count: loop },
        actor: SYSTEM,
        reason: "checks_failed",
        detail,
        ...ack,
        enqueue: { kind: "implement", idempotency_key: runKey(next, "implement") },
      };
    }
    // Auto-merge does not exist yet: auto_merge_max_tier is fixed at 0, so every PR goes to a human.
    const patch = { ...fields, blocked_on: "human" as const, blocked_reason: "merge_pending" };
    await this.comment(it, `merge:${reviewRunId}`,
      `PR #${it.pr_number} passed review (tier ${tier}) and its checks passed. A human merge is required.\n\n${footerAfter(it, patch)}`);
    return { patch, actor: SYSTEM, reason: "review_passed", ...ack };
  }

  /** The PR's checks; a source without them counts as passed, a source error as pending (logged). */
  private async readChecks(it: WorkItem): Promise<PrChecks> {
    // PRs live on the PR source (the forge), whatever source the item came from.
    const forge = this.byType.get(PR_SOURCE_TYPE);
    if (!forge?.prChecks || it.pr_number === null) return { state: "passed" };
    try {
      return await forge.prChecks(it.pr_number);
    } catch (err) {
      this.d.log.warn("reading PR checks failed", {
        work_item_id: it.id,
        pr_number: it.pr_number,
        error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
      });
      return { state: "pending" };
    }
  }

  /** A checks comment naming the failed checks; the names are forge text (G5), so they are left out if the scan flags them. */
  private async checksComment(it: WorkItem, key: string, names: string[], body: (list: string) => string): Promise<void> {
    const list = names.length ? `: ${names.map((n) => `\`${n.replace(/`/g, "'")}\``).join(", ")}` : "";
    const scan = await this.d.scanner.scan("comment", body(list));
    await this.comment(it, key, body(scan.clean ? list : ""));
  }

  /**
   * Looks again at every item waiting on its PR checks (`blocked_on: ci` / `checks_pending`) and applies the
   * gate: still pending changes nothing; passed → merge_pending; failed → back to implement. Safe on any
   * replica and safe to repeat: each decision re-reads the item and lands as a conditional transition.
   */
  async tickChecks(): Promise<void> {
    const waiting = await this.d.store.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "ci", limit: CHECKS_BATCH });
    for (const w of waiting) {
      if (!waitingOnChecks(w)) continue;
      const review = (await this.d.store.listRuns(w.id)).filter((r) => r.kind === "review" && r.outcome?.status === "succeeded").at(-1);
      if (!review) continue;
      await this.guard("checks", () => this.decide(w.id, (it) => (waitingOnChecks(it) ? this.checkGate(it, review.id, {}, null) : null)).then(() => undefined));
    }
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
    const { max_restart, retry_base_ms, retry_max_ms } = this.d.config;
    const { max_attempts } = this.settings(it.project);
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
   * An update run found a conflict (design §5 Merge conflict, decision changed 2026-11-02): under the limit of
   * AUTO_RESOLVE_LIMIT automatic resolve runs per base commit, the item goes to RUNNING and a resolve run is
   * enqueued in the same transition, keyed on (item, base commit, attempt). At the limit, or with no base
   * commit to key on, it waits for a person on merge_conflict_pending, as before. The ack fences the update run,
   * so applying it twice enqueues one resolve run.
   */
  private async autoResolve(it: WorkItem, run: Run, baseSha: string): Promise<Decision> {
    const keys = (await this.d.store.listRuns(it.id)).filter((r) => r.kind === "resolve").map((r) => r.idempotency_key);
    const done = baseSha ? autoResolveAttempts(keys, it.id, baseSha) : AUTO_RESOLVE_LIMIT;
    const attempt = nextAutoResolveAttempt(done);
    const detail = { run_id: run.id, base_sha: baseSha || null, auto_resolve_attempts: done };
    if (attempt === null) {
      const counts = await this.conflictCountsOf(it, 1);
      await this.prComment(it, `auto-resolve-limit:${run.id}`, [
        `PR #${it.pr_number} still conflicts with base \`${baseSha.slice(0, 8) || "unknown"}\`, and the factory already made ${done} automatic resolve attempts for it (limit ${AUTO_RESOLVE_LIMIT} per base commit), so it stopped. Nothing was pushed.`,
        "Comment `/resolve [notes]` to try again, or resolve it by hand.",
        "",
        conflictCountsLine(counts),
      ].join("\n"));
      return { patch: { blocked_reason: CONFLICT_PENDING }, actor: SYSTEM, reason: "update_conflict", detail, ack_run: run.id };
    }
    return {
      patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null },
      actor: SYSTEM,
      reason: "auto_resolve_started",
      detail: { ...detail, attempt },
      ack_run: run.id,
      enqueue: { kind: "resolve", idempotency_key: autoResolveKey(it.id, baseSha, attempt), input: { notes: "" } },
    };
  }

  /**
   * Any failed resolve run (agent, scope, tests, push, egress, rate limit, lease): nothing was pushed, so the
   * PR is as it was. An automatic run under the limit for its base commit enqueues the next attempt at once
   * (a rate limit waits for its reset), with no comment; the item stays RUNNING (decision changed 2026-11-02).
   * Otherwise (a human's `/resolve`, or the last automatic attempt) the item goes back to waiting on the
   * conflict, not to run_failed:*, so the next `/resolve` is accepted. One comment, keyed on the run, names
   * the code; for an automatic run it also states the conflict counts.
   */
  private async resolveFailed(it: WorkItem, run: Run, code: string): Promise<Decision> {
    const auto = parseAutoResolveKey(run.idempotency_key);
    const next = auto ? nextAutoResolveAttempt(auto.attempt) : null;
    if (auto && next !== null) {
      const failedAt = Date.parse(run.finished_at ?? this.d.clock.now().toISOString());
      const reset = run.outcome?.status === "failed" && code === "rate_limited" ? run.outcome.reset_at : null;
      const notBefore = code === "rate_limited" ? (reset ?? iso(failedAt + this.d.config.retry_max_ms)) : null;
      return {
        patch: {},
        actor: SYSTEM,
        reason: "auto_resolve_retry",
        detail: { run_id: run.id, error_code: code, base_sha: auto.base_sha, attempt: next },
        ack_run: run.id,
        enqueue: {
          kind: "resolve",
          idempotency_key: autoResolveKey(it.id, auto.base_sha, next),
          input: { notes: "" },
          ...(notBefore ? { not_before: notBefore } : {}),
        },
      };
    }
    const detail = run.outcome?.status === "failed" ? run.outcome.detail.trim() : "";
    const counts = auto ? await this.conflictCountsOf(it, 1) : null;
    const body = (withDetail: boolean) => [
      auto
        ? `The automatic resolve run failed (\`${code}\`): ${describeFailure(code)}.${withDetail && detail ? ` ${detail}` : ""} That was attempt ${auto.attempt} of ${AUTO_RESOLVE_LIMIT} for base \`${auto.base_sha.slice(0, 8)}\`, so the factory stopped.`
        : `The resolve run failed (\`${code}\`): ${describeFailure(code)}.${withDetail && detail ? ` ${detail}` : ""}`,
      "",
      `Nothing was pushed; PR #${it.pr_number} is unchanged and still has the merge conflict.`,
      "Comment `/resolve [notes]` to try again, or resolve it by hand.",
      ...(counts ? ["", conflictCountsLine(counts)] : []),
    ].join("\n");
    // The detail is run output (G5): post it only if the scan passes, else the comment without it.
    const scan = await this.d.scanner.scan("comment", body(true));
    if (auto) await this.prComment(it, `run-failed:${run.id}`, body(scan.clean));
    else await this.comment(it, `run-failed:${run.id}`, body(scan.clean));
    return {
      patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: CONFLICT_PENDING },
      actor: SYSTEM,
      reason: "resolve_failed",
      detail: { run_id: run.id, error_code: code, ...(auto ? { base_sha: auto.base_sha, attempt: auto.attempt } : {}) },
      ack_run: run.id,
    };
  }

  /**
   * The item's conflict counts from its run history and state changes. `pending`: 1 when the decision being
   * made sets merge_conflict_pending, which its own state change will record only after the comment.
   */
  private async conflictCountsOf(it: WorkItem, pending: 0 | 1): Promise<{ automatic: number; person: number }> {
    const c = conflictCounts(await this.d.store.listRuns(it.id), await this.d.store.listStateChanges(it.id));
    return { automatic: c.automatic, person: c.person + pending };
  }

  /**
   * A comment on the item's PR (the forge holds PRs, whatever source the item came from); on the item's own
   * source when it has no PR. GitHub serves PR comments through the issue API, so the PR is a source ref.
   */
  private async prComment(it: WorkItem, key: string, body: string): Promise<void> {
    if (it.pr_number === null) {
      await this.comment(it, key, body);
      return;
    }
    const link = it.source.type === PR_SOURCE_TYPE ? it.source.link.replace(/\d+$/, String(it.pr_number)) : "";
    await this.post({ type: PR_SOURCE_TYPE, id: `${this.repoPath()}#${it.pr_number}`, link }, body, `<!-- factory:${key} -->`);
  }

  /**
   * The pre-push size gate failed (design §4): no automatic retry, since the same spec would likely overreach
   * again. Blocks on a human with the usual run_failed reason, so `/retry` reruns the implement.
   */
  private async diffTooLarge(it: WorkItem, run: Run): Promise<Decision> {
    const detail = run.outcome?.status === "failed" ? run.outcome.detail : "";
    const { max_diff_lines, max_diff_files } = this.settings(it.project);
    const patch = { blocked_on: "human" as const, blocked_reason: `run_failed:implement:${DIFF_TOO_LARGE}` };
    const url = await this.comment(it, `run-failed:${run.id}`, [
      "## Factory size check: push blocked",
      "",
      `The implement run's diff is too large to review, so nothing was pushed: ${detail}.`,
      "",
      `Limits: \`max_diff_lines\` = ${max_diff_lines} (added plus deleted lines), \`max_diff_files\` = ${max_diff_files}.`,
      "",
      "Comment `/revise <feedback>` to get a new, smaller spec written with your feedback, or `/retry` to run the implementer again on the same spec; it must make a smaller change.",
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
      ? `The ${run.kind} run failed ${n} times (limit \`max_attempts\` = ${this.settings(it.project).max_attempts}), so the factory stopped retrying it.`
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
    if (kind === "manual") return false;
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
    const base = tierBudget(this.settings(it.project).budgets, next.tier);
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
      await this.adapterFor(source, "markSeen")?.markSeen(source, commentId);
    } catch (err) {
      this.d.log.warn("mark seen failed", {
        source_id: source.id,
        comment_id: commentId,
        error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
      });
    }
  }

  /**
   * The item's status on its issue and, once it has one, on its PR. Best effort, each write on its own. An
   * adopted item's source is its PR, so it is labelled once.
   */
  private async showStatus(it: WorkItem): Promise<void> {
    const status = statusOf(it);
    await this.setStatus(it.source, status, null);
    if (it.pr_number !== null && it.origin !== "adopted") await this.setStatus(it.source, status, it.pr_number);
  }

  /**
   * Best effort, like markSeen: a failure is a warning and never changes a transition's outcome. The item
   * itself is labelled through its own source; a PR through the GitHub adapter, where PRs live. With no
   * GitHub adapter (one non-GitHub source alone), the PR call goes to the item's own source, as it always did.
   */
  private async setStatus(source: SourceRef, status: WorkStatus, pr_number: number | null): Promise<void> {
    try {
      const adapter = pr_number === null
        ? this.adapterFor(source, "setStatus")
        : (this.byType.get(PR_SOURCE_TYPE) ?? this.adapterFor(source, "setStatus"));
      await adapter?.setStatus(source, status, pr_number);
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
    return (await this.post(it.source, body, `<!-- factory:${key} -->`))?.url ?? null;
  }

  /** postComment through the adapter of `source`'s type; null (and a warning) when none is configured. */
  private async post(source: SourceRef, body: string, marker: string): Promise<{ url: string | null } | null> {
    const adapter = this.adapterFor(source, "postComment");
    return adapter ? adapter.postComment(source, body, marker) : null;
  }

  /**
   * The adapter for `source`'s type. None configured (the source was removed from `plugins.source`): a
   * warning and null, so the call is skipped and the item keeps its state.
   */
  private adapterFor(source: SourceRef, call: string): SourceAdapter | null {
    const adapter = this.byType.get(source.type);
    if (adapter) return adapter;
    this.d.log.warn("no source adapter for the item's source type; skipped", { source_type: source.type, source_id: source.id, call });
    return null;
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

/** A reviewed PR whose checks have not finished (design §5 CI gate). */
function waitingOnChecks(it: WorkItem): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "ci" && it.blocked_reason === CHECKS_PENDING;
}

/** A spec waiting for `/approve`, `/reject` or `/revise`; past the revision limit, only the first two apply. */
function awaitingSpec(it: WorkItem): boolean {
  return it.stage === "READY" && (it.blocked_reason === "spec_pending" || it.blocked_reason === "max_revisions");
}

/** An item closed from its source whose PR comment or PR close may not have happened yet. */
function prClosePending(it: WorkItem): boolean {
  return it.stage === "CLOSED" && it.blocked_on === "upstream" && it.blocked_reason === PR_CLOSE_PENDING;
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
      refuse: `the item is not waiting on a merge conflict (it is ${phaseLabel(commandPhase(it))}); ` +
        `\`/resolve\` applies only when the ${phaseLabel("merge_conflict")}`,
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
    return { refuse: `the item is ${phaseLabel("floor_tier")}, which is not a failed run; reply \`/approve\` to raise its tier` };
  }
  if (e.kind === "revise_requested") {
    return { refuse: `the item is ${phaseLabel("floor_tier")}, not waiting on a spec; reply \`/approve\` to raise its tier or \`/reject <reason>\` to close` };
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
