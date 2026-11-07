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
import {
  COMMANDS, DEPENDENCY_CLOSED, commandFooter, commandPhase, commandSpec, commandState, failedRunKind, helpReply, parseCommandPaths, parseLink, phaseLabel,
  retryPathsReply, unknownCommandReply,
} from "./commands.js";
import { type FactoryConfig, STALL_DEFAULTS } from "./config.js";
import {
  type DependencyLink,
  type DependencyVerdict,
  dependencyReason,
  dependencyVerdict,
  holdReason,
  isDependencySource,
  shortRef,
} from "./coordination.js";
import { type LearnedSettingsSource, LiveSettings, type ProjectSettings, settingValues } from "./settings.js";
import { Listener } from "./listener.js";
import { parseFixReferences, parseRevert } from "./links.js";
import type { Logger } from "./log.js";
import {
  type NeedsHuman, type ReviewOutput, SPEC_CONFLICT, type TriagePhase, findingLine, parseNeedsHuman, parseReview, parseTriage, specFindings,
} from "./outputs.js";
import {
  AGENT_NEEDS_HUMAN,
  AUTO_RESOLVE_LIMIT,
  REPEATED_FAILURE,
  type FailureClass,
  blockingRunKind,
  failureLine,
  repeatsFastInfraFailure,
  repeatsLastFailure,
  preflightCheck,
  PREFLIGHT_ACCESS,
  SKIP_LABEL,
  autoResolveAttempts,
  autoResolveKey,
  effectiveTier,
  failureClass,
  floorTier,
  isCovered,
  needsSpecApproval,
  nextAutoResolveAttempt,
  parseAutoResolveKey,
  retryDelayMs,
  retryKey,
  runKey,
  sameStep,
  workItemIdFromBranch,
  FORGE_AUTH,
  MODEL_STALL,
  NO_AUTO_RETRY,
  SESSION_RELEASED,
} from "./policy.js";
import { commandEvent } from "./command-inbox.js";
import { enqueueImprove, utcDay } from "./improver.js";
import { MERGE_CHECK_BATCH, MergeChecker, canMergeCheck } from "./merge-check.js";
import { lastPrNotes } from "./pr-body.js";
import { MERGE_CONFLICT_PENDING, conflictCounts, conflictCountsLine } from "./resolve.js";
import { renderSpec } from "./spec-comment.js";
import { SPEC_DECISIONS, specChanged, specDecisionDetail, specKind } from "./standing.js";
import { applyCompanions } from "./companions.js";
import {
  PHASE_HOLD, PHASE_MARKER, PHASES_OPEN, SPLIT_APPROVED, SPLIT_FILING, SPLIT_FILING_STALE_MS, parseSizeDetail, parseSubIssues, phaseIssueBody,
  phaseLinkDetail, phaseMarker, phaseTitle, suggestSplit,
} from "./split.js";
import { SUGGEST_MAX_CHARS, formatSuggestion, suggestCommand } from "./suggest.js";
import { type WorkStatus, statusOf } from "./status-label.js";
import {
  type Actor, type CloseReason, type DependencyState, type Run, type RunId, type RunKind, type SourceRef, type SourceType,
  type StateChange, type StateChangeDetail, type Tier, type Timestamp, type WorkItem, type WorkItemId, type WorkItemPatch, outcomeTokens, runTokenCount,
} from "./types.js";
import { failingTests, firstErrorLine, stripAnsi } from "./output-summary.js";
import { type ParsedVerdict, parseVerdict } from "./verdict.js";
import type { AuthAction, AuthProvider, ExternalIdentity, Principal } from "../interfaces/auth-provider.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type {
  AppCommandRequest, CliCommand, FactoryStore, NewBudgetCheckpoint, RedeemLinkResult, ThreadDelivery, ThreadLinkField, TransitionInput,
} from "../interfaces/factory-store.js";
import { labelTarget } from "../interfaces/factory-store.js";
import { PROVIDER_SETUP } from "../interfaces/agent-runner.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { Sandbox } from "../interfaces/sandbox.js";
import type { Forge, ForgeEvent, PrChecks } from "../interfaces/forge.js";
import type { PollResult, PollSource, SourceAdapter, SourceEvent, StreamSource } from "../interfaces/source-adapter.js";

/**
 * The GitHub core rate limit as one process sees it (design §5 Sources, GitHub call budget): GitHub's limit,
 * remaining calls and reset time, this process's `budget_share`, the calls it may count (`share_limit`, null before
 * GitHub reported a limit) and its counted calls in the window. `waiting`: no calls left before the reset; `low`:
 * optional reads wait (under `min_remaining`, or the share is used).
 */
export interface GitHubBudgetStatus {
  limit: number;
  remaining: number;
  reset_at: string;
  budget_share: number;
  share_limit: number | null;
  counted: number;
  state: "ok" | "low" | "waiting";
  as_of: string;
}

/** The store cursor the controller writes its GitHub budget to after each poll, for the status page. */
export const GITHUB_BUDGET_CURSOR = "github:budget";

/** The reset time a call refused for a used-up rate limit waits for (its `wait_until`), else null. */
export function rateLimitWait(err: unknown): string | null {
  const v = err instanceof Error ? (err as { wait_until?: unknown }).wait_until : undefined;
  return typeof v === "string" && v !== "" ? v : null;
}

export interface ControllerDeps {
  store: FactoryStore;
  /**
   * The configured sources (`plugins.source`), at most one per source type (design 2026-11-01). Each item's
   * comments, mark-seen, status and close go to the adapter of its own source type. Give `sources`, or `source`
   * for exactly one.
   */
  sources?: readonly SourceAdapter[];
  /** One source: the same as `sources: [source]`. */
  source?: SourceAdapter;
  /**
   * The forge (`plugins.forge`, issue #273): every PR event and PR fact is read from it, and every PR comment and
   * PR status goes through it, whatever source the item came from. Absent or null: no PR is read or written; a PR
   * comment or status then goes to the item's own source.
   */
  forge?: Forge | null;
  /** Authorizes commands from GitHub (and every non-local origin). */
  auth: AuthProvider;
  /**
   * Authorizes commands from the local CLI (identity provider `local`) and the local UI (app requests); issue
   * #318: local commands never depend on the GitHub auth plugin. Absent: `auth`.
   */
  local_auth?: AuthProvider;
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
  /**
   * The live settings (design 2026-11-03): refreshed at the start of each tick and of each public tick step, so
   * a retry, attempt or loop change applies at the next decision and a poll, tick or lease change at the next
   * tick. Absent: `config`, fixed.
   */
  settings?: LiveSettings;
  /**
   * The repeated-failure rule (issue #167, design 05-restarts): two task failures in a row in one step with the
   * same code and detail line block the item with `repeated_failure`. Absent or true: on. False: off, and the step
   * retries up to max_attempts.
   */
  repeated_failure_rule?: boolean;
  /**
   * The sandbox the worker pool uses (design §5 Merge check): the controller only fetches through it and runs
   * its read-only merge check. Absent, or without fetchBranch and mergeCheck: no local merge check.
   */
  sandbox?: Sandbox;
  /**
   * The GitHub client's budget (`GitHubClient.status`): written to GITHUB_BUDGET_CURSOR after each poll, so the
   * status page shows remaining calls, the reset and this process's count. Absent: nothing is written.
   */
  github_budget?: () => GitHubBudgetStatus | null;
}

type Decision = Omit<TransitionInput, "id" | "expected_version"> | null;
/** A decision whose implement or review run is held at a budget checkpoint instead of queued. */
type Hold = Omit<TransitionInput, "id" | "expected_version" | "enqueue"> & { checkpoint: NewBudgetCheckpoint };
/** Why a human's command was not applied; posted back to them. Plain null stays a silent no-op. */
type Refusal = { refuse: string };
/** What a `+paths` adds to a transition (issue #280): the widened allowed_paths and a raised tier, and the added paths. */
type Widening = { patch: Pick<WorkItemPatch, "allowed_paths" | "tier">; detail: StateChangeDetail };
const NO_WIDENING: Widening = { patch: {}, detail: {} };
type CommandEvent = Extract<SourceEvent, { kind: "spec_approved" | "spec_rejected" | "revise_requested" | "retry_requested" | "budget_continue" | "resolve_requested" }>;
type ItemCommandEvent = Exclude<CommandEvent, { kind: "budget_continue" }>;
type ResolveEvent = Extract<SourceEvent, { kind: "resolve_requested" }>;
type ReviseEvent = Extract<SourceEvent, { kind: "revise_requested" }>;
type PrReviewEvent = Extract<ForgeEvent, { kind: "pr_changes_requested" }>;
type BaseCommitEvent = Extract<SourceEvent, { kind: "base_commit" }>;
type VerdictEvent = Extract<SourceEvent, { kind: "verdict_submitted" }>;
type SourceClosedEvent = Extract<SourceEvent, { kind: "source_closed" }>;
type InfoEvent = Extract<SourceEvent, { kind: "help_requested" | "unknown_command" }>;
type PlainCommentEvent = Extract<SourceEvent, { kind: "plain_comment" }>;
type PrOpenEvent = Extract<ForgeEvent, { kind: "pr_open" }>;
type PrFinishedEvent = Extract<ForgeEvent, { kind: "pr_merged" | "pr_closed" }>;
/** One poll of a poll source, read but not handled yet: its events wait for the forge's (see intake). */
type Polled = { source: PollSource; cursor: string | null; result: PollResult };

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
/** Why a `/link` code was refused, as the reply says it. Never names the code. */
const LINK_REFUSALS: Record<Exclude<RedeemLinkResult, { ok: true }>["reason"], string> = {
  invalid: "the code is wrong",
  expired: "the code has expired (codes work for 10 minutes)",
  used: "the code was already used",
  locked: "the code is locked after too many wrong codes",
  already_linked: "this account is already linked to another factory user",
};
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
/** The refusal of an `/approve +paths` on a split spec (issue #280): the approval files sub-issues, it implements nothing. */
const SPLIT_PATHS = "`+paths` does not apply to a split spec, whose `/approve` files one sub-issue per phase; reply `/approve` without `+paths`, then add paths on a phase's issue";
/** Characters of an approval note kept on the state change (design §4). */
const MAX_NOTE_CHARS = 2000;
/** Characters of PR feedback (a `/revise` on a PR, or a "Request changes" review) kept and sent to the implementer. */
const MAX_FEEDBACK_CHARS = 8000;
/** State change reasons of PR feedback that started an implement run (design §4). */
const PR_REVISE = "pr_revise_requested";
const PR_CHANGES = "pr_changes_requested";
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
/** How long the state of a dependency the store does not track, read from the forge, is reused (issue #254). */
export const DEPENDENCY_STATE_TTL_MS = 10 * 60_000;
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
/** Held phases and open split parents looked at per intake tick (design 2026-11-01). */
const PHASE_BATCH = 50;
/** Queued implement runs and dependency-held items looked at per coordination tick (design §5, 2026-11-03). */
const COORDINATION_BATCH = 50;
/** blocked_reason prefix (with `blocked_on: human`) of a dependency cycle; DEPENDENCY_CLOSED is in commands.ts. */
const DEPENDENCY_CYCLE = "dependency_cycle";
/** Commands read from the command inbox per tick (issue #282). */
const COMMAND_BATCH = 100;
/** The command inbox's cursor, and the `local` source's cursor it starts from (issue #282). */
const COMMANDS_CURSOR = "commands";
const LEGACY_LOCAL_CURSOR = "intake:local";
/** Outbox rows delivered per tick at most (issue #282). */
const OUTBOX_BATCH = 50;
/** Local items: the store holds their thread and state, so they need no adapter (issue #282). */
const LOCAL_TYPE: SourceType = "local";
/** The state change detail key that names the app request a transition applied, so a second apply finds it. */
const APP_REQUEST = "app_request";
/** A command name safe to quote in a reply: anything else is called "the command". */
const QUOTABLE_COMMAND = /^[a-z][a-z0-9_-]{0,31}$/;
/** Inbox rows a stream intake step reads at most per tick. */
const INBOX_BATCH = 100;
const DAY_MS = 86_400_000;

/** The forge's cursor, per PR ref type; while it is empty the forge's handover cursor is read (issue #273). */
function forgeCursorName(forge: Forge): string {
  return `forge:${forge.ref_type}`;
}

/**
 * The sources a controller runs (design 2026-11-01): any number, no two of one type. PRs come from the forge,
 * so no source type is required (issue #273). Errors name `plugins.source`, the config key that lists them.
 */
function checkSources(d: Pick<ControllerDeps, "source" | "sources">): readonly SourceAdapter[] {
  if (d.source !== undefined && d.sources !== undefined) throw new Error("Controller takes `source` or `sources`, not both");
  // None is allowed (issue #282): items and commands live in the store, and messages wait in the outbox.
  const sources = d.sources ?? (d.source ? [d.source] : []);
  const seen = new Set<SourceType>();
  for (const s of sources) {
    if (seen.has(s.type)) {
      throw new Error(`plugins.source lists two sources of type "${s.type}"; each source type can be listed once`);
    }
    seen.add(s.type);
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
  /** Where PRs live, or null when config selects no forge. Fixed at construction. */
  private readonly forge: Forge | null;
  /** The settings in effect: a cache of the config file plus the stored overrides, refreshed each tick. */
  private readonly live: LiveSettings;
  /** The local merge check; its only in-process state is a fetch throttle no other replica needs. */
  private readonly merges: MergeChecker | null;
  /**
   * The forge's answers for dependencies the store does not track, by source id, each reused for
   * DEPENDENCY_STATE_TTL_MS (issue #254); `null` for a read that failed, so it is not retried before then. Per
   * process, only a cache: a replica without it asks the forge once.
   */
  private readonly dependencyStates = new Map<string, { state: DependencyState | null; at: number }>();
  /**
   * When each item's last failed link read was, so a coordination pass does not read its stale links again before
   * DEPENDENCY_STATE_TTL_MS (issue #254). Per process, only a throttle: a replica without it reads once.
   */
  private readonly linkFailures = new Map<WorkItemId, number>();
  /** True until the start-up status catch-up ran in full; a low request budget defers it (issue #254). */
  private catchUpPending = true;
  /** The UTC day whose improve run this process saw queued (design §7). A cache only: the run's key dedupes. */
  private improveDay: string | null = null;

  constructor(private readonly d: ControllerDeps) {
    this.merges = canMergeCheck(d.sandbox) ? new MergeChecker({ store: d.store, sandbox: d.sandbox, clock: d.clock }) : null;
    this.sources = checkSources(d);
    this.byType = new Map(this.sources.map((s) => [s.type, s]));
    this.forge = d.forge ?? null;
    this.live = d.settings ?? LiveSettings.fixed(d.config);
  }

  /** The config with each settable key at its effective value as of the last refresh. */
  private get cfg() {
    return this.live.config();
  }

  async run(signal: AbortSignal): Promise<void> {
    // The label, never the key: log lines and comments name a project by its readable path.
    this.d.log.info("controller started", { project: this.cfg.project.label });
    const streams = this.sources.filter((s): s is StreamSource => s.intake === "stream");
    // Each stream source gets its own listener; its store lease (per source type) lets only one replica subscribe.
    const listening = Promise.all(streams.map((s) => this.listener(s).run(signal)));
    let lastPoll = -Infinity;
    while (!signal.aborted) {
      await this.live.refresh();
      // Optional reads: while a source's request budget is low the catch-up waits, then runs (issue #254).
      if (this.catchUpPending) await this.guard("status catch-up", async () => void (await this.catchUpStatus()));
      const now = this.d.clock.now().getTime();
      const due = now - lastPoll >= this.cfg.poll_interval_ms;
      if (due) lastPoll = now;
      // A poll source is asked on its interval; an inbox is a store read, so it is read every tick.
      if (due || streams.length > 0) await this.guard("intake", () => this.intake(due));
      if (due && streams.length > 0) await this.guard("inbox cleanup", () => this.cleanupInbox());
      // PR checks are read from the forge, so on the poll interval like a poll source.
      if (due) await this.guard("checks", () => this.checksStep());
      // Dependency states are read from the forge too, so on the poll interval (design §5, 2026-11-03).
      if (due) await this.guard("coordination", () => this.coordinationStep());
      // The local merge check fetches the base, so on the poll interval too (design §5 Merge check).
      if (due) await this.guard("merge check", () => this.mergeCheckStep());
      // The command inbox (CLI and app commands) is a store read, so every tick, like an inbox.
      await this.guard("commands", () => this.commandsStep());
      await this.guard("runs", () => this.runsStep());
      await this.guard("reaper", () => this.reaperStep());
      await this.guard("model probe", () => this.probeStep());
      // A store read until the day changes: the day's improve run is queued once (design §7).
      await this.guard("improve", () => this.improveStep());
      // Last, so the messages this tick wrote go out in it.
      await this.guard("outbox", () => this.outboxStep());
      await this.d.clock.sleep(this.cfg.tick_ms, signal).catch(() => undefined);
    }
    await listening;
  }

  /** The listener for a stream source, owned by this replica. */
  listener(source: StreamSource): Listener {
    const live = this.live;
    return new Listener({
      store: this.d.store,
      source,
      clock: this.d.clock,
      // Getters: the listener's renewal reads the live values, so a lease change applies at its next renewal.
      config: { get lease_ms() { return live.config().lease_ms; }, get heartbeat_ms() { return live.config().heartbeat_ms; } },
      log: this.d.log,
      owner: this.d.replica_id ?? `controller:${Math.random().toString(36).slice(2, 12)}`,
    });
  }

  /** One intake step of every source: each poll source is polled, each stream source's inbox is read. */
  async tickIntake(): Promise<void> {
    await this.live.refresh();
    await this.intake(true);
    await this.commandsStep();
    await this.outboxStep();
  }

  /**
   * One outbox step (issue #282): every pending thread entry of a configured source type is delivered to its
   * target source once. The only caller of a source's postComment.
   */
  async tickOutbox(): Promise<void> {
    await this.live.refresh();
    await this.outboxStep();
  }

  /** One command inbox step: the CLI and app commands after the cursor (issue #282). */
  async tickCommands(): Promise<void> {
    await this.live.refresh();
    await this.commandsStep();
    await this.outboxStep();
  }

  /**
   * Each source's step and the forge's run on their own guard, so one failing (a poll that throws, a bad cursor)
   * never stops the others in the same tick. Poll sources and the forge run only when `pollDue`. The poll sources
   * are read first and the forge after them, and the forge's events are handled first (issue #273): a merge that
   * closed an issue happened before the close, so the forge's read already sees it and the merge is applied
   * before the source's close. Unfinished rejects are retried once per tick that polled.
   */
  private async intake(pollDue: boolean): Promise<void> {
    const polled: Polled[] = [];
    for (const s of this.sources) {
      if (s.intake === "stream") await this.guard(`intake:${s.type}`, () => this.tickInbox(s));
      else if (pollDue) await this.guard(`intake:${s.type}`, async () => void polled.push(await this.readPoll(s)));
    }
    const forge = this.forge;
    if (pollDue && forge) await this.guard("forge", () => this.tickForge(forge));
    for (const p of polled) await this.guard(`intake:${p.source.type}`, () => this.applyPoll(p));
    if (pollDue) await this.guard("github budget", () => this.recordGitHubBudget());
    if (!pollDue || (!forge && !this.sources.some((s) => s.intake === "poll"))) return;
    await this.guard("source closes", () => this.tickSourceCloses());
    // Phases are GitHub sub-issues, so their holds and parents move once per poll, after its closes are applied.
    await this.guard("phases", () => this.tickPhases());
  }

  /** One poll of one source, through its own cursor `intake:<type>`; applyPoll handles it. */
  private async readPoll(source: PollSource): Promise<Polled> {
    const cursor = await this.d.store.getCursor(`intake:${source.type}`);
    return { source, cursor, result: await source.poll(cursor) };
  }

  private async applyPoll({ source, cursor, result }: Polled): Promise<void> {
    for (const e of result.events) await this.guard(`event:${e.kind}`, () => this.handle(e));
    await this.d.store.advanceCursor(`intake:${source.type}`, cursor, result.next_cursor);
  }

  /** This process's GitHub budget, stored for the status page; the stored value is replaced, never merged. */
  private async recordGitHubBudget(): Promise<void> {
    const status = this.d.github_budget?.();
    if (!status) return;
    const current = await this.d.store.getCursor(GITHUB_BUDGET_CURSOR);
    await this.d.store.advanceCursor(GITHUB_BUDGET_CURSOR, current, JSON.stringify({ ...status, replica_id: this.d.replica_id ?? null }));
  }

  /**
   * One poll of the forge, through its cursor `forge:<ref type>`. While that is empty, the forge's handover cursor
   * (the position it was kept under before) is its first cursor, so an upgrade neither misses nor repeats a merge.
   */
  private async tickForge(forge: Forge): Promise<void> {
    const name = forgeCursorName(forge);
    const cursor = await this.d.store.getCursor(name);
    const first = cursor ?? (forge.handover_cursor ? await this.d.store.getCursor(forge.handover_cursor) : null);
    const { events, next_cursor } = await forge.poll(first);
    for (const e of events) await this.guard(`event:${e.kind}`, () => this.handle(e));
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
    for (const row of rows) await this.guard(`event:${row.event.kind}`, () => this.handle(row.event));
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
    const deleted = await this.d.store.pruneInbox(source.type, inboxSeq(cursor), this.cfg.inbox_retention_days * DAY_MS);
    if (deleted > 0) this.d.log.info("inbox cleanup", { source_type: source.type, deleted });
  }

  async tickRuns(): Promise<void> {
    await this.live.refresh();
    await this.runsStep();
    await this.outboxStep();
  }

  /**
   * The command inbox (issue #282): every command after the cursor `commands`, in seq order. A CLI command for a
   * local item becomes the event the same comment gives on GitHub (the same parser) and goes through handleEvent,
   * so it gets the same authorize check and replies; an app request (args.app_request) is applied through
   * applyAppRequest. The cursor starts where the `local` source's `intake:local` cursor stopped. A command whose
   * handling throws (a store error) holds the cursor before it, so it is tried again next tick, the ones after it
   * then. Any replica may run it: handling is idempotent and the cursor moves only from the value read.
   */
  private async commandsStep(): Promise<void> {
    const cursor = await this.d.store.getCursor(COMMANDS_CURSOR);
    const start = cursor ?? (await this.d.store.getCursor(LEGACY_LOCAL_CURSOR));
    const after = start ? Number(start) : 0;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error(`command inbox: bad cursor ${JSON.stringify(start)}`);
    const commands = await this.d.store.listCliCommandsAfter(after, COMMAND_BATCH);
    let last: number | null = null;
    for (const c of commands) {
      try {
        await this.handleInboxCommand(c);
      } catch (err) {
        // Held, not skipped: the cursor stops before it, so the next tick tries it again (and the ones after it).
        this.d.log.error("command failed; retried next tick", {
          command_seq: c.seq,
          error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
        });
        break;
      }
      last = c.seq;
    }
    if (last !== null) await this.d.store.advanceCursor(COMMANDS_CURSOR, cursor, String(last));
  }

  private async handleInboxCommand(c: CliCommand): Promise<void> {
    const app = c.args.app_request;
    if (typeof app === "number") {
      const r = await this.d.store.getAppCommandRequest(app);
      if (r && r.handled_at === null) await this.applyAppRequest(r);
      return;
    }
    const id = c.args.item;
    if (typeof id !== "string" || id === "") return;
    const item = await this.d.store.getWorkItem(id as WorkItemId);
    // CLI commands act on local items only; the CLI refuses any other when it writes one.
    if (!item || item.source.type !== "local") return;
    const e = commandEvent(c, item.source);
    if (e) await this.handle(e);
  }

  /**
   * One app command request, through the comment command path (design §4, app requests): `approve` gets the
   * `/approve` permission check, note scan and transition, with the request's seq on the state change; any other
   * command is refused. A refusal is posted once on the item's source, keyed on the request, then stored on the
   * row by the conditional mark. A failed post leaves the request pending for the next tick. Safe to run twice:
   * a request whose transition is already stored (an earlier try, another replica) is marked applied.
   */
  private async applyAppRequest(r: AppCommandRequest): Promise<void> {
    const known = COMMANDS.some((c) => c.name === r.command);
    const name = r.command === "approve" ? "/approve" : QUOTABLE_COMMAND.test(r.command) ? r.command : null;
    const say = (reason: string) => (name ? `\`${name}\` was not applied: ${reason}.` : `The command was not applied: ${reason}.`);
    const raw = r.args.work_item_id;
    const id = typeof raw === "string" && raw !== "" ? (raw as WorkItemId) : null;
    const item = id ? await this.d.store.getWorkItem(id) : null;
    if (!item) return this.finishAppRequest(r, null, say(id ? "the work item was not found" : "the request names no work item"));
    const applied = async () => (await this.d.store.listStateChanges(item.id)).some((c) => c.detail?.[APP_REQUEST] === r.seq);
    if (await applied()) return this.finishAppRequest(r, item, null);

    let refusal: string | null;
    if (r.command !== "approve") {
      refusal = "only `approve` is applied from an app request" + (known ? `; reply \`/${r.command}\` on the issue instead` : "");
    } else {
      const principal = await this.allowed({ user_id: r.actor, attributes: {} }, "approve_spec", item.id, true);
      if ("refuse" in principal) refusal = principal.refuse;
      else {
        const note = await this.approvalNote(item.id, typeof r.args.note === "string" ? r.args.note : undefined);
        const e: CommandEvent = {
          kind: "spec_approved", source: item.source, comment_id: `app-${r.seq}`, approver: { provider: "local", subject: r.actor },
        };
        refusal = "refuse" in note
          ? note.refuse
          : await this.applyCommand(item.id, e, { kind: "user", id: principal.user_id }, note.note, { [APP_REQUEST]: r.seq });
      }
    }
    // Refused here, but applied by a concurrent try of the same request: that one stands.
    if (refusal !== null && (await applied())) refusal = null;
    await this.finishAppRequest(r, item, refusal === null ? null : say(refusal));
  }

  /** Posts `text` (a refusal) once on the item's source, keyed on the request, then marks the request handled. */
  private async finishAppRequest(r: AppCommandRequest, item: WorkItem | null, text: string | null): Promise<void> {
    if (text !== null) {
      this.d.log.info("app command refused", { request_seq: r.seq, work_item_id: item?.id ?? null, command: r.command.slice(0, 64) });
      if (item) await this.post(item, item.source, text, `<!-- factory:refused:app-${r.seq} -->`);
    }
    await this.d.store.markAppCommandRequest(r.seq, text);
  }

  private async runsStep(): Promise<void> {
    for (const run of await this.d.store.listUnacknowledgedRuns(20)) {
      await this.guard(`run:${run.kind}`, () => this.apply(run));
    }
  }

  /**
   * Re-applies the status of every open item, so items from before status labels existed, and any label
   * write that failed or landed out of order, are corrected on start. Each call is idempotent and guarded.
   */
  async catchUpStatus(): Promise<boolean> {
    // An optional read: with the request budget low it waits for the reset (issue #254); run() asks again each tick.
    if (this.lowBudget()) return false;
    const items = await this.d.store.listWorkItems(CATCH_UP_LIMIT);
    if (items.length >= CATCH_UP_LIMIT) {
      this.d.log.warn("status catch-up hit its limit", { limit: CATCH_UP_LIMIT });
    }
    const open = items.filter((it) => it.stage !== "CLOSED");
    // One batched read of the stored label states: a target already showing its status costs no call at all.
    const stored = await this.d.store.listLabelStates(open.map((it) => it.source.id));
    const shown = new Set(stored.map((l) => `${l.source_id} ${l.target} ${l.status}`));
    for (const it of open) {
      if (this.lowBudget()) return false;
      await this.showStatus(it, (pr) => shown.has(`${it.source.id} ${labelTarget(pr)} ${statusOf(it)}`));
    }
    this.catchUpPending = false;
    return true;
  }

  /** True while any source's request budget is low (GitHub: `lowBudget`): optional reads wait (issue #254). */
  private lowBudget(): boolean {
    return this.sources.some((s) => s.lowBudget?.() === true);
  }

  async tickModelProbe(): Promise<void> {
    await this.live.refresh();
    await this.probeStep();
    await this.outboxStep();
  }

  /**
   * The stall pause's probe (design §5 Restarts): once its probe time has passed, any live controller may probe
   * it, and the store's conditional move of the probe time (`takeStallProbe`) lets one replica ask per due time.
   * One short prompt on the cheap model class through the LLM provider: an answer ends the pause as
   * `endClaimPause("model_stall")` does (`model_answered`), so claims resume; no answer (an error, a refusal, a
   * throw or no reply within stall_ms) keeps it and moves the probe probe_interval_ms after the failed probe.
   * With no LLM provider configured nothing can be asked: the pause ends at its probe time, like a plain pause.
   */
  private async probeStep(): Promise<void> {
    const due = await this.d.store.getClaimPause(MODEL_STALL);
    const interval = this.cfg.probe_interval_ms ?? STALL_DEFAULTS.probe_interval_ms;
    if (due === null || Date.parse(due) > this.d.clock.now().getTime()) return;
    if (!(await this.d.store.takeStallProbe(due, iso(this.d.clock.now().getTime() + interval))).taken) return;
    const answered = this.d.llm ? await this.probe(this.d.llm) : true;
    if (answered) {
      await this.d.store.endClaimPause(MODEL_STALL);
      this.d.log.info(this.d.llm ? "model answered the probe: runs resume" : "no LLM provider to probe: the stall pause ends", {});
      return;
    }
    const next = await this.d.store.pauseClaims(iso(this.d.clock.now().getTime() + interval), MODEL_STALL);
    this.d.log.warn(`model not answering the probe: runs stay paused, next probe at ${next.resume_at}`, { resume_at: next.resume_at });
  }

  /** One short prompt on the cheap model: true when it answered. Carries no work item data. */
  private async probe(llm: LLMProvider): Promise<boolean> {
    try {
      const res = await llm.complete({
        model_class: "cheap",
        messages: [{ role: "user", content: "Reply with the word OK." }],
        max_tokens: 16,
        data_env: "test",
        signal: AbortSignal.timeout(this.cfg.stall_ms ?? STALL_DEFAULTS.stall_ms),
      });
      return res.stop_reason === "end" || res.stop_reason === "max_tokens";
    } catch {
      return false;
    }
  }

  /** One daily improve step (design §7): the current UTC day's improve run, queued once. */
  async tickImprove(): Promise<void> {
    await this.live.refresh();
    await this.improveStep();
  }

  /**
   * Queues the improve run of the current UTC day on the project's system work item. The run's key holds the
   * day, so a second tick, a restart or another replica queues nothing more; `improveDay` only saves this
   * process the store write once the day's run is there.
   */
  private async improveStep(): Promise<void> {
    const day = utcDay(this.d.clock.now());
    if (this.improveDay === day) return;
    const { run, created } = await enqueueImprove(this.d, this.project(), "daily");
    if (created) this.d.log.info("improve run queued", { run_id: run.id, day });
    this.improveDay = day;
  }

  async tickReaper(): Promise<void> {
    await this.live.refresh();
    await this.reaperStep();
    await this.outboxStep();
  }

  private async reaperStep(): Promise<void> {
    const now = this.d.clock.now().getTime();
    const previous = this.lastReaperTick;
    this.lastReaperTick = now;
    if (previous !== null && now - previous > this.cfg.lease_ms) {
      // This process slept (or stalled) longer than a lease: every lease looks expired, including those of
      // workers that slept with us and are about to renew. Give them one heartbeat_ms first.
      this.reaperGraceUntil = now + this.cfg.heartbeat_ms;
      this.d.log.warn("reaper woke after a gap; grace before expiring leases", { gap_ms: now - previous });
    }
    if (now < this.reaperGraceUntil) return;
    const { retry_base_ms, retry_max_ms } = this.cfg;
    // One repository per factory today, so the configured repo's limit applies to every lease.
    const { max_attempts } = this.settings(this.project());
    // An expired lease waits out the same backoff as any retry before another claim (design §5 Restarts).
    // Each attempt the store's conditional update cut off gets its end line (issue #210): the run's last
    // heartbeat is its end. The reaper sees only an expired lease, so the reason is always lease_expired.
    const ids = await this.d.store.expireLeases(
      max_attempts,
      (attempt) => retryDelayMs(attempt, retry_base_ms, retry_max_ms),
      (a) =>
        this.d.log.warn("run abandoned", {
          run_id: a.run_id,
          work_item_id: a.work_item_id,
          attempt: a.attempt,
          status: "abandoned",
          reason: "lease_expired",
          started_at: a.started_at,
          ended_at: a.ended_at,
          duration_ms: a.duration_ms,
        }),
    );
    for (const id of ids) this.d.log.warn("lease expired", { run_id: id });
  }

  // Source events

  /** One source or forge event, then the outbox step, so its replies go out (issue #282). */
  async handleEvent(e: SourceEvent | ForgeEvent): Promise<void> {
    await this.handle(e);
    await this.outboxStep();
  }

  private async handle(e: SourceEvent | ForgeEvent): Promise<void> {
    switch (e.kind) {
      case "item_requested": {
        // A phase of a split spec: the split that filed it takes it in (held or not), never intake.
        if (PHASE_MARKER.test(e.body)) return;
        const principal = await this.authorize(e.requester, "submit_work", e.source.id);
        if ("refuse" in principal) {
          // A source whose intake label is the gate (GitHub) refuses silently. A chat source has no label: the
          // person who asked gets one reply in the thread, keyed on it, so they know why (issue #109).
          if (!this.byType.get(e.source.type)?.silent_intake_refusal) {
            await this.postWithoutItem(e.source, `This thread was not taken in as a work item: ${principal.refuse}.`, `<!-- factory:refused-intake:${e.source.id} -->`);
          }
          return;
        }
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
          // Edges first, so a claim holds the implement run even before the next coordination tick.
          await this.guard("dependencies", async () => void (await this.refreshEdges(item, this.issueTime(e.updated_at))));
        } else if (item.stage !== "CLOSED" && item.pr_number === null) {
          // An edited issue (issue #254): its links are read again only when it changed since they were read.
          await this.guard("dependencies", () => this.relinkIfChanged(item, e.updated_at));
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
      case "pr_changes_requested":
        return this.handlePrReview(e);
      case "pr_merged":
      case "pr_closed":
        return this.prFinished(e);
      case "pr_open":
        return this.prOpen(e);
      case "pr_unmergeable": {
        const id = workItemIdFromBranch(e.head_branch, this.cfg.branch_prefix);
        if (!id) return;
        return this.startUpdate(id as WorkItemId, e.pr_number, e.head_sha, e.base_sha);
      }
    }
  }

  /**
   * One update run per (item, PR, head sha, base sha), from GitHub's unmergeable flag or the local merge check
   * (design §5): both use this key, so either path finding the same conflict first enqueues the only run. None
   * while another update of this item is still in flight; the event repeats on every poll, so a skipped one
   * comes back.
   */
  private async startUpdate(id: WorkItemId, pr_number: number, head_sha: string, base_sha: string): Promise<void> {
    const key = `${id}:update:${pr_number}:${head_sha}:${base_sha}`;
    await this.decide(id, async (it) => {
      if (!awaitingMerge(it) || it.pr_number !== pr_number) return null;
      const updates = (await this.d.store.listRuns(it.id)).filter((r) => r.kind === "update");
      if (updates.some((r) => r.idempotency_key === key || r.acknowledged_at === null)) return null;
      return { patch: {}, actor: SYSTEM, reason: "update_started", enqueue: { kind: "update", idempotency_key: key } };
    });
  }

  /**
   * One local merge check step (design §5 Merge check): every factory PR waiting for a human merge is checked
   * against the newest base, at most once per (head sha, base sha), and a conflict starts the update run at once.
   * Off when the controller has no sandbox that can check. Safe on any replica and safe to repeat.
   */
  async tickMergeCheck(): Promise<void> {
    await this.live.refresh();
    await this.mergeCheckStep();
    await this.outboxStep();
  }

  private async mergeCheckStep(): Promise<void> {
    if (!this.merges) return;
    const waiting = await this.d.store.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "human", limit: MERGE_CHECK_BATCH });
    // Factory branches only: an adopted PR's branch is a person's, which the factory never updates.
    const ready = waiting.filter((it) => awaitingMerge(it) && it.pr_number !== null && it.head_branch === null);
    const { repo, branch_prefix, poll_interval_ms } = this.cfg;
    await this.merges.step(ready, { repo: repo.path, base_ref: repo.base_branch, branch_prefix, poll_interval_ms }, (it, c) => {
      this.d.log.info("merge check conflict", { work_item_id: it.id, files: c.conflicts.length });
      return this.startUpdate(it.id, it.pr_number!, c.head_sha, c.base_sha);
    });
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
    // Items waiting on this one move now, with no other action (design §5, 2026-11-03).
    await this.guard("dependents", () => this.releaseDependents(item.source.id));
  }

  /** A factory branch's item (the decide checks its PR number), else the adopted item with this PR number. Forks have none. */
  private async itemOfFinishedPr(e: PrFinishedEvent): Promise<WorkItem | null> {
    if (e.fork) return null;
    const id = workItemIdFromBranch(e.head_branch, this.cfg.branch_prefix);
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
    const id = workItemIdFromBranch(e.head_branch, this.cfg.branch_prefix);
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
    const forge = this.forge;
    if (e.labels.includes(SKIP_LABEL)) {
      const adder = forge ? await forge.labelAddedBy(e.pr_number, SKIP_LABEL) : null;
      const who = adder ? await this.authorize(adder, "approve_spec", e.source.id) : null;
      if (who && !("refuse" in who)) {
        this.d.log.info("PR skipped: factory: skip label", { ...log, user_id: who.user_id });
        return;
      }
      this.d.log.warn("factory: skip label ignored: not added by a user with write permission; PR adopted", log);
    }
    const files = forge ? await forge.prFiles(e.pr_number) : [];
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
    const author = this.forge ? await this.forge.commitAuthor(sha) : null;
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
    const onPr = (e.kind === "resolve_requested" || e.kind === "revise_requested") && e.pr ? e.pr : null;
    const item = onPr ? await this.itemOfPr(onPr) : await this.d.store.getWorkItemBySource(e.source.type, e.source.id);
    if (!item) return;
    // A `/revise` on the PR of a closed item is ordinary conversation now: no reaction, no reply (design §4).
    if (e.kind === "revise_requested" && onPr && item.stage === "CLOSED") return;
    // /resolve uses the same write-permission check as /approve and /retry; no new AuthAction.
    const who = e.kind === "retry_requested" || e.kind === "revise_requested" || e.kind === "resolve_requested" ? e.requester : e.approver;
    const principal = await this.authorize(who, "approve_spec", item.id);
    let refusal: string | null;
    if ("refuse" in principal) refusal = principal.refuse;
    else {
      // The note is untrusted text bound for the store and agent prompts: G5 before either.
      const input = await this.commandInput(item.id, e);
      refusal = "refuse" in input
        ? input.refuse
        : await this.applyCommand(item.id, e, { kind: "user", id: principal.user_id }, input.note, null, input.paths);
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
    // A /resolve or /revise sent on the PR is answered on the PR; every other command on the item's own issue.
    await this.post(
      item,
      onPr ? e.source : item.source,
      `\`${COMMAND[e.kind]}\` was not applied: ${refusal}.`,
      `<!-- factory:refused:${e.comment_id} -->`,
    );
  }

  /**
   * The work item of a PR: a factory PR's from its head branch, any other PR's adopted item by number; null
   * unless that item's PR is this one.
   */
  private async itemOfPr(pr: { pr_number: number; head_branch: string }): Promise<WorkItem | null> {
    const id = workItemIdFromBranch(pr.head_branch, this.cfg.branch_prefix);
    const it = id
      ? await this.d.store.getWorkItem(id as WorkItemId)
      : await this.d.store.getWorkItemByPr(this.project(), pr.pr_number).then((x) => (x?.origin === "adopted" ? x : null));
    return it && it.pr_number === pr.pr_number ? it : null;
  }

  /**
   * A "Request changes" review on a PR (design §4): its body and line comments are feedback for one implement
   * run, as a `/revise` on the PR is. A PR with no open item, and a reviewer without write permission, get
   * nothing: no change, no reply. A review already applied (a later poll, a restart) changes nothing. A writer's
   * review in a state that cannot take it gets one reply on the PR, keyed on the review.
   */
  private async handlePrReview(e: PrReviewEvent): Promise<void> {
    const item = await this.itemOfPr(e);
    if (!item || item.stage === "CLOSED") return;
    const principal = await this.authorize(e.reviewer, "approve_spec", item.id);
    if ("refuse" in principal) {
      this.d.log.info("review ignored", { work_item_id: item.id, pr_number: e.pr_number, reason: principal.refuse });
      return;
    }
    const actor: Actor = { kind: "user", id: principal.user_id };
    const refusal = await this.decide(item.id, (it) =>
      this.prFeedback(it, { text: reviewFeedback(e), actor, reason: PR_CHANGES, pr_number: e.pr_number, key: { review_id: e.review_id } }));
    if (refusal === null) return;
    this.d.log.info("review refused", { work_item_id: item.id, pr_number: e.pr_number, reason: refusal });
    await this.post(item, e.source, `The review's requested changes were not applied: ${refusal}.`, `<!-- factory:refused:review-${e.review_id} -->`);
  }

  /**
   * Feedback on a PR (design §4): a `/revise` on the PR or a "Request changes" review. Accepted while the PR
   * waits for a human merge or its review run failed: the item goes to RUNNING with one implement run on its
   * branch, keyed on the next loop (loop_count + 1), with the feedback as its input and on the state change.
   * At the loop limit the item blocks on a human with `max_loops` and starts nothing. `key` (the comment or the
   * review id) is recorded on the state change, so the same feedback delivered again changes nothing.
   */
  private async prFeedback(
    it: WorkItem,
    f: { text: string; actor: Actor; reason: string; pr_number: number; key: { comment_id: string } | { review_id: string } },
  ): Promise<Decision | Refusal> {
    if (it.stage === "CLOSED" || it.pr_number !== f.pr_number) return null;
    const [field, value] = Object.entries(f.key)[0] as [string, string];
    const done = (await this.d.store.listStateChanges(it.id)).some(
      (c) => (c.reason === f.reason || c.reason === "max_loops") && c.detail?.[field] === value);
    if (done) return null;
    const phase = commandPhase(it);
    const accepted = commandSpec("revise").pr_phases ?? [];
    if (!accepted.includes(phase)) {
      return {
        refuse: `the item is ${phaseLabel(phase)}; feedback on the PR is taken only when it is ` +
          accepted.map((p) => phaseLabel(p)).join(" or "),
      };
    }
    const feedback = f.text.trim();
    if (!feedback) return { refuse: "it needs feedback after the command, e.g. `/revise keep the existing CLI flag`" };
    const scan = await this.d.scanner.scan("comment", feedback);
    if (!scan.clean) {
      const rules = scan.findings.map((x) => x.rule).join(",");
      this.d.log.warn("PR feedback blocked by the egress scan", { work_item_id: it.id, rules });
      return { refuse: `the feedback was blocked by the leak scanner (\`${rules}\`), so it was not stored and nothing changed` };
    }
    const kept = feedback.slice(0, MAX_FEEDBACK_CHARS).trim();
    const detail = { ...f.key, pr_number: f.pr_number };
    const limit = this.cfg.max_loops;
    if (it.loop_count + 1 >= limit) {
      const patch = { blocked_on: "human" as const, blocked_reason: "max_loops" };
      await this.comment(it, `max-loops:${field}-${value}`, [
        `The PR feedback would start loop ${it.loop_count + 1} (limit \`max_loops\` = ${limit}), so the factory started no implement run. A human needs to decide.`,
        "",
        footerAfter(it, patch),
      ].join("\n"));
      return { patch, actor: f.actor, reason: "max_loops", detail };
    }
    const next = { ...it, loop_count: it.loop_count + 1 };
    return {
      patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null, loop_count: next.loop_count, failure_comment_url: null },
      actor: f.actor,
      reason: f.reason,
      detail: { ...detail, feedback: kept },
      enqueue: { kind: "implement", idempotency_key: runKey(next, "implement"), input: { notes: kept } },
    };
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
    tag: StateChangeDetail | null = null,
    paths: readonly string[] = [],
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
      // `/approve` while implementing: lifts a coordination-cost hold on the queued implement run (design §5).
      if (e.kind === "spec_approved" && it.stage === "RUNNING" && it.blocked_on === "none") {
        // The held run is already queued with its paths; `+paths` does not change them (issue #280).
        if (paths.length > 0) return "`+paths` does not apply to an implement run held by coordination cost, since that run is already queued; reply `/approve` without `+paths`";
        const r = await this.approveHold(it, actor);
        if (r === RETRY) continue;
        return r;
      }
      if (e.kind === "retry_requested" && commandPhase(it) === "dependency_closed") return this.retryDependencies(it, actor, note, paths);
      return this.decide(id, async (x) =>
        withTag(await this.withSpecDecision(x, await this.command(e, x, actor, await this.floorTierNeeded(x), note, tag, paths)), tag));
    }
    this.d.log.warn("command gave up after conflicts", { work_item_id: id, command: e.kind });
    return null;
  }

  /**
   * A spec decision (approve, reject, revise) gets the standing-approval detail (design 05-standing-approvals):
   * gate, tier, kind, outcome, whether the spec changed, and the deciding user's ID. Any other decision as it is.
   */
  private async withSpecDecision(it: WorkItem, d: Decision | Refusal): Promise<Decision | Refusal> {
    if (!d || "refuse" in d) return d;
    const outcome = SPEC_DECISIONS[d.reason];
    if (!outcome) return d;
    const kind = specKind(it, it.parent_id === null && (await this.specPhases(it)) !== null);
    const gate = specDecisionDetail({ tier: it.tier, kind, outcome, spec_changed: specChanged(outcome, d.patch), actor: d.actor });
    return { ...d, detail: { ...d.detail, ...gate } };
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
        // Like a spec reject, the comment and the issue close follow (finishReject), so the close says why.
        patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "upstream", blocked_reason: SOURCE_CLOSE_PENDING },
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
        const closesPr = it.pr_number !== null && this.forge !== null;
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
    const forge = this.forge;
    if (!forge) return;
    try {
      const r = await forge.closePr({
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

  /**
   * The approval note to store: trimmed, capped at MAX_NOTE_CHARS, null when empty. The whole note is
   * egress-scanned first; a finding refuses the approval, and neither the note nor the rule's match is kept.
   */
  private async approvalNote(id: WorkItemId, raw: string | undefined, command = "/approve"): Promise<{ note: string | null } | Refusal> {
    const text = (raw ?? "").trim();
    if (!text) return { note: null };
    const scan = await this.d.scanner.scan("comment", text);
    if (!scan.clean) {
      const rules = scan.findings.map((f) => f.rule).join(",");
      this.d.log.warn("command note blocked by the egress scan; command refused", { work_item_id: id, command, rules });
      return {
        refuse: `the note was blocked by the leak scanner (\`${rules}\`), so it was not stored and nothing changed; post \`${command}\` again without the secret`,
      };
    }
    return { note: text.slice(0, MAX_NOTE_CHARS).trim() };
  }

  /**
   * The note and the `+paths` of an `/approve` or `/retry` (design §4, issue #280); none for other commands. The
   * whole text is egress-scanned first (so a refusal never quotes a flagged path), then `+paths` is split off
   * and checked; the note is what is left, capped. A finding or a bad path refuses the command.
   */
  private async commandInput(id: WorkItemId, e: CommandEvent): Promise<{ note: string | null; paths: string[] } | Refusal> {
    if (e.kind !== "spec_approved" && e.kind !== "retry_requested") return { note: null, paths: [] };
    const scanned = await this.approvalNote(id, e.note, COMMAND[e.kind]);
    if ("refuse" in scanned) return scanned;
    const split = parseCommandPaths(e.note ?? "");
    if ("refuse" in split) return split;
    const note = split.note.slice(0, MAX_NOTE_CHARS).trim();
    return { note: note || null, paths: split.paths };
  }

  /**
   * The allowed paths a `+paths` widens to (issue #280): the paths no allowed path covers yet, added once each,
   * and a tier raised to the highest floor they touch, as triage does; never lowered. No new path: no change.
   */
  private widen(it: WorkItem, paths: readonly string[]): Widening {
    const added = [...new Set(paths)].filter((p) => !isCovered(p, it.allowed_paths));
    if (added.length === 0) return NO_WIDENING;
    const floor = floorTier(added, this.settings(it.project).floors);
    const raised = floor !== null && (it.tier === null || floor > it.tier) ? { tier: floor } : {};
    return { patch: { allowed_paths: [...it.allowed_paths, ...added], ...raised }, detail: { added_paths: JSON.stringify(added) } };
  }

  /**
   * `/help` or an unknown command on a work item: 👀, then one reply keyed on the comment id, listing the
   * commands for the item's current state. Like other commands, ignored entirely on an issue that is not one.
   */
  private async handleInfo(e: InfoEvent): Promise<void> {
    const item = await this.d.store.getWorkItemBySource(e.source.type, e.source.id);
    if (!item) return;
    await this.markSeen(e.source, e.comment_id);
    const state = await this.stateOf(item);
    const help = e.kind === "help_requested";
    await this.post(
      item,
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
    const code = parseLink(e.body);
    if (code !== null) return this.handleLink(e, code);
    const llm = this.d.llm;
    if (!llm) return;
    const item = await this.d.store.getWorkItemBySource(e.source.type, e.source.id);
    if (!item) return;
    const principal = await this.authorize(e.author, "approve_spec", item.id);
    if ("refuse" in principal) return;
    const text = e.body.trim();
    if (text === "" || text.length > SUGGEST_MAX_CHARS || item.stage === "CLOSED") return;
    const state = await this.stateOf(item);
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
    await this.post(item, item.source, body, `<!-- factory:suggest:${e.comment_id} -->`);
  }

  /**
   * `/link <code>` (design 2026-11-01): links the commenter's account to the code's factory user. On any issue,
   * work item or not. One reply keyed on the comment id; the code is never logged or echoed. A wrong code is a
   * failed attempt (the store counts it) and links nothing. A redelivery of a used code reports the same link.
   */
  private async handleLink(e: PlainCommentEvent, code: string): Promise<void> {
    const account = { provider: e.author.provider, subject: e.author.subject };
    const r = code === "" ? ({ ok: false, reason: "invalid" } as const) : await this.d.store.redeemLinkCode(code, account);
    await this.markSeen(e.source, e.comment_id);
    this.d.log.info("link attempt", { provider: account.provider, ok: r.ok, ...(r.ok ? { user_id: r.user_id } : { reason: r.reason }) });
    const body = r.ok
      ? `This account is now linked to factory user \`${r.user_id}\`. Commands from it act as that user.`
      : `This account was not linked: ${LINK_REFUSALS[r.reason]}. Ask for a new code with \`factory link-code <user_id>\`.`;
    const item = await this.d.store.getWorkItemBySource(e.source.type, e.source.id);
    if (item) await this.post(item, e.source, body, `<!-- factory:link:${e.comment_id} -->`);
    else await this.postWithoutItem(e.source, body, `<!-- factory:link:${e.comment_id} -->`);
  }

  /**
   * A reply on a source that is no work item (a `/link` on a plain issue, a refused chat intake) has no thread to
   * hold it: the only posts that skip the outbox and go to the source directly.
   */
  private async postWithoutItem(source: SourceRef, body: string, marker: string): Promise<void> {
    await this.adapterFor(source, "postComment")?.postComment(source, body, marker);
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
      item,
      item.source,
      `\`/verdict\` was not applied: ${refusal}.`,
      `<!-- factory:refused:${e.comment_id} -->`,
    );
  }

  /** The work item a verdict names: by issue, or by the PR's head branch when that PR is the item's. */
  private async verdictItem(e: VerdictEvent): Promise<WorkItem | null> {
    if (e.target.kind === "issue") return this.d.store.getWorkItemBySource(e.target.source.type, e.target.source.id);
    const id = workItemIdFromBranch(e.target.head_branch, this.cfg.branch_prefix);
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
    tag: StateChangeDetail | null = null,
    paths: readonly string[] = [],
  ): Promise<Decision | Refusal> {
    if (e.kind === "resolve_requested") return resolveCommand(e, it, actor, (await this.askedBy(it)) === "resolve");
    if (e.kind === "revise_requested" && e.pr) {
      return this.prFeedback(it, { text: e.feedback, actor, reason: PR_REVISE, pr_number: e.pr.pr_number, key: { comment_id: e.comment_id } });
    }
    if (it.stage === "CLOSED") return { refuse: "the work item is closed" };
    if (it.blocked_reason === BUDGET_CHECKPOINT) {
      return { refuse: "the item is at a budget checkpoint; reply `/budget`, `/budget <tokens>` or `/reject <reason>`" };
    }
    if (it.blocked_reason === FLOOR_TIER) return floorCommand(e, it, actor, floorNeed, note, this.widen(it, paths));
    if (e.kind === "retry_requested") return retry(it, actor, await this.retryKind(it), note, paths.length > 0 ? this.widen(it, paths) : null);
    if (e.kind === "spec_approved" && (splitFiling(it) || splitOpen(it))) {
      // The same `/approve` delivered again (a second poll, another replica): the pass that claimed the filing answers it.
      if ((await this.splitClaim(it.id))?.detail?.comment_id === e.comment_id) return null;
      if (splitFiling(it) && paths.length > 0) return { refuse: SPLIT_PATHS };
      if (splitFiling(it)) {
        const stale = this.d.clock.now().getTime() - Date.parse(it.updated_at) >= SPLIT_FILING_STALE_MS;
        const phases = stale ? await this.specPhases(it) : null;
        if (phases) return this.approveSplit(it, phases, actor, note, e.comment_id, tag);
        return { refuse: "an earlier `/approve` is filing this split's phases; if it stopped, reply `/approve` again in 10 minutes" };
      }
    }
    if (e.kind === "spec_approved" && it.blocked_on === "dependency") {
      return {
        refuse: `the item is ${phaseLabel("dependency_hold")} (${it.blocked_reason ?? "a dependency"}), and \`/approve\` does not lift a ` +
          "dependency hold: the implement run starts on its own once the dependency merges",
      };
    }
    const phase = commandPhase(it);
    const afterFailure = phase === "too_large" || phase === "failed_implement" || phase === "agent_needs_human" || phase === "repeated_failure";
    if (afterFailure && e.kind === "revise_requested") return this.reviseAfterFailure(e, it, actor);
    if (!awaitingSpec(it) && !(afterFailure && e.kind === "spec_rejected")) {
      const onPr = e.kind === "revise_requested" && it.pr_number !== null && commandSpec("revise").pr_phases?.includes(phase)
        ? `; to send feedback to the implementer, reply \`/revise <feedback>\` on PR #${it.pr_number}`
        : "";
      return { refuse: `the spec is not waiting for approval (the item is ${phaseLabel(phase)})${onPr}` };
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
        const limit = this.cfg.max_loops;
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
      case "spec_approved": {
        const phases = await this.specPhases(it);
        if (phases && paths.length > 0) return { refuse: SPLIT_PATHS };
        if (phases) return this.approveSplit(it, phases, actor, note, e.comment_id, tag);
        const w = this.widen(it, paths);
        const detail = { ...(note ? { note } : {}), ...w.detail };
        return {
          patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null, ...w.patch },
          actor,
          reason: "spec_approved",
          ...(Object.keys(detail).length > 0 ? { detail } : {}),
          enqueue: { kind: "implement", idempotency_key: runKey(it, "implement") },
        };
      }
    }
  }

  /**
   * phases_auto_approve: a phase of a split whose parent the owner approved (its phases are open) needs no
   * `/approve` of its own. Off, not a phase, or a parent that is gone or no longer waiting on its phases: false.
   */
  private async approvedByParent(it: WorkItem): Promise<boolean> {
    if (this.cfg.phases_auto_approve !== true || it.parent_id === null) return false;
    const parent = await this.d.store.getWorkItem(it.parent_id);
    return parent !== null && splitOpen(parent);
  }

  /** The phases of the spec waiting at the gate: those of the latest succeeded triage run, or null for no split. */
  private async specPhases(it: WorkItem): Promise<TriagePhase[] | null> {
    const run = (await this.d.store.listRuns(it.id))
      .filter((r) => r.kind === "triage" && r.outcome?.status === "succeeded" && r.acknowledged_at !== null)
      .at(-1);
    if (run?.outcome?.status !== "succeeded") return null;
    const parsed = parseTriage(run.outcome.data.spec);
    return parsed.ok && parsed.value.phases ? parsed.value.phases : null;
  }

  /**
   * `/approve` on a split spec (design 2026-11-01): one sub-issue per phase, in order, each with the intake label
   * and linked to the parent, and one work item per phase, requested by the approver. The first phase is queued
   * for triage; each later one starts held (`phase_hold`) until the phase before it closes as completed
   * (tickPhases). The approval first claims the filing with a conditional transition to `split_filing`, so of
   * two passes at once (two replicas, an old process still draining) only one files (2026-11-07). A phase that
   * already has a work item under this parent is not filed again; the rest are filed by marker (the parent's
   * sub-issues, then the newest labelled issues) and taken in keyed on the source. A failure refuses the
   * approval and puts the spec back at the gate, so `/approve` again files the rest. On success the parent
   * waits on its phases (`phases_open`); it is never implemented itself. Returns null once applied: the
   * transitions are its own, conditional on the claim.
   */
  private async approveSplit(
    it: WorkItem,
    phases: TriagePhase[],
    actor: Actor,
    note: string | null,
    commentId: string,
    tag: StateChangeDetail | null,
  ): Promise<Decision | Refusal> {
    const adapter = this.adapterFor(it.source, "fileSubIssue");
    if (!adapter?.fileSubIssue) {
      return { refuse: "this source cannot file sub-issues, so a split spec cannot be approved here; reply `/revise <feedback>` to get a spec without phases" };
    }
    const claim = await this.d.store.transition({
      id: it.id,
      expected_version: it.version,
      patch: { blocked_on: "upstream", blocked_reason: SPLIT_FILING },
      actor,
      reason: SPLIT_FILING,
      detail: { phases: phases.length, comment_id: commentId },
    });
    if (!claim.ok) {
      if (claim.reason !== "version_conflict") return null;
      // Another pass claimed it first: the same command is answered by that pass, another one is refused.
      const cur = claim.current;
      if (!splitFiling(cur) && !splitOpen(cur)) return { refuse: "the item changed while the approval was applied; reply `/approve` again" };
      if ((await this.splitClaim(it.id))?.detail?.comment_id === commentId) return null;
      return { refuse: "another `/approve` already approved this split" };
    }
    const requester = actor.kind === "user" ? actor.id : it.requester_id;
    const known = new Map((await this.d.store.listPhases(it.id)).map((p) => [p.phase, p.source]));
    const refs: SourceRef[] = [];
    try {
      for (const [i, phase] of phases.entries()) {
        const index = i + 1;
        const prev = refs[i - 1] ?? null;
        const title = phaseTitle(index, phases.length, phase.title);
        const body = phaseIssueBody({ parent: it.source, phase, index, total: phases.length, depends_on: prev });
        const ref = known.get(index) ?? await adapter.fileSubIssue({ parent: it.source, title, body, marker: phaseMarker(it.id, index) });
        const { item, created } = await this.d.store.createWorkItem(
          {
            source: ref,
            title,
            requester_id: requester,
            project: it.project,
            problem: `${title}\n\n${body}`,
            resources: [ref.link, it.source.link],
            parent: { id: it.id, phase: index },
            ...(prev ? { hold: { blocked_on: "upstream" as const, blocked_reason: PHASE_HOLD } } : {}),
          },
          actor,
          {
            detail: phaseLinkDetail({ parent_work_item_id: it.id, phase: index, phases: phases.length, depends_on: prev?.id ?? null }),
            // The intake key, so a later delivery of the same issue is a no-op.
            ...(prev ? {} : { enqueue: { kind: "triage" as const, idempotency_key: `${ref.type}:${ref.id}:triage` } }),
          },
        );
        refs.push(ref);
        if (created) {
          this.d.log.info("phase filed", { work_item_id: item.id, parent_work_item_id: it.id, phase: index, held: prev !== null });
          await this.showStatus(item);
        }
      }
    } catch (err) {
      this.d.log.warn("filing split phases failed; /approve again files the rest", {
        work_item_id: it.id,
        filed: refs.length,
        phases: phases.length,
        error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
      });
      // Back at the gate, so `/approve` again is accepted at once.
      const back = splitFiling(it)
        ? { blocked_on: "human" as const, blocked_reason: "spec_pending" }
        : { blocked_on: it.blocked_on, blocked_reason: it.blocked_reason };
      await this.settleSplit(claim.item, { patch: back, actor, reason: "split_filing_failed", detail: { filed: refs.length, phases: phases.length } });
      return {
        refuse: `filing the phase sub-issues stopped after ${refs.length} of ${phases.length}; reply \`/approve\` again to file the rest (none is filed twice)`,
      };
    }
    const patch = { blocked_on: "upstream" as const, blocked_reason: PHASES_OPEN };
    await this.comment(it, `split:${it.id}`, [
      `The split spec was approved, so the factory filed ${phases.length} phases as sub-issues of this issue:`,
      "",
      ...refs.map((r, i) => `${i + 1}. ${r.link}${i === 0 ? " (starts now)" : " (waits for the phase before it)"}`),
      "",
      this.cfg.phases_auto_approve === true
        ? "Each phase gets its own spec, approved by this `/approve` (`phases_auto_approve`), so it is implemented without asking again. This issue closes as completed when the last phase does."
        : "Each phase gets its own spec and its own `/approve`. This issue closes as completed when the last phase does.",
      "",
      footerAfter(it, patch),
    ].join("\n"));
    await this.settleSplit(claim.item, {
      patch,
      actor,
      reason: SPLIT_APPROVED,
      detail: {
        phases: phases.length,
        sub_issues: JSON.stringify(refs.map((r) => r.id)),
        ...(note ? { note } : {}),
        ...specDecisionDetail({ tier: it.tier, kind: "split", outcome: "approved", spec_changed: false, actor }),
        ...tag,
      },
    });
    return null;
  }

  /** The claim's end (`split_approved` or `split_filing_failed`), conditional on the claim being the item's last change. */
  private async settleSplit(claimed: WorkItem, d: NonNullable<Decision>): Promise<void> {
    const r = await this.d.store.transition({ ...d, id: claimed.id, expected_version: claimed.version });
    if (!r.ok) {
      this.d.log.warn("split claim changed before it settled", { work_item_id: claimed.id, reason: d.reason, conflict: r.reason });
      return;
    }
    this.d.log.info("transition", { work_item_id: claimed.id, reason: d.reason, version: r.item.version });
    await this.showStatus(r.item);
  }

  /** The parent's latest `split_filing` claim, whose detail names the command that made it. */
  private async splitClaim(id: WorkItemId): Promise<StateChange | null> {
    return (await this.d.store.listStateChanges(id)).filter((c) => c.reason === SPLIT_FILING).at(-1) ?? null;
  }

  /**
   * Moves split specs along (design 2026-11-01). A held phase whose previous phase is CLOSED / completed is
   * released into triage. A split parent whose phases are all CLOSED / completed gets one comment, is closed as
   * completed on its source, then CLOSED / completed in the store. A phase closed any other way keeps the next
   * phase held and the parent open. Safe on any replica and safe to repeat: every step re-reads the store, the
   * comment is keyed, closing a closed issue changes nothing, and each transition is conditional.
   */
  async tickPhases(): Promise<void> {
    await this.live.refresh();
    const held = await this.d.store.listWorkItemsWhere({ stage: "NEW", blocked_on: "upstream", limit: PHASE_BATCH });
    for (const h of held) if (phaseHeld(h)) await this.guard("phase release", () => this.releasePhase(h.id));
    const parents = await this.d.store.listWorkItemsWhere({ stage: "READY", blocked_on: "upstream", limit: PHASE_BATCH });
    for (const p of parents) if (splitOpen(p)) await this.guard("split close", () => this.closeSplitIfDone(p.id));
    if (this.cfg.phases_auto_approve !== true) return;
    // A phase spec that waited at the gate before phases_auto_approve was turned on.
    const waiting = await this.d.store.listWorkItemsWhere({ stage: "READY", blocked_on: "human", limit: PHASE_BATCH });
    for (const w of waiting) if (phaseSpecPending(w)) await this.guard("phase approve", () => this.approvePhaseSpec(w.id));
  }

  /** phases_auto_approve on a phase spec already waiting at the gate: approved as the parent's /approve covers it. */
  private async approvePhaseSpec(id: WorkItemId): Promise<void> {
    const it = await this.d.store.getWorkItem(id);
    if (!it || !phaseSpecPending(it) || !(await this.approvedByParent(it))) return;
    // A phase whose own triage proposed phases still waits for a human: that /approve files issues.
    if (await this.specPhases(it)) return;
    await this.decide(id, (cur) =>
      phaseSpecPending(cur)
        ? {
            patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null },
            actor: SYSTEM,
            reason: "phase_spec_auto_approved",
            detail: { parent_work_item_id: cur.parent_id! },
            enqueue: { kind: "implement", idempotency_key: runKey(cur, "implement") },
          }
        : null,
    );
  }

  /** Releases held phase `id` once the phase before it (by the store's parent link and phase number) closed as completed. */
  private async releasePhase(id: WorkItemId): Promise<void> {
    const it = await this.d.store.getWorkItem(id);
    if (!it || !phaseHeld(it)) return;
    if (it.parent_id === null || it.phase === null) {
      this.d.log.warn("held phase has no parent link; left held", { work_item_id: id });
      return;
    }
    const parentId = it.parent_id;
    const phase = it.phase;
    const prev = phase > 1 ? (await this.recordedPhases(parentId)).find((p) => p.phase === phase - 1) : null;
    if (phase > 1 && !completed(prev)) return;
    await this.decide(id, (cur) =>
      phaseHeld(cur)
        ? {
            patch: { blocked_on: "none", blocked_reason: null },
            actor: SYSTEM,
            reason: "phase_released",
            detail: { parent_work_item_id: parentId, phase, depends_on: prev?.source.id ?? null },
            enqueue: { kind: "triage", idempotency_key: `${cur.source.type}:${cur.source.id}:triage` },
          }
        : null,
    );
  }

  /**
   * The parent's phases, only those its approval recorded (`sub_issues` of its last split_approved). Another
   * work item linked to the parent (a duplicate sub-issue a racing approval filed, then closed by hand) neither
   * holds the next phase nor keeps the parent open. With no recorded list, every linked phase counts.
   */
  private async recordedPhases(parentId: WorkItemId): Promise<WorkItem[]> {
    const phases = await this.d.store.listPhases(parentId);
    const approved = (await this.d.store.listStateChanges(parentId)).filter((c) => c.reason === SPLIT_APPROVED).at(-1);
    const ids = parseSubIssues(approved?.detail);
    return ids ? phases.filter((p) => ids.includes(p.source.id)) : phases;
  }

  private async closeSplitIfDone(id: WorkItemId): Promise<void> {
    const it = await this.d.store.getWorkItem(id);
    if (!it || !splitOpen(it)) return;
    // How many phases the approval filed: the store's phase rows must all exist and all be closed as completed.
    const approved = (await this.d.store.listStateChanges(id)).filter((c) => c.reason === SPLIT_APPROVED).at(-1);
    const ids = parseSubIssues(approved?.detail);
    if (!ids) return;
    const phases = await this.recordedPhases(id);
    if (phases.length < ids.length || !phases.every(completed)) return;
    const adapter = this.adapterFor(it.source, "closeIssue");
    if (!adapter) return;
    await this.comment(it, `split-done:${it.id}`,
      `Closed because all ${ids.length} phases of this split were closed as completed.`);
    await adapter.closeIssue(it.source, "completed");
    await this.decide(id, (cur) =>
      splitOpen(cur)
        ? {
            patch: { stage: "CLOSED", close_reason: "completed", blocked_on: "none", blocked_reason: null },
            actor: SYSTEM,
            reason: "split_completed",
            detail: { phases: ids.length },
          }
        : null,
    );
    // Its dependents count it merged now that its phases are (design §5).
    await this.guard("dependents", () => this.releaseDependents(it.source.id));
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
    const limit = this.cfg.max_loops;
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
    const budget = (await this.d.store.listStateChanges(id)).filter((c) => c.reason === "spec_rejected" || c.reason === "budget_rejected").at(-1)
      ?.reason === "budget_rejected";
    const reason = budget ? "" : (it.spec_feedback?.trim() ?? "");
    const body = budget
      ? "Closed because the work was stopped at its token budget checkpoint (`/reject`). The factory closed this issue as not planned."
      : reason
        ? ["Closed because the spec was rejected. The factory closed this issue as not planned. The reason given:", "", quote(reason)].join("\n")
        : "Closed because the spec was rejected (no reason given). The factory closed this issue as not planned.";
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
    return this.cfg.project.key;
  }

  /** The per-project gate settings of `project` (design 2026-11-01): the only way core reads them. */
  private settings(project: string): ProjectSettings {
    return settingValues(project, this.cfg.settings, this.d.learned);
  }

  /**
   * `/approve` on an implementing item (design §5, 2026-11-03): its queued implement run's latest claim decision
   * is `held` by coordination cost, so the approval is recorded (state change `coordination_approved`, the
   * approver as actor) and the next claim takes the run. Without such a hold it is refused as before.
   */
  private async approveHold(it: WorkItem, actor: Extract<Actor, { kind: "user" }>): Promise<string | null | typeof RETRY> {
    const queued = new Set((await this.d.store.listRuns(it.id)).filter((r) => r.kind === "implement" && r.status === "queued").map((r) => r.id));
    const held = (await this.d.store.listClaimDecisions(it.id))
      .filter((d) => d.decision === "held" && d.approved_by === null && queued.has(d.run_id))
      .at(-1);
    if (!held) {
      return `the spec is not waiting for approval and no implement run is held by coordination cost (the item is ${phaseLabel(commandPhase(it))})`;
    }
    const r = await this.d.store.approveClaimHold({ id: it.id, expected_version: it.version, actor, run_id: held.run_id });
    if (r.ok) {
      this.d.log.info("transition", { work_item_id: it.id, reason: "coordination_approved", version: r.item.version, run_id: held.run_id });
      return null;
    }
    if (r.reason === "version_conflict") return RETRY;
    return r.reason === "not_held" ? "the implement run is no longer held by coordination cost" : null;
  }

  // Coordination (design §5, decided 2026-11-03)

  /**
   * Once per poll: for each item with a queued implement run and each item held by a dependency, apply its stored
   * dependency edges and their states (links re-read from the forge only when never read with a time, outside
   * states at most once per DEPENDENCY_STATE_TTL_MS), then hold, release or block it; and post one comment per coordination-cost hold the claim recorded. All outside the claim lock: the claim reads only the
   * store. Safe on any replica and safe to repeat (conditional transitions, comments keyed by marker).
   */
  async tickCoordination(): Promise<void> {
    await this.live.refresh();
    await this.coordinationStep();
    await this.outboxStep();
  }

  private async coordinationStep(): Promise<void> {
    const queued = (await this.d.store.listRunsByStatus(["queued"], COORDINATION_BATCH * 4))
      .filter((r) => r.kind === "implement")
      .slice(0, COORDINATION_BATCH);
    const held = await this.d.store.listWorkItemsWhere({ blocked_on: "dependency", limit: COORDINATION_BATCH });
    const ids = [...new Set([...queued.map((r) => r.work_item_id), ...held.map((i) => i.id)])];
    for (const id of ids) {
      await this.guard("coordination item", async () => {
        await this.coordinateItem(id, true);
        await this.holdComment(id);
      });
    }
  }

  /**
   * Reads the item's edges (from its source when `network` and they were never read with a time, else the stored
   * ones), records each edge's state, and applies what they mean: hold on `blocked_on: dependency`,
   * release, or block on a human for a dependency closed unmerged or a cycle (queued runs cancelled, one comment).
   * Only an implementing item without a PR is changed. A forge that fails changes nothing: stored edges apply.
   */
  private async coordinateItem(id: WorkItemId, network: boolean): Promise<void> {
    const it = await this.d.store.getWorkItem(id);
    if (!it || it.stage !== "RUNNING" || it.pr_number !== null) return;
    if (it.blocked_on !== "none" && it.blocked_on !== "dependency") return;
    await this.applyDependencies(it.id, await this.readDependencies(it, network ? "due" : "stored"));
  }

  /**
   * The item's dependency verdict after its edges and their states are read and stored: `stored` reads only the
   * store; `due` also reads the forge for links never read with a time (none within DEPENDENCY_STATE_TTL_MS of a
   * failed read) and for outside states past DEPENDENCY_STATE_TTL_MS, both skipped under a low request budget (issue #254); `now` reads the forge whatever
   * the cache (a human `/retry`, one read per edge).
   */
  private async readDependencies(it: WorkItem, read: "stored" | "due" | "now"): Promise<DependencyVerdict> {
    const relink = read === "now"
      || (read === "due" && !this.linkReadFailedRecently(it.id) && (await this.d.store.dependencyLinksReadAt(it.id)) === null && !this.lowBudget());
    const edges = relink
      ? await this.refreshEdges(it, iso(this.d.clock.now().getTime()))
      : await this.d.store.listDependencyEdges({ work_item_id: it.id });
    for (const e of edges) {
      if (read === "now") this.dependencyStates.delete(e.depends_on);
      const state = await this.dependencyStateOf(it.source.type, e.depends_on, read !== "stored");
      if (state !== null && state !== e.state) await this.d.store.setDependencyState(it.id, e.depends_on, state);
    }
    const fresh = await this.d.store.listDependencyEdges({ work_item_id: it.id });
    return dependencyVerdict(it.source.id, fresh, await this.dependencyGraph());
  }

  /**
   * `/retry` at `dependency_closed` (design §5, 2026-11-07): the dependencies are read again now. None closed
   * unmerged and no cycle: the block is lifted with a new implement run (the block cancelled the old one), the
   * human as actor, then a dependency still open holds it as usual. Else refused, naming what still blocks.
   */
  private async retryDependencies(
    it: WorkItem, actor: Extract<Actor, { kind: "user" }>, note: string | null, paths: readonly string[],
  ): Promise<string | null> {
    if (paths.length > 0) return "`+paths` applies only to a failed implement run; reply `/retry` without `+paths`";
    const v = await this.readDependencies(it, "now");
    const short = (d: string) => shortRef(d, it.source.id);
    if (v.kind === "closed") {
      return `${short(v.dependency)} is still closed without a merge; reply \`/retry\` once it is merged or the link to it is removed`;
    }
    if (v.kind === "cycle") return `the dependencies form a cycle: ${v.cycle.map(short).join(" → ")}; remove one of the links, then reply \`/retry\``;
    const blockedReason = it.blocked_reason;
    const refusal = await this.decide(it.id, (cur) => {
      if (cur.stage !== "RUNNING" || cur.pr_number !== null || cur.blocked_on !== "human" || cur.blocked_reason !== blockedReason) return null;
      const next = { ...cur, restart_count: cur.restart_count + 1 };
      return {
        patch: { blocked_on: "none", blocked_reason: null, restart_count: next.restart_count },
        actor,
        reason: "retry_requested",
        detail: { released: blockedReason ?? DEPENDENCY_CLOSED, ...(note ? { note } : {}) },
        enqueue: { kind: "implement", idempotency_key: runKey(next, "implement") },
      };
    });
    if (refusal === null && v.kind === "wait") await this.applyDependencies(it.id, v);
    return refusal;
  }

  /**
   * The item's edges from its source (`Depends on` lines, sub-issues, blocked-by links), stored with `read_at`, the
   * issue's updated_at they were read at; else (no such source, or the source failed: logged, and the links
   * marked stale so a coordination pass reads them again once DEPENDENCY_STATE_TTL_MS has passed) the stored ones.
   */
  private async refreshEdges(it: WorkItem, read_at: Timestamp): Promise<Awaited<ReturnType<FactoryStore["listDependencyEdges"]>>> {
    const adapter = this.byType.get(it.source.type);
    if (!adapter || !isDependencySource(adapter)) return this.d.store.listDependencyEdges({ work_item_id: it.id });
    let links: DependencyLink[];
    try {
      links = (await adapter.dependencyLinks(it.source)).filter((l) => l.depends_on !== it.source.id);
    } catch (err) {
      this.d.log.warn("dependency links not read: stored edges apply", { work_item_id: it.id, error: (err as Error).message });
      this.linkFailures.set(it.id, this.d.clock.now().getTime());
      await this.d.store.markDependencyLinksStale(it.id);
      return this.d.store.listDependencyEdges({ work_item_id: it.id });
    }
    this.linkFailures.delete(it.id);
    return this.d.store.replaceDependencyEdges(it.id, links, read_at);
  }

  /** Whether the item's links failed to read less than DEPENDENCY_STATE_TTL_MS ago; older failures are dropped. */
  private linkReadFailedRecently(id: WorkItemId): boolean {
    const now = this.d.clock.now().getTime();
    for (const [k, at] of this.linkFailures) if (now - at >= DEPENDENCY_STATE_TTL_MS) this.linkFailures.delete(k);
    return this.linkFailures.has(id);
  }

  /**
   * One fresh read of an existing item's links when the issue's `updated_at` moved past the time they were read at
   * (or they never were with a time, whatever the delivery's `updated_at`); nothing when it did not. A failed read marks them stale (refreshEdges), so
   * a coordination pass DEPENDENCY_STATE_TTL_MS later reads them again instead of waiting for another edit.
   */
  private async relinkIfChanged(it: WorkItem, updated_at: string | undefined): Promise<void> {
    const adapter = this.byType.get(it.source.type);
    if (!adapter || !isDependencySource(adapter)) return;
    const readAt = await this.d.store.dependencyLinksReadAt(it.id);
    // NaN (no or a bad updated_at) is never newer: only links never read with a time are read then.
    if (readAt !== null && !(Date.parse(updated_at ?? "") > Date.parse(readAt))) return;
    await this.refreshEdges(it, this.issueTime(updated_at));
  }

  /** A source's `updated_at` as a store timestamp; the store clock when the source gave none. */
  private issueTime(updated_at: string | undefined): Timestamp {
    const ms = updated_at === undefined ? NaN : Date.parse(updated_at);
    return iso(Number.isFinite(ms) ? ms : this.d.clock.now().getTime());
  }

  /**
   * What a dependency's state is now: a work item's from the store (see `itemMerged`), else, with `network`, the
   * source's answer, reused for DEPENDENCY_STATE_TTL_MS. Null when unknown or not read now (no item, no network, no
   * capability, a low request budget, or the source failed: logged). `type`: the source type of the item that
   * waits, whose source read the link, so the dependency is in its id space.
   */
  private async dependencyStateOf(type: SourceType, dependsOn: string, network: boolean): Promise<DependencyState | null> {
    const dep = await this.d.store.getWorkItemBySource(type, dependsOn);
    if (dep) {
      if (dep.stage !== "CLOSED") return "open";
      return (await this.itemMerged(dep)) ? "merged" : "closed_unmerged";
    }
    const adapter = this.byType.get(type);
    if (!network || !adapter || !isDependencySource(adapter)) return null;
    // At most one forge read per dependency per DEPENDENCY_STATE_TTL_MS, and none while the budget is low (issue #254).
    const now = this.d.clock.now().getTime();
    const cached = this.dependencyStates.get(dependsOn);
    if (cached && now - cached.at < DEPENDENCY_STATE_TTL_MS) return cached.state;
    if (this.lowBudget()) return null;
    let state: DependencyState | null;
    try {
      state = await adapter.dependencyState(dependsOn);
    } catch (err) {
      this.d.log.warn("dependency state not read: stored state applies", { depends_on: dependsOn, error: (err as Error).message });
      state = null;
    }
    this.dependencyStates.set(dependsOn, { state, at: now });
    // Keep the cache bounded: drop answers past their time.
    if (this.dependencyStates.size > COORDINATION_BATCH * 8) {
      for (const [k, v] of this.dependencyStates) if (now - v.at >= DEPENDENCY_STATE_TTL_MS) this.dependencyStates.delete(k);
    }
    return state;
  }

  /**
   * Whether a work item counts as merged for its dependents: closed `completed` with a merge sha, or a split
   * parent (never implemented itself, so no sha) closed `completed` whose recorded phases all closed `completed`,
   * the rule that closes a split (closeSplitIfDone).
   */
  private async itemMerged(it: WorkItem): Promise<boolean> {
    if (!completed(it)) return false;
    if (it.merge_sha !== null) return true;
    const phases = await this.recordedPhases(it.id);
    return phases.length > 0 && phases.every(completed);
  }

  /** Source id → the source ids it waits for, over every edge not yet merged, for the cycle check. */
  private async dependencyGraph(): Promise<Map<string, string[]>> {
    const graph = new Map<string, string[]>();
    const sourceOf = new Map<string, string | null>();
    for (const e of await this.d.store.listDependencyEdges()) {
      if (e.state === "merged") continue;
      if (!sourceOf.has(e.work_item_id)) sourceOf.set(e.work_item_id, (await this.d.store.getWorkItem(e.work_item_id))?.source.id ?? null);
      const from = sourceOf.get(e.work_item_id);
      if (from) graph.set(from, [...(graph.get(from) ?? []), e.depends_on]);
    }
    return graph;
  }

  /** The transition (and comment) a dependency verdict asks for; nothing when the item already shows it. */
  private async applyDependencies(id: WorkItemId, v: DependencyVerdict): Promise<void> {
    await this.decide(id, async (it) => {
      if (it.stage !== "RUNNING" || it.pr_number !== null || (it.blocked_on !== "none" && it.blocked_on !== "dependency")) return null;
      const short = (d: string) => shortRef(d, it.source.id);
      switch (v.kind) {
        case "clear":
          return it.blocked_on === "dependency"
            ? { patch: { blocked_on: "none", blocked_reason: null }, actor: SYSTEM, reason: "dependency_released" }
            : null;
        case "wait": {
          const reason = dependencyReason(v.open, it.source.id);
          if (it.blocked_on === "dependency" && it.blocked_reason === reason) return null;
          const patch = { blocked_on: "dependency" as const, blocked_reason: reason };
          await this.comment(it, `dependency-hold:${it.id}:${v.open.join(",")}`, [
            `The implement run waits: ${reason}. It starts on its own once ${v.open.length === 1 ? "it merges" : "they merge"}; \`/approve\` does not lift a dependency hold.`,
            "",
            footerAfter(it, patch),
          ].join("\n"));
          return { patch, actor: SYSTEM, reason: "dependency_hold", detail: { depends_on: v.open.join(",") } };
        }
        case "closed": {
          const patch = { blocked_on: "human" as const, blocked_reason: `${DEPENDENCY_CLOSED}:${short(v.dependency)}` };
          await this.comment(it, `dependency-closed:${it.id}:${v.dependency}`, [
            `${short(v.dependency)}, which this item depends on, was closed without a merge, so the factory queued no implement run. A human decides how this item goes on.`,
            "",
            footerAfter(it, patch),
          ].join("\n"));
          return { patch, actor: SYSTEM, reason: DEPENDENCY_CLOSED, detail: { depends_on: v.dependency }, cancel_queued_runs: true };
        }
        case "cycle": {
          const cycle = v.cycle.map(short).join(" → ");
          const patch = { blocked_on: "human" as const, blocked_reason: `${DEPENDENCY_CYCLE}: ${cycle}`.slice(0, 500) };
          await this.comment(it, `dependency-cycle:${it.id}`, [
            `The dependencies of this item form a cycle, so the factory refused it and queued no implement run: ${cycle}. Remove one of the links, then a human decides how this item goes on.`,
            "",
            footerAfter(it, patch),
          ].join("\n"));
          return { patch, actor: SYSTEM, reason: DEPENDENCY_CYCLE, detail: { cycle: v.cycle.join(",") }, cancel_queued_runs: true };
        }
      }
    });
  }

  /** After `sourceId`'s item closed: every item waiting on it is re-checked from the store (no forge call). */
  private async releaseDependents(sourceId: string): Promise<void> {
    for (const e of await this.d.store.listDependencyEdges({ depends_on: sourceId })) {
      await this.guard("dependent", () => this.coordinateItem(e.work_item_id, false));
    }
  }

  /**
   * One comment per coordination-cost hold (run, holder) the claim recorded on the item's queued implement run,
   * naming the hold reason, e.g. `waiting for #92 to merge: both change src/core/worker.ts (conflicted 6 times),
   * cost 4.0 > 2.5`. The status stays implementing.
   */
  private async holdComment(id: WorkItemId): Promise<void> {
    const it = await this.d.store.getWorkItem(id);
    if (!it || it.stage !== "RUNNING" || it.blocked_on !== "none") return;
    const queued = new Set((await this.d.store.listRuns(id)).filter((r) => r.kind === "implement" && r.status === "queued").map((r) => r.id));
    const d = (await this.d.store.listClaimDecisions(id)).filter((x) => queued.has(x.run_id) && x.decision === "held" && !x.approved_by).at(-1);
    if (!d) return;
    await this.comment(it, `coordination-hold:${d.run_id}:${d.holder_ref}`, [
      `The implement run is held: ${holdReason(d)}. It starts on its own when that work merges or no longer overlaps.`,
      "",
      `Reply \`/approve\` to start it now anyway (threshold \`max_coordination_cost\` = ${d.threshold}).`,
    ].join("\n"));
  }

  // Run outcomes

  /** One finished run, then the outbox step, so its messages go out (issue #282). */
  async applyRun(run: Run): Promise<void> {
    await this.apply(run);
    await this.outboxStep();
  }

  private async apply(run: Run): Promise<void> {
    const ack = (reason: string): Decision => ({ patch: {}, actor: SYSTEM, reason, ack_run: run.id });
    // Every finished run adds its tokens to token_cost, an ignored one included (design §6 Measurement): `withSpent`
    // adds them to each decision that does not set token_cost itself.
    const decision = async (it: WorkItem): Promise<Decision> => {
      // An improve run changes nothing else on its system item (design §7): its report is already stored.
      if (run.kind === "improve") return ack(run.outcome?.status === "succeeded" ? "improve_done" : "improve_failed");
      // The run's full token count (design §6 Measurement); old succeeded rows keep the data.tokens they stored.
      const tokens = it.token_cost + runTokenCount(run);
      if (!run.outcome || run.outcome.status !== "succeeded") return this.applyFailedRun(it, run);
      if (!this.expects(it, run.kind)) return ack("run_ignored");
      const data = run.outcome.data;
      // The agent asked for a human (decided 2026-11-07): a finished run with data, never retried on its own.
      if ((run.kind === "implement" || run.kind === "review" || run.kind === "resolve") && data.needs_human != null) {
        const ask = parseNeedsHuman(data.needs_human);
        if (ask.ok && ask.value) return this.needsHuman(it, run, ask.value, tokens);
        if (run.kind === "resolve") return this.resolveFailed(it, run, "invalid_output");
        return this.retryOrBlock(it, run, "task", "invalid_output");
      }

      switch (run.kind) {
        case "triage": {
          // The item's size caps decide whether the estimate needs phases (src/core/split.ts).
          const { max_diff_lines, max_diff_files } = this.settings(it.project);
          // Path companions first (design 04-triage.md): on the raw answer, so a companion triage named only in
          // files_to_change is covered, and before the floor, so an added path under a floor raises the tier.
          const { answer, added } = applyCompanions(data.spec, this.cfg.path_companions ?? []);
          const parsed = parseTriage(answer, { max_diff_lines, max_diff_files });
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
            // The coordination cost's input until the PR exists (design §5, 2026-11-03).
            files_to_change: spec.files_to_change,
            tier,
            token_cost: tokens,
          };
          // A split spec always waits for a human: its /approve files issues on the source.
          const byParent = !spec.phases && (await this.approvedByParent(it));
          if (byParent) {
            // phases_auto_approve: the owner's /approve of the split covers this phase's spec (design 2026-11-01).
            const next = { ...it, ...fields };
            const patch = { ...fields, stage: "RUNNING" as const };
            const url = await this.comment(it, `spec:${run.id}`,
              renderSpec(spec, tier, { floor, previous: it.tier, added }, [
                "The owner approved the split on the parent issue (`phases_auto_approve`), so this phase is implemented without its own `/approve`.",
                "",
                footerAfter(it, patch),
              ].join("\n")), "spec_comment_url");
            return {
              patch: { ...patch, spec_comment_url: url },
              actor: SYSTEM,
              reason: "triaged_phase_approved",
              detail: { parent_work_item_id: it.parent_id! },
              ack_run: run.id,
              enqueue: { kind: "implement", idempotency_key: runKey(next, "implement") },
            };
          }
          if (!spec.phases && !needsSpecApproval(tier, this.cfg.dials)) {
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
            renderSpec(spec, tier, { floor, previous: it.tier, added }, footerAfter(it, patch)), "spec_comment_url");
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
          // What the PR changes, for the coordination cost (design §5, 2026-11-03); absent on older outcomes.
          const files = Array.isArray(data.files) && data.files.every((f) => typeof f === "string") ? (data.files as string[]) : null;
          return {
            patch: {
              stage: "REVIEW",
              pr_number: pr,
              token_cost: tokens,
              ...(files ? { pr_files: files } : {}),
              ...(it.blocked_on === "dependency" ? { blocked_on: "none" as const, blocked_reason: null } : {}),
            },
            actor: SYSTEM,
            reason: "implemented",
            ack_run: run.id,
            enqueue: { kind: "review", idempotency_key: runKey(it, "review") },
          };
        }
        case "review": {
          // The worker withheld finding text its scan flagged (issue #222): only the rule names reached here.
          if (Array.isArray(data.egress_rules)) return this.leakBlock(it, run, data.egress_rules.map(String), { token_cost: tokens }, "review");
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
          const spec = specFindings(parsed.value);
          if (parsed.value.verdict === "bug" || spec.length > 0) {
            // Finding text becomes the next run's input or the spec feedback: scanned before anything is stored.
            const scan = await this.d.scanner.scan("comment", parsed.value.findings.map((f) => f.text).join("\n"));
            if (!scan.clean) return this.leakBlock(it, run, scan.findings.map((f) => f.rule), { tier, token_cost: tokens }, "review");
          }
          // Any spec finding: the implementer cannot fix it inside the spec, so the spec is revised (issue #222).
          if (spec.length > 0) return this.specRevision(it, run, specFeedback(parsed.value), { tier, token_cost: tokens }, "review");
          if (parsed.value.verdict === "bug") {
            if (it.loop_count + 1 >= this.cfg.max_loops) {
              const patch = { tier, token_cost: tokens, blocked_on: "human" as const, blocked_reason: "max_loops" };
              await this.comment(it, `max-loops:${run.id}`,
                `Review found bugs ${it.loop_count + 1} times (limit ${this.cfg.max_loops}). A human needs to decide.\n\n${footerAfter(it, patch)}`);
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
        case "interactive": {
          // `session finish` passed every gate and pushed through the broker (design §5, 2026-11-01): as an implement PR.
          const files = Array.isArray(data.files) && data.files.every((f) => typeof f === "string") ? { pr_files: data.files as string[] } : {};
          const detail = { run_id: run.id, ...(run.actor_id ? { actor_id: run.actor_id } : {}) };
          return {
            patch: { stage: "REVIEW", pr_number: Number(data.pr_number), token_cost: tokens, ...files }, actor: SYSTEM, reason: "session_finished", detail,
            ack_run: run.id, enqueue: { kind: "review", idempotency_key: runKey(it, "review") },
          };
        }
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
    };
    await this.decide(run.work_item_id, async (it) => withSpent(await decision(it), run, it));
  }

  /** A failed or cancelled run's decision, before its usage is added (`apply` does that). */
  private async applyFailedRun(it: WorkItem, run: Run): Promise<Decision> {
    // One owner comment per forge-auth pause, from the run that started it (marker-keyed on the pause end).
    if (run.outcome?.status === "failed" && run.outcome.error_code === FORGE_AUTH && run.outcome.pause_started) {
      await this.forgeAuthComment(it, run);
    }
    // The same for a preflight-access pause (issue #216), keyed on its own pause end.
    if (run.outcome?.status === "failed" && run.outcome.error_code === PREFLIGHT_ACCESS && run.outcome.pause_started) {
      await this.preflightAccessComment(it, run);
    }
    if (!this.expects(it, run.kind)) return { patch: {}, actor: SYSTEM, reason: "run_ignored", ack_run: run.id };
    const code = run.outcome?.status === "failed" ? run.outcome.error_code : "cancelled";
    if (run.kind === "resolve") return this.resolveFailed(it, run, code);
    if (run.kind === "interactive") return sessionReleased(it, run, code);
    // The provider's account or config needs a person (design §5 Restarts): no retry would get further.
    if (code === PROVIDER_SETUP) return this.providerSetup(it, run);
    // The implementer reported a criterion the spec does not let it meet (issue #222): a spec revision, not a block.
    if (run.kind === "implement" && code === SPEC_CONFLICT) {
      const reason = run.outcome?.status === "failed" ? run.outcome.detail.trim() : "";
      const scan = await this.d.scanner.scan("comment", reason);
      if (!scan.clean) return this.leakBlock(it, run, scan.findings.map((f) => f.rule), {}, "implement");
      return this.specRevision(it, run, conflictFeedback(reason), {}, "implement");
    }
    // Deterministic codes, diff_too_large among them (design §5 Restarts): the same spec fails the same way.
    if (run.kind === "implement" && NO_AUTO_RETRY.includes(code)) return this.noAutoRetry(it, run, code);
    if (run.kind !== "update") return this.retryOrBlock(it, run, failureClass(run.outcome), code);
    const patch = { blocked_on: "human" as const, blocked_reason: `run_failed:${run.kind}:${code}` };
    const url = await this.comment(it, `run-failed:${run.id}`,
      `The ${run.kind} run failed (\`${code}\`). Comment \`/retry\` to run it again.\n\n${footerAfter(it, patch)}`, "failure_comment_url");
    return {
      patch: { ...patch, failure_comment_url: url },
      actor: SYSTEM,
      reason: "run_failed",
      ack_run: run.id,
    };
  }

  /**
   * A spec revision the factory starts itself (issue #222): a review with a spec finding, or an implement run that
   * returned `spec_conflict`. The same path as `/revise` after a failure: back to triage with the feedback under
   * the next `:v<n>` key, revision_count + 1, restart_count + 1 so the implement run after the revised spec is
   * approved gets a new key (it continues on the PR branch; the PR number is kept). loop_count is unchanged. At
   * the revision limit (`max_loops`) no triage run starts: the item waits at the spec gate with `max_revisions`
   * (restart_count + 1 there too, so `/approve` implements the current spec afresh) and one comment says so.
   */
  private async specRevision(
    it: WorkItem,
    run: Run,
    feedback: string,
    fields: { tier?: Tier; token_cost?: number },
    from: "review" | "implement",
  ): Promise<Decision> {
    const limit = this.cfg.max_loops;
    const kept = feedback.slice(0, MAX_FEEDBACK_CHARS).trim();
    const detail = { run_id: run.id, from };
    const why = from === "review" ? "The review found that the spec needs a change" : "The implementer reported that the spec cannot be met as written";
    if (it.revision_count >= limit) {
      const patch = {
        ...fields, stage: "READY" as const, blocked_on: "human" as const, blocked_reason: "max_revisions",
        restart_count: it.restart_count + 1, failure_comment_url: null,
      };
      await this.comment(it, `max-revisions:${run.id}`, [
        `${why}, but the spec was revised ${it.revision_count} times (limit \`max_loops\` = ${limit}), so the factory started no new triage run (\`max_revisions\`).`,
        "",
        "Reply `/approve` to implement the spec above as it is, or `/reject <reason>` to close.",
        "",
        footerAfter(it, patch),
      ].join("\n"));
      return { patch, actor: SYSTEM, reason: "max_revisions", detail, ack_run: run.id };
    }
    const n = it.revision_count + 1;
    return {
      patch: {
        ...fields, stage: "NEW", blocked_on: "none", blocked_reason: null, revision_count: n, restart_count: it.restart_count + 1,
        spec_feedback: kept, failure_comment_url: null,
      },
      actor: SYSTEM,
      reason: from === "review" ? "review_spec_revision" : "spec_conflict_revision",
      detail,
      ack_run: run.id,
      // The spec-gate revision key: differs from the intake key and from every earlier revision's key.
      enqueue: { kind: "triage", idempotency_key: `${runKey(it, "triage")}:v${n}` },
    };
  }

  /**
   * Finding text or a spec_conflict reason the egress scan flagged (issue #222): nothing of it is stored. The item
   * blocks on a human as a failed run of its kind (so `/retry` and `/revise` apply) and one comment names the rules.
   */
  private async leakBlock(
    it: WorkItem,
    run: Run,
    rules: readonly string[],
    fields: { tier?: Tier; token_cost?: number },
    kind: "review" | "implement",
  ): Promise<Decision> {
    const names = [...new Set(rules)].map((r) => r.replace(/[^\w.:-]/g, "").slice(0, 60)).filter(Boolean);
    const patch = { ...fields, blocked_on: "human" as const, blocked_reason: `run_failed:${kind}:egress_blocked` };
    const what = kind === "review" ? "review findings" : "spec conflict the implementer reported";
    const url = await this.comment(it, `leak-blocked:${run.id}`, [
      `The ${what} were blocked by the leak scanner (${names.map((n) => `\`${n}\``).join(", ") || "a rule"}), so nothing of them was stored or posted.`,
      "",
      `Comment \`/retry\` to run the ${kind} again, or \`/revise <feedback>\` to get a new spec written.`,
      "",
      footerAfter(it, patch),
    ].join("\n"), "failure_comment_url");
    return {
      patch: { ...patch, failure_comment_url: url },
      actor: SYSTEM,
      reason: "run_failed",
      detail: { run_id: run.id, error_code: "egress_blocked", rules: names.join(",") },
      ack_run: run.id,
    };
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
      if (loop >= this.cfg.max_loops) {
        const patch = { ...fields, blocked_on: "human" as const, blocked_reason: "max_loops" };
        await this.checksComment(it, `max-loops:${reviewRunId}`, names, (list) =>
          `PR #${it.pr_number} passed review but its checks failed${list}. That makes ${loop} loops (limit ${this.cfg.max_loops}). A human needs to decide.\n\n${footerAfter(it, patch)}`);
        return { patch, actor: SYSTEM, reason: "max_loops", detail, ...ack };
      }
      const next = { ...it, loop_count: loop };
      await this.checksComment(it, `checks-failed:${reviewRunId}`, names, (list) =>
        `PR #${it.pr_number} passed review but its checks failed${list}. The factory sent it back to the implementer (loop ${loop} of ${this.cfg.max_loops}).`);
      return {
        patch: { ...fields, stage: "RUNNING", blocked_on: "none", blocked_reason: null, loop_count: loop },
        actor: SYSTEM,
        reason: "checks_failed",
        detail,
        ...ack,
        enqueue: { kind: "implement", idempotency_key: runKey(next, "implement") },
      };
    }
    // Auto-merge does not exist yet: auto_merge_max_tier is fixed at 0, so every PR goes to a human. An incomplete
    // PR (its implementer reported missing work, issue #229) is never auto-merged, and the comment says so first.
    const patch = { ...fields, blocked_on: "human" as const, blocked_reason: "merge_pending" };
    const missing = it.origin === "adopted" ? [] : (lastPrNotes(await this.d.store.listRuns(it.id))?.missing ?? []);
    const ready = `PR #${it.pr_number} passed review (tier ${tier}) and its checks passed.`;
    const text = missing.length > 0
      ? [
        `${ready} It is **incomplete**: the implementer reports work the spec asks for that it does not do. Merging it does not finish this issue.`,
        "",
        ...missing.map((m) => `- ${m}`),
        "",
        "Merge it only with a follow-up issue for the rest, or comment `/revise <feedback>` on the PR to send it back to the implementer.",
      ].join("\n")
      : `${ready} A human merge is required.`;
    await this.comment(it, `merge:${reviewRunId}`, `${text}\n\n${footerAfter(it, patch)}`);
    return { patch, actor: SYSTEM, reason: "review_passed", ...ack };
  }

  /** The PR's checks, from the forge whatever source the item came from; no forge counts as passed, a forge error as pending (logged). */
  private async readChecks(it: WorkItem): Promise<PrChecks> {
    const forge = this.forge;
    if (!forge || it.pr_number === null) return { state: "passed" };
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
    await this.live.refresh();
    await this.checksStep();
    await this.outboxStep();
  }

  private async checksStep(): Promise<void> {
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
    const { max_restart, retry_base_ms, retry_max_ms } = this.cfg;
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
    // Neither a rate limit nor a stall is an attempt: they never reach a limit (design §5 Restarts).
    if (cls !== "rate_limited" && cls !== "stalled" && limit) {
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
    // The same task failure twice in a row (decided 2026-11-07): a third run would fail the same way.
    if (cls === "task" && this.d.repeated_failure_rule !== false && repeatsLastFailure(step, run)) return this.repeatedFailure(it, run, code, detail);
    // The same infra failure twice in a row, each within a minute of its start (issue #216): no passing hiccup.
    if (cls === "infra" && this.d.repeated_failure_rule !== false && repeatsFastInfraFailure(step, run)) {
      return this.repeatedInfraFailure(it, run, code, { ...detail, fast_repeat: true });
    }
    const reset = run.outcome?.status === "failed" ? run.outcome.reset_at : null;
    const backoff = failedAt + retryDelayMs(task + infra, retry_base_ms, retry_max_ms);
    // A forge 401/403 or a failed access check: the retry also waits for its claim pause to end (design §5 Restarts).
    const authEnd = (code === FORGE_AUTH || code === PREFLIGHT_ACCESS) && reset ? Date.parse(reset) : Number.NaN;
    // A stall: no backoff, the stall pause holds every claim until a probe answers.
    const notBefore = cls === "rate_limited"
      ? (reset ?? iso(failedAt + retry_max_ms))
      : cls === "stalled"
        ? iso(failedAt)
        : iso(Number.isNaN(authEnd) ? backoff : Math.max(backoff, authEnd));
    // The run kept its commits on a wip branch: after a failed push or PR the retry pushes them with no agent run;
    // after a stop mid-work (rate limit, stall, timeout) the wip ref is marked `continue` by the worker, and the
    // retry runs the agent on it (design §5 Restarts).
    const wip = run.kind === "implement" && run.outcome?.status === "failed" ? run.outcome.wip : undefined;
    return {
      patch: restart,
      actor: SYSTEM,
      reason: cls === "rate_limited" ? "run_rate_limited" : cls === "stalled" ? "run_stalled" : "run_retry_scheduled",
      detail: { ...detail, not_before: notBefore },
      ack_run: run.id,
      enqueue: { kind: run.kind, idempotency_key: retryKey(run.idempotency_key), not_before: notBefore, ...(wip ? { input: { wip } } : {}) },
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
    // provider_setup is never retried (design §5 Restarts): the item waits on a person, as after the last attempt.
    const next = auto && code !== PROVIDER_SETUP ? nextAutoResolveAttempt(auto.attempt) : null;
    if (auto && next !== null) {
      const failedAt = Date.parse(run.finished_at ?? this.d.clock.now().toISOString());
      const reset = run.outcome?.status === "failed" && code === "rate_limited" ? run.outcome.reset_at : null;
      const notBefore = code === "rate_limited" ? (reset ?? iso(failedAt + this.cfg.retry_max_ms)) : null;
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
   * A comment on the item's PR, through the forge whatever source the item came from (issue #273): a thread entry
   * whose outbox row targets the forge's PR ref, so the outbox step posts it with `postPrComment`. With no PR, or
   * no forge, it goes to the item's own source.
   */
  private async prComment(it: WorkItem, key: string, body: string): Promise<void> {
    if (it.pr_number === null || !this.forge) {
      await this.comment(it, key, body);
      return;
    }
    const pr = this.forge.prRef(it.pr_number);
    const marker = `<!-- factory:${key} -->`;
    await this.d.store.recordItemMessage({ work_item_id: it.id, marker, body, delivery: { source_type: pr.type, target: pr, link_field: null } });
  }

  /**
   * Two task failures in a row in one step with the same code and detail line (issue #167, decided
   * 2026-11-07): the item blocks on a human with `repeated_failure` and no third run is queued. One comment,
   * keyed on the run; the detail line is dropped if the egress scan flags it. `/retry` starts the step afresh.
   */
  private async repeatedFailure(it: WorkItem, run: Run, code: string, detail: StateChangeDetail): Promise<Decision> {
    const line = run.outcome?.status === "failed" ? failureLine(run.outcome.detail) : "";
    const patch = { blocked_on: "human" as const, blocked_reason: REPEATED_FAILURE };
    const body = (withDetail: boolean) => [
      "## Factory check: the same failure twice",
      "",
      `The ${run.kind} run failed twice in a row the same way (\`${code}\`): ${describeFailure(code)}.${withDetail && line ? ` ${line}` : ""}`,
      "",
      "The factory stopped retrying it, since a third run would most likely fail the same way. Fix the cause, then comment `/retry` to run it again with a fresh attempt budget, `/revise <feedback>` to get a new spec written, or `/reject <reason>` to close.",
      "",
      footerAfter(it, patch),
    ].join("\n");
    const scan = await this.d.scanner.scan("comment", body(true));
    const url = await this.comment(it, `run-failed:${run.id}`, body(scan.clean), "failure_comment_url");
    return {
      patch: { ...patch, failure_comment_url: url },
      actor: SYSTEM,
      reason: REPEATED_FAILURE,
      detail,
      ack_run: run.id,
    };
  }

  /**
   * An infra failure that repeats the step's previous run at once (issue #216, decided 2026-11-07): same infra
   * code and detail, both runs finished within FAST_FAILURE_MS of their start. The item blocks on a human with
   * `repeated_failure` (restart_count + 1, as for any infra failure) and no retry is queued. One comment, keyed on
   * the run, names the code, the detail and the tail of the last run's output, as the max_restart dead letter
   * does; the detail is dropped if the egress scan flags it, then the tail too. `/retry` starts the step afresh.
   */
  private async repeatedInfraFailure(it: WorkItem, run: Run, code: string, detail: StateChangeDetail): Promise<Decision> {
    const out = run.outcome?.status === "failed" ? run.outcome : null;
    const patch = { restart_count: it.restart_count + 1, blocked_on: "human" as const, blocked_reason: REPEATED_FAILURE };
    const tail = stripAnsi(out?.output_tail || "").trim();
    const text = stripAnsi(out?.detail ?? "").trim();
    const body = (withDetail: boolean, withTail: boolean) => [
      "## Factory check: the same infrastructure failure twice",
      "",
      `The ${run.kind} run failed twice in a row the same way (\`${code}\`), each time within a minute of starting: ${describeFailure(code)}.${withDetail && text ? ` ${text}` : ""}`,
      "",
      ...(withTail && tail
        ? ["<details><summary>Output tail of the last run</summary>", "", fenced(tail), "", "</details>", ""]
        : []),
      "The factory stopped restarting it, since another run would most likely fail the same way at once. Fix the cause, then comment `/retry` to run it again with a fresh budget, `/revise <feedback>` to get a new spec written, or `/reject <reason>` to close.",
      "",
      footerAfter(it, patch),
    ].join("\n");
    let text0 = body(true, true);
    if (!(await this.d.scanner.scan("comment", text0)).clean) text0 = body(false, true);
    if (!(await this.d.scanner.scan("comment", text0)).clean) text0 = body(false, false);
    const url = await this.comment(it, `run-failed:${run.id}`, text0, "failure_comment_url");
    return {
      patch: { ...patch, failure_comment_url: url },
      actor: SYSTEM,
      reason: REPEATED_FAILURE,
      detail,
      ack_run: run.id,
    };
  }

  /**
   * An implement, review or resolve run that returned needs_human (issue #167, decided 2026-11-07). The
   * worker pushed nothing. The item keeps its stage and blocks on a human with `agent_needs_human`; nothing is
   * queued. One comment, keyed on the run, gives the agent's reason and question (left out if the egress scan
   * flags them) and the command footer. The run's tokens are added as for any finished run; the ack fences it.
   */
  private async needsHuman(it: WorkItem, run: Run, ask: NeedsHuman, tokens: number): Promise<Decision> {
    const patch = { blocked_on: "human" as const, blocked_reason: AGENT_NEEDS_HUMAN };
    const footer = commandFooter(commandState({ ...it, ...patch }, run.kind));
    const answer = run.kind === "resolve"
      ? "Reply `/resolve <your answer>` to run the resolve again with your answer as its notes, or `/retry` to run it again as it is."
      : `Fix what it needs, then reply \`/retry\` to run the ${run.kind} again, \`/revise <feedback>\` to get a new spec written with your answer, or \`/reject <reason>\` to close.`;
    // The paths an implementer names are shown as the exact reply only; they never change allowed_paths (issue #280).
    const reply = run.kind === "implement" ? retryPathsReply((ask.paths ?? []).filter((p) => !isCovered(p, it.allowed_paths))) : null;
    const body = (withText: boolean) => [
      "## Factory: the agent needs a human",
      "",
      `The ${run.kind} run stopped and asked for a human instead of going on. Nothing was pushed.`,
      "",
      ...(withText
        ? [
            "**Reason**", "", quote(ask.reason), "", "**Question**", "", quote(ask.question),
            ...(reply ? ["", "It names paths outside the allowed paths. To allow them and run the implementer again, reply:", "", "```", reply, "```"] : []),
          ]
        : ["The agent's reason and question were withheld by the leak scanner."]),
      "",
      answer,
      "",
      footer,
    ].join("\n");
    const scan = await this.d.scanner.scan("comment", body(true));
    const url = await this.comment(it, `needs-human:${run.id}`, body(scan.clean), "failure_comment_url");
    return {
      patch: { ...patch, token_cost: tokens, failure_comment_url: url },
      actor: SYSTEM,
      reason: AGENT_NEEDS_HUMAN,
      detail: { run_id: run.id, run_kind: run.kind },
      ack_run: run.id,
    };
  }

  /** The kind of run behind an agent_needs_human or repeated_failure block (from the item's runs); else undefined. */
  private async blockedBy(it: WorkItem): Promise<RunKind | undefined> {
    if (it.blocked_on !== "human" || (it.blocked_reason !== AGENT_NEEDS_HUMAN && it.blocked_reason !== REPEATED_FAILURE)) return undefined;
    return blockingRunKind(it.blocked_reason, await this.d.store.listRuns(it.id));
  }

  /** At agent_needs_human: the kind of run that asked; else undefined. */
  private async askedBy(it: WorkItem): Promise<RunKind | undefined> {
    return it.blocked_reason === AGENT_NEEDS_HUMAN ? this.blockedBy(it) : undefined;
  }

  /** The step a `/retry` restarts: the run behind an agent block, else what the item's fields say. */
  private async retryKind(it: WorkItem): Promise<RunKind | undefined> {
    return (await this.blockedBy(it)) ?? failedRunKind(it);
  }

  /** The command state of `it`, with the kind of run that asked at agent_needs_human. */
  private async stateOf(it: WorkItem) {
    return commandState(it, await this.askedBy(it));
  }

  /**
   * An implement failure the factory never retries automatically (design §5 Restarts, decided 2026-11-02; before,
   * only `diff_too_large`): `no_commits`, `scope_violation`, `egress_blocked` and the pre-push size gate's
   * `diff_too_large` (design §4). The same spec would fail the same way. Blocks on a human with the usual
   * run_failed reason, so `/retry` reruns the implement and `/revise` asks for a new spec. One comment, keyed on
   * the run; its detail is dropped if the egress scan flags it.
   */
  private async noAutoRetry(it: WorkItem, run: Run, code: string): Promise<Decision> {
    const detail = run.outcome?.status === "failed" ? run.outcome.detail.trim() : "";
    const patch = { blocked_on: "human" as const, blocked_reason: `run_failed:implement:${code}` };
    const body = (withDetail: boolean) => {
      if (code === DIFF_TOO_LARGE) {
        const { max_diff_lines, max_diff_files } = this.settings(it.project);
        return [
          "## Factory size check: push blocked",
          "",
          `The implement run's diff is too large to review (\`${DIFF_TOO_LARGE}\`), so nothing was pushed${withDetail && detail ? `: ${detail}` : ""}.`,
          "",
          `Limits: \`max_diff_lines\` = ${max_diff_lines} (added plus deleted lines), \`max_diff_files\` = ${max_diff_files}.`,
          "",
          "Comment `/revise <feedback>` to get a new, smaller spec written with your feedback, or `/retry` to run the implementer again on the same spec; it must make a smaller change.",
          "",
          ...suggestedSplit(detail, it.allowed_paths, { max_diff_lines, max_diff_files }),
          footerAfter(it, patch),
        ].join("\n");
      }
      return [
        "## Factory check: implement run stopped",
        "",
        `The implement run failed (\`${code}\`): ${describeFailure(code)}.${withDetail && detail ? ` ${detail}` : ""} Nothing was pushed.`,
        "",
        "The factory does not retry this automatically, since the same spec would most likely fail the same way. Comment `/revise <feedback>` to get a new spec written with your feedback, or `/retry` to run the implementer again on the same spec.",
        "",
        footerAfter(it, patch),
      ].join("\n");
    };
    const scan = await this.d.scanner.scan("comment", body(true));
    const url = await this.comment(it, `run-failed:${run.id}`, body(scan.clean), "failure_comment_url");
    return {
      patch: { ...patch, failure_comment_url: url },
      actor: SYSTEM,
      reason: "run_failed",
      detail: { run_id: run.id, error_code: code },
      ack_run: run.id,
    };
  }

  /**
   * A run the model provider refused for its account or config (`provider_setup`, design §5 Restarts): the quota,
   * the API key or the model name. Any run kind; never retried, since waiting does not fix it, and no claim pause.
   * Blocks on a human with `run_failed:<kind>:provider_setup`, so `/retry` runs it again once fixed. One comment,
   * keyed on the run, says what to fix and quotes the provider's message, dropped if the egress scan flags it.
   */
  private async providerSetup(it: WorkItem, run: Run): Promise<Decision> {
    const detail = run.outcome?.status === "failed" ? run.outcome.detail.trim() : "";
    const patch = { blocked_on: "human" as const, blocked_reason: `run_failed:${run.kind}:${PROVIDER_SETUP}` };
    const body = (withDetail: boolean) => [
      "## Factory check: the model provider needs setup",
      "",
      `The ${run.kind} run failed (\`${PROVIDER_SETUP}\`): ${describeFailure(PROVIDER_SETUP)}.${withDetail && detail ? ` ${detail}` : ""}`,
      "",
      "The factory does not retry this automatically, since waiting will not fix it. Check the provider account's quota or billing, the API key (`npm run setup`) and the model names in `factory.config.json`, then comment `/retry` to run it again.",
      "",
      footerAfter(it, patch),
    ].join("\n");
    const scan = await this.d.scanner.scan("comment", body(true));
    const url = await this.comment(it, `run-failed:${run.id}`, body(scan.clean), "failure_comment_url");
    return {
      patch: { ...patch, failure_comment_url: url },
      actor: SYSTEM,
      reason: "run_failed",
      detail: { run_id: run.id, error_code: PROVIDER_SETUP },
      ack_run: run.id,
    };
  }

  /**
   * The owner comment for a forge-auth pause (design §5 Restarts): on the item whose run started the pause, once
   * per pause (the marker is keyed on the pause's end). It names the code and the time only, never the forge's
   * answer or a credential.
   */
  private async forgeAuthComment(it: WorkItem, run: Run): Promise<void> {
    const until = run.outcome?.status === "failed" ? run.outcome.reset_at : null;
    if (!until) return;
    await this.comment(it, `forge-auth:${until}`, [
      "## Factory forge check: implement runs paused",
      "",
      `The forge answered 401 or 403 to the factory's credentials during this item's ${run.kind} run (\`${FORGE_AUTH}\`), so implement and update runs are paused for every worker until ${until}. Triage and review runs go on.`,
      "",
      "Check the factory's GitHub credentials (the app installation or token): they need write access to contents and pull requests on this repository. The run is retried after the pause ends.",
    ].join("\n"));
  }

  /**
   * The owner comment for a preflight-access pause (issue #216): on the item whose run started it, once per pause
   * (keyed on the pause's end). It names the failed check and the time, never the forge's answer.
   */
  private async preflightAccessComment(it: WorkItem, run: Run): Promise<void> {
    const out = run.outcome?.status === "failed" ? run.outcome : null;
    if (!out?.reset_at) return;
    const check = preflightCheck(out.detail) ?? "push_access or pr_api";
    await this.comment(it, `preflight-access:${out.reset_at}`, [
      "## Factory forge check: implement runs paused",
      "",
      `The implement preflight's \`${check}\` check failed during this item's ${run.kind} run (\`${PREFLIGHT_ACCESS}\`), so implement and update runs are paused for every worker until ${out.reset_at}. Triage and review runs go on.`,
      "",
      "Check that the factory's GitHub app or token can still read this repository and its pull requests, and that GitHub answers. The run is retried after the pause ends.",
    ].join("\n"));
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
      : `The ${run.kind} run hit ${n} infrastructure failures (limit \`max_restart\` = ${this.cfg.max_restart}), so the factory stopped restarting it.`;
    const tail = stripAnsi(out?.output_tail || out?.detail || "").trim();
    const first = firstErrorLine(tail);
    const tests = failingTests(tail);
    const body = [
      what,
      "",
      `Last error: \`${code}\`: ${describeFailure(code)}.${out?.detail ? ` ${stripAnsi(out.detail)}` : ""}`,
      "",
      ...(first ? ["First error line:", "", fenced(first), ""] : []),
      ...(tests.length ? ["Failing tests:", "", ...tests.map((t) => `- \`${t.replace(/`/g, "'")}\``), ""] : []),
      ...(tail
        ? ["<details><summary>Output tail of the last run</summary>", "", fenced(tail), "", "</details>", ""]
        : ["The last run left no output.", ""]),
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
    return this.comment(it, `run-failed:${run.id}`, body, "failure_comment_url");
  }

  // Internals

  /** Whether the item is in the state a finished run of this kind should advance. */
  private expects(it: WorkItem, kind: RunKind): boolean {
    // An update runs while the PR waits for a human merge, so the item stays blocked on that human throughout.
    if (kind === "update") return awaitingMerge(it);
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
  private async decide(
    id: WorkItemId,
    fn: (item: WorkItem) => Decision | Refusal | Promise<Decision | Refusal>,
  ): Promise<string | null> {
    for (let i = 0; i < MAX_CONFLICT_RETRIES; i++) {
      const item = await this.d.store.getWorkItem(id);
      if (!item) return null;
      // No adapter for the item's source type here (a source left out of this process's `plugins.source`, e.g.
      // an older version still draining): the item keeps its state for a process that has one, so its replies
      // are not dropped (2026-11-07).
      if (!this.serves(item.source.type)) {
        this.d.log.warn("no source adapter for the item's source type; transition left to another process", {
          work_item_id: id,
          source_type: item.source.type,
        });
        return null;
      }
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
      min_sample: this.cfg.budget_min_sample ?? DEFAULT_BUDGET_MIN_SAMPLE,
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
    const local = identity.provider === "local";
    const principal = await (local ? this.localAuth : this.d.auth).resolve(identity);
    if (!principal) {
      if (local) return { refuse: "your local identity resolves to no factory user under the local auth plugin" };
      return { refuse: "your account is not linked to a factory user; link it with `/link <code>` (code from `factory link-code <user_id>`)" };
    }
    return this.allowed(principal, action, resource, local);
  }

  /** The auth plugin for local commands: the CLI and the local UI (issue #318). */
  private get localAuth(): AuthProvider {
    return this.d.local_auth ?? this.d.auth;
  }

  /**
   * The permission half of `authorize`, for a principal already known (an app request names its user). `local`:
   * a command from the CLI or the local UI, checked by the local auth plugin.
   */
  private async allowed(principal: Principal, action: AuthAction, resource: string, local = false): Promise<Principal | Refusal> {
    const decision = await (local ? this.localAuth : this.d.auth).authorize(principal, action, { kind: "work_item", id: resource });
    if (!decision.allow) {
      this.d.log.warn("unauthorized", { user_id: principal.user_id, action, reason: decision.reason });
      if (local && this.d.local_auth) {
        return { refuse: `${principal.user_id} has no role that allows it (\`${decision.reason}\`); the local owner can grant one with \`factory users add ${principal.user_id} --role approver\`` };
      }
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
   * adopted item's source is its PR, so it is labelled once. `current` says a target already shows the status.
   */
  private async showStatus(it: WorkItem, current: (pr_number: number | null) => boolean = () => false): Promise<void> {
    const status = statusOf(it);
    if (!current(null)) await this.setStatus(it.source, status, null);
    if (it.pr_number !== null && it.origin !== "adopted" && !current(it.pr_number)) await this.setStatus(it.source, status, it.pr_number);
  }

  /**
   * Best effort, like markSeen: a failure is a warning and never changes a transition's outcome. The item
   * itself is labelled through its own source; a PR through the forge, where PRs live (issue #273). With no
   * forge, the PR call goes to the item's own source.
   */
  private async setStatus(source: SourceRef, status: WorkStatus, pr_number: number | null): Promise<void> {
    try {
      if (pr_number !== null && this.forge) await this.forge.setPrStatus(source, status, pr_number);
      else await this.adapterFor(source, "setStatus")?.setStatus(source, status, pr_number);
    } catch (err) {
      this.d.log.warn("set status failed", {
        source_id: source.id,
        status,
        pr_number,
        error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
      });
    }
  }

  /**
   * Writes one message to the item's thread, once per key (issue #282); the outbox step delivers it. Returns the
   * delivered comment's URL when an earlier write of the same key was already delivered, else null: `link` names
   * the item field the outbox fills with the URL once it delivers.
   */
  private async comment(it: WorkItem, key: string, body: string, link: ThreadLinkField | null = null): Promise<string | null> {
    return this.post(it, it.source, body, `<!-- factory:${key} -->`, link);
  }

  /**
   * The thread write behind every factory message: the entry, and in the same transaction its outbox row unless
   * the thread is the item's own surface (a local item). An entry goes only to its item's own source: `target`
   * (e.g. the item's PR) is used when it is of that source's type, else the item's source.
   */
  private async post(it: WorkItem, target: SourceRef, body: string, marker: string, link: ThreadLinkField | null = null): Promise<string | null> {
    const type = it.source.type;
    const delivery = type === LOCAL_TYPE ? null : { source_type: type, target: target.type === type ? target : it.source, link_field: link };
    const { created, message } = await this.d.store.recordItemMessage({ work_item_id: it.id, marker, body, delivery });
    if (created || delivery === null) return null;
    const row = (await this.d.store.listDeliveries(it.id)).find((d) => d.thread_seq === message.seq);
    return row?.url ?? null;
  }

  /**
   * The outbox (issue #282): each pending thread entry of a source type this process has an adapter for, claimed
   * so one replica posts it, delivered through that adapter, then marked delivered; an entry whose target is one
   * of the forge's PR refs goes through the forge (issue #273). A failure is retried with backoff (retry_base_ms
   * doubling up to retry_max_ms); it never touches the item's state. Entries this process cannot deliver stay
   * pending for a process that can.
   */
  private async outboxStep(): Promise<void> {
    const types = new Set(this.byType.keys());
    if (this.forge) types.add(this.forge.ref_type);
    for (const row of await this.d.store.listPendingDeliveries([...types], OUTBOX_BATCH)) {
      await this.guard("outbox delivery", () => this.deliver(row));
    }
  }

  /** How `row` is posted here: through the forge for one of its PR refs, else the adapter of its source type. */
  private poster(row: ThreadDelivery): ((body: string, marker: string) => Promise<{ url: string | null }>) | null {
    const forge = this.forge;
    const pr = forge?.prNumberOf(row.target) ?? null;
    if (forge && pr !== null) return (body, marker) => forge.postPrComment(pr, body, marker);
    const adapter = this.byType.get(row.source_type);
    return adapter ? (body, marker) => adapter.postComment(row.target, body, marker) : null;
  }

  private async deliver(row: ThreadDelivery): Promise<void> {
    const post = this.poster(row);
    if (!post) return;
    const token = await this.d.store.claimDelivery(row.seq, this.cfg.lease_ms);
    if (token === null) return;
    // A marker the store has a posted record of is delivered with its URL and no call; a changed body is not
    // edited, only logged.
    const stored = await this.d.store.getPostedComment(row.target.id, row.marker, row.body);
    if (stored?.comment_id) {
      if (!stored.same_body) this.d.log.warn("comment already posted with another body; not edited", { source_id: row.target.id, marker: row.marker });
      await this.d.store.finishDelivery(row.seq, token, stored.url);
      return;
    }
    let url: string | null;
    try {
      url = (await post(row.body, row.marker)).url;
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 300) : "unknown";
      const delay = retryDelayMs(row.attempts + 1, this.cfg.retry_base_ms, this.cfg.retry_max_ms);
      this.d.log.warn("outbox delivery failed; retried later", { work_item_id: row.work_item_id, outbox_seq: row.seq, attempts: row.attempts + 1, retry_in_ms: delay, error });
      await this.d.store.failDelivery(row.seq, token, error, delay);
      return;
    }
    await this.d.store.finishDelivery(row.seq, token, url);
  }

  /** Whether this process can apply an item's transitions: it has the item's source adapter, or the item is local. */
  private serves(type: SourceType): boolean {
    return type === LOCAL_TYPE || this.byType.has(type);
  }

  /**
   * The adapter for `source`'s type. None configured (the source was removed from `plugins.source`): a
   * warning and null, so the call is skipped and the item keeps its state.
   */
  private adapterFor(source: SourceRef, call: string): SourceAdapter | null {
    const adapter = this.byType.get(source.type);
    if (adapter) return adapter;
    // A local item's surface is the store itself: nothing to call, nothing to warn about.
    if (source.type === LOCAL_TYPE) return null;
    this.d.log.warn("no source adapter for the item's source type; skipped", { source_type: source.type, source_id: source.id, call });
    return null;
  }

  private async guard(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // A GitHub call refused with no calls left is a wait for the reset, not a failure: the step runs again next
      // poll, and every other step (local work) goes on.
      const until = rateLimitWait(err);
      if (until) this.d.log.warn("waiting for the GitHub rate-limit reset", { step: what, until });
      else this.d.log.error("loop step failed", { step: what, error: err instanceof Error ? err.message.slice(0, 300) : "unknown" });
    }
  }
}

/** A human `/retry`: the failed run again, or why there is none. */
/**
 * A failed or cancelled run's decision with its usage added to `token_cost` (design §6 Measurement): only a
 * decision that acknowledges this run, so the add lands in the ack's transaction and the ack fences it (a
 * second apply is refused as already acknowledged, and adds nothing). A run with no usage changes nothing.
 */
/**
 * A session that ended without a PR (abandoned, lease lost), design §5, 2026-11-01: never retried. The item is released:
 * RUNNING, blocked on a human with `session_released`, nothing queued, for the next `session start`. A pushed branch stays.
 */
function sessionReleased(_it: WorkItem, run: Run, code: string): Decision {
  const detail = { run_id: run.id, error_code: code, ...(run.actor_id ? { actor_id: run.actor_id } : {}) };
  return { patch: { blocked_on: "human", blocked_reason: SESSION_RELEASED }, actor: SYSTEM, reason: SESSION_RELEASED, detail, ack_run: run.id };
}

function withSpent(d: Decision, run: Run, it: WorkItem): Decision {
  const spent = runTokenCount(run);
  if (!d || spent === 0 || d.ack_run !== run.id || "token_cost" in d.patch) return d;
  return { ...d, patch: { ...d.patch, token_cost: it.token_cost + spent } };
}

/**
 * `/retry [notes]`: the failed step again under a new key. `widen` (a `+paths`, issue #280) applies only to a
 * failed implement run; on any other kind it is refused and nothing changes. The note goes on the state change
 * (and is a resolve run's notes).
 */
function retry(it: WorkItem, actor: Actor, kind: RunKind | undefined, note: string | null, widen: Widening | null): Decision | Refusal {
  if (it.blocked_on !== "human" || !kind) return { refuse: "there is no failed run to retry" };
  if (widen && kind !== "implement") {
    return { refuse: `\`+paths\` applies only to a failed implement run, and this item's failed run is a ${kind} run; reply \`/retry\` without \`+paths\`` };
  }
  const w = widen ?? NO_WIDENING;
  const detail = { ...(note ? { note } : {}), ...w.detail };
  const next = { ...it, restart_count: it.restart_count + 1 };
  // A retried update goes back to waiting for the merge, which is the state an update run expects.
  const unblocked = kind === "update"
    ? { blocked_on: "human" as const, blocked_reason: "merge_pending" }
    : { blocked_on: "none" as const, blocked_reason: null };
  // A new step key with no not_before: a human retry starts at once, with a fresh retry budget.
  return {
    patch: { ...unblocked, restart_count: next.restart_count, ...w.patch },
    actor,
    reason: "retry_requested",
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
    // A resolve run reads its notes from its input: the /retry note, or none.
    enqueue: { kind, idempotency_key: runKey(next, kind), ...(kind === "resolve" ? { input: { notes: note ?? "" } } : {}) },
  };
}

/** A later phase of a split, waiting for the phase before it (design 2026-11-01). */
function phaseHeld(it: WorkItem): boolean {
  return it.stage === "NEW" && it.blocked_on === "upstream" && it.blocked_reason === PHASE_HOLD;
}

/** Closed as completed: the only close that releases the next phase or counts toward closing the parent. */
function completed(it: WorkItem | null | undefined): boolean {
  return it?.stage === "CLOSED" && it.close_reason === "completed";
}

/** A phase whose spec waits at the gate for `/approve`. */
function phaseSpecPending(it: WorkItem): boolean {
  return it.parent_id !== null && it.stage === "READY" && it.blocked_on === "human" && it.blocked_reason === "spec_pending";
}

/** A split parent whose phases are filed and not all closed as completed. */
/** A split parent whose `/approve` claimed the filing and has not settled it yet. */
function splitFiling(it: WorkItem): boolean {
  return it.stage === "READY" && it.blocked_on === "upstream" && it.blocked_reason === SPLIT_FILING;
}

function splitOpen(it: WorkItem): boolean {
  return it.stage === "READY" && it.blocked_on === "upstream" && it.blocked_reason === PHASES_OPEN;
}

/**
 * The size checkpoint's suggested split (design 2026-11-01): built from the diff size in the size gate's detail
 * and the paths the item may change, never the code; no agent runs. Empty when the detail has no counts or
 * there is nothing to split. Ends with a blank line, so the footer follows.
 */
function suggestedSplit(detail: string, paths: readonly string[], limits: { max_diff_lines: number; max_diff_files: number }): string[] {
  const size = parseSizeDetail(detail);
  const phases = size ? suggestSplit({ ...size, paths }, limits) : [];
  if (!size || phases.length === 0) return [];
  const out = [
    "### Suggested split",
    `Built from the diff size (${size.lines} lines in ${size.files} files) and the item's allowed paths, not from the code, so treat it as a starting point. To use it, reply \`/revise <feedback>\` and ask for these phases; the new spec then files one sub-issue per phase on \`/approve\`.`,
  ];
  phases.forEach((p, i) => {
    out.push(
      "",
      `#### Phase ${i + 1} of ${phases.length}: ${p.title}`,
      p.problem,
      "",
      "Done when:",
      ...p.done_criteria.map((c) => `- ${c}`),
      "",
      "Allowed to change:",
      ...p.allowed_paths.map((a) => `- \`${a}\``),
    );
  });
  out.push("");
  return out;
}

/**
 * The feedback of a "Request changes" review: its body, then each line comment as `path:line` and its text.
 * Untrusted text; the worker fences it.
 */
function reviewFeedback(e: PrReviewEvent): string {
  const parts = e.body.trim() ? [e.body.trim()] : [];
  const lines = e.comments.filter((c) => c.body.trim()).map((c) => {
    const where = c.line === null ? c.path : `${c.path}:${c.line}`;
    return `- ${where}: ${c.body.trim().replace(/\r?\n/g, "\n  ")}`;
  });
  if (lines.length) parts.push(["Line comments:", ...lines].join("\n"));
  return parts.join("\n\n");
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
 * `/resolve [notes]` (design §5 Merge conflict). Only on an item waiting on a merge conflict, or on one whose resolve
 * run asked for a human (agent_needs_human, decided 2026-11-07). Starts a resolve
 * run under a new key: restart_count + 1, as /retry does, since the run key is per (loop, restart) and a second
 * /resolve would otherwise be a silent no-op. The notes go on the run for the worker; they are untrusted.
 */
function resolveCommand(e: ResolveEvent, it: WorkItem, actor: Actor, resolveAsked: boolean): Decision | Refusal {
  // Also the answer to a resolve run that asked for a human (agent_needs_human): the reply is its notes.
  const asked = resolveAsked && it.blocked_on === "human" && it.blocked_reason === AGENT_NEEDS_HUMAN;
  if (!conflictPending(it) && !asked) {
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
/** `d` with `tag` added to its state change detail; a refusal or no-op as it is. */
function withTag(d: Decision | Refusal, tag: StateChangeDetail | null): Decision | Refusal {
  if (!tag || !d || "refuse" in d) return d;
  return { ...d, detail: { ...d.detail, ...tag } };
}

function floorCommand(
  e: ItemCommandEvent, it: WorkItem, actor: Actor, need: number | null, note: string | null, w: Widening,
): Decision | Refusal {
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
  // A `+paths` under a higher floor raises the tier further (issue #280).
  const next = { ...it, tier: effectiveTier(it.tier, need as Tier, w.patch.tier), restart_count: it.restart_count + 1 };
  return {
    patch: { ...w.patch, tier: next.tier, restart_count: next.restart_count, blocked_on: "none", blocked_reason: null },
    actor,
    reason: "floor_tier_approved",
    detail: { previous_tier: it.tier, tier: next.tier, ...(note ? { note } : {}), ...w.detail },
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
  // The implement run's code (design §4, 2026-11-03): a task failure, retried up to max_attempts. Not the
  // CHECKS_FAILED blocked reason above, which is a failed PR check after review (design §5 CI gate).
  checks_failed: "a check before push (repo.check_commands) failed, also after one fix step; nothing was pushed to the PR branch",
  toolchain_missing: "a check before push could not start its tools (a module under node_modules or a tool binary is missing); an infrastructure failure, retried without spending an attempt",
  test_database_failed: "the run's test database for the checks could not be created",
  unresolved_conflicts: "conflicts were left unresolved",
  head_moved: "the install or test command moved HEAD off the commit the gates checked",
  prompt_missing: "prompts/resolve.md is missing",
  push_failed: "the push was rejected",
  forge_auth: "the forge refused the factory's credentials (401 or 403); implement and update runs are paused",
  preflight_failed: "a check before the agent started failed (the base fetch); no agent ran",
  preflight_access: "the push access or PR API check before the agent started failed; implement and update runs are paused",
  rate_limited: "the model provider's usage or rate limit was hit",
  provider_setup: "the model provider refused the account or config: its quota, the API key or the model name; nothing was retried",
  egress_blocked: "the output was stopped by the leak scanner",
  agent_failed: "the agent exited with an error",
  agent_timed_out: "the agent run timed out",
  agent_stalled: "the model printed nothing for stall_ms with no tool call open; runs are paused until a probe answers",
  lease_lost: "the worker lost its lease on the run (stopped, crashed or slept)",
  lease_expired: "the run's lease expired with no heartbeat (the worker stopped, crashed or slept)",
  exception: "the worker hit an unexpected error",
  git_failed: "a git command failed",
  cancelled: "the run was cancelled",
};

/** The spec feedback of a review with a spec finding: every finding, spec ones marked, then the summary. */
function specFeedback(r: ReviewOutput): string {
  return ["The factory reviewer found that the spec needs a change.", "", r.summary, "", ...r.findings.map((f) => `- ${findingLine(f)}`)].join("\n");
}

/** The spec feedback of an implement run that returned spec_conflict. */
function conflictFeedback(reason: string): string {
  return ["The implementer could not meet a done criterion inside the spec:", "", reason].join("\n");
}

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
