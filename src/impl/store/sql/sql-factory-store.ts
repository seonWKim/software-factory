import { createHash } from "node:crypto";
import type { TierHistory } from "../../../core/budget.js";
import type {
  Actor,
  BudgetCheckpoint,
  BudgetCheckpointId,
  BudgetOutcome,
  ClaimDecision,
  CloseReason,
  DependencyEdge,
  DependencyState,
  Handoff,
  HostSleep,
  ImproveReport,
  ImproveReportId,
  Run,
  RunAttempt,
  RunAttemptStatus,
  RunId,
  RunKind,
  RunOutcome,
  RunStatus,
  SourceRef,
  SourceType,
  Stage,
  StandingGate,
  StandingProposal,
  StandingProposalId,
  StandingRule,
  StateChange,
  StateChangeDetail,
  StateChangeId,
  Tier,
  Timestamp,
  UnreviewedMerge,
  UnreviewedMergeId,
  UserId,
  Verdict,
  VerdictId,
  VerdictSeverity,
  WorkItem,
  WorkItemId,
  ClaimPauseName,
  RunInput,
  RunResume,
  SessionRecord,
  WorkerId,
  WorkerPause,
} from "../../../core/types.js";
import { outcomeTokens } from "../../../core/types.js";
import {
  type CoordinationSettings,
  type DependencyLink,
  type Hold,
  type Holder,
  DEFAULT_COORDINATION,
  claimDecision,
  holdOutcome,
  holdsOn,
  shortRef,
} from "../../../core/coordination.js";
import {
  GITHUB_RATE_LIMIT, IMPLEMENT_KINDS, INTERACTIVE, MODEL_ANSWERED, MODEL_STALL, MODEL_STALL_SINCE, SESSION_LOST, failureClass, pathsOverlap,
} from "../../../core/policy.js";
import { assertProjectKey } from "../../../core/project.js";
import type { StatsRecord } from "../../../core/stats.js";
import type { LinkedAccount } from "../../../interfaces/auth-provider.js";
import type { Clock } from "../../../interfaces/clock.js";
import type {
  AbandonedAttempt,
  AppCommandRequest,
  AppendInboxResult,
  AnswerBudgetCheckpointInput,
  ApproveClaimHoldInput,
  ApproveClaimHoldResult,
  BudgetCheckpointResult,
  ClaimInput,
  CliCommand,
  Alert,
  FactoryStore,
  InboxRow,
  ItemMessage,
  LeaseResult,
  ListenerLease,
  LabelState,
  LabelTarget,
  MergeCheck,
  NewMergeCheck,
  NewPostedComment,
  PostedComment,
  ListenerLeaseResult,
  NewAppCommandRequest,
  NewCliCommand,
  NewAlert,
  NewImproveReport,
  NewInboxEvent,
  NewItemMessage,
  NewRun,
  NewStandingProposal,
  NewStandingRule,
  NewUnreviewedMerge,
  NewWorkItem,
  OpenBudgetCheckpointInput,
  RecordConflictsInput,
  RecordPrHeadInput,
  RecordPrHeadResult,
  RecordVerdictInput,
  ThreadDelivery,
  ThreadLinkField,
  RecordVerdictResult,
  LocalRole,
  LocalUser,
  RedeemLinkResult,
  ResetSettingInput,
  SchemaVersion,
  SessionUpdate,
  SetSettingInput,
  SettingChange,
  SettingOverride,
  StartSessionInput,
  StoreTable,
  TableCell,
  TablePage,
  TablePageInput,
  StartSessionResult,
  TransitionInput,
  TransitionResult,
  WorkItemFilter,
  WorkerProcess,
  WorkerProcessReport,
} from "../../../interfaces/factory-store.js";
import { LINK_CODE_MAX_FAILURES, LINK_CODE_TTL_MS, TABLE_PAGE_DEFAULT, TABLE_PAGE_MAX } from "../../../interfaces/factory-store.js";
import { migrationPendingError } from "../../../interfaces/updater.js";
import type { SourceEvent } from "../../../interfaces/source-adapter.js";
import type { Row, SqlDriver, SqlExecutor, SqlValue } from "./driver.js";
import { countLegacyProjectRows, legacyRowsMessage } from "../project-keys.js";
import {
  WORK_ITEM_COLUMNS,
  diffPatch,
  newId,
  newWorkItem,
  rowToBudgetCheckpoint,
  rowToClaimDecision,
  rowToDependencyEdge,
  rowToHandoff,
  rowToHostSleep,
  rowToRun,
  rowToRunAttempt,
  rowToStateChange,
  rowToUnreviewedMerge,
  rowToVerdict,
  rowToWorkItem,
  workItemValues,
} from "./rows.js";

/**
 * FactoryStore over any SqlDriver (SQLite, MySQL). Every write is one driver transaction. Correctness
 * never depends on the row locks alone: every state change is also a conditional UPDATE (version,
 * status, lease token), and uniqueness is enforced by keys, with a duplicate treated as "already there".
 */
export class SqlFactoryStore implements FactoryStore {
  constructor(
    private readonly db: SqlDriver,
    private readonly clock: Clock,
  ) {}

  /**
   * The schema (SQLite builds it; MySQL refuses while steps are pending), then the project-key check: the store
   * refuses to open while any project column still holds `owner/name` (design 2026-11-01), so a new controller
   * never runs on unmigrated rows. `npm run migrate` rewrites them.
   */
  async migrate(): Promise<void> {
    await this.db.migrate();
    const legacy = await countLegacyProjectRows(this.db);
    if (legacy > 0) throw migrationPendingError(legacyRowsMessage(legacy));
  }

  schemaVersion(): Promise<SchemaVersion> {
    return this.db.schemaVersion();
  }

  close(): Promise<void> {
    return this.db.close();
  }

  // Work items

  async createWorkItem(
    input: NewWorkItem,
    actor: Actor,
    opts?: { enqueue?: Omit<NewRun, "work_item_id">; detail?: StateChangeDetail },
  ): Promise<{ item: WorkItem; created: boolean }> {
    // A project column holds only project keys (design 2026-11-01), never `owner/name`.
    assertProjectKey(input.project);
    return this.db.transaction(async (tx) => {
      const existing = await this.selectItemBySource(tx, input.source.type, input.source.id);
      if (existing) return { item: existing, created: false };

      const item = newWorkItem(input, this.now());
      const values = workItemValues(item);
      const inserted = await this.insertOnce(
        tx,
        `INSERT INTO work_items (${WORK_ITEM_COLUMNS}) VALUES (${placeholders(values.length)})`,
        values,
      );
      // A concurrent intake of the same source committed first.
      if (!inserted) return { item: (await this.selectItemBySource(tx, input.source.type, input.source.id))!, created: false };

      if (input.adopted) {
        await this.insertStateChange(tx, item.id, 1, actor, "pr_adopted", {
          stage: { from: null as never, to: "REVIEW" },
          pr_number: { from: null, to: input.adopted.pr_number },
        });
      } else {
        const held = item.blocked_on !== "none"
          ? { blocked_on: { from: "none" as const, to: item.blocked_on }, blocked_reason: { from: null, to: item.blocked_reason } }
          : {};
        await this.insertStateChange(
          tx, item.id, 1, actor, "intake", { stage: { from: null as never, to: "NEW" }, ...held }, opts?.detail ?? null,
        );
      }
      if (opts?.enqueue) await this.insertRun(tx, { ...opts.enqueue, work_item_id: item.id });
      return { item, created: true };
    });
  }

  async getWorkItem(id: WorkItemId): Promise<WorkItem | null> {
    return this.selectItem(this.db, id);
  }

  async getWorkItemBySource(type: SourceType, sourceId: string): Promise<WorkItem | null> {
    return this.selectItemBySource(this.db, type, sourceId);
  }

  async getWorkItemByPr(project: string, pr_number: number): Promise<WorkItem | null> {
    const [row] = await this.db.all(
      `SELECT * FROM work_items WHERE project = ? AND pr_number = ? ORDER BY created_at, ${this.db.dialect.seq} LIMIT 1`,
      [project, pr_number],
    );
    return row ? rowToWorkItem(row) : null;
  }

  async getWorkItemByMergeSha(project: string, sha: string): Promise<WorkItem | null> {
    const [row] = await this.db.all(
      `SELECT * FROM work_items WHERE merge_sha = ? AND project = ? ORDER BY created_at, ${this.db.dialect.seq} LIMIT 1`,
      [sha, project],
    );
    return row ? rowToWorkItem(row) : null;
  }

  async listPhases(parentId: WorkItemId): Promise<WorkItem[]> {
    const rows = await this.db.all(`SELECT * FROM work_items WHERE parent_id = ? ORDER BY phase, ${this.db.dialect.seq}`, [parentId]);
    return rows.map(rowToWorkItem);
  }

  async listWorkItems(limit: number): Promise<WorkItem[]> {
    const rows = await this.db.all(`SELECT * FROM work_items ORDER BY created_at DESC, ${this.db.dialect.seq} DESC LIMIT ?`, [
      limit,
    ]);
    return rows.map(rowToWorkItem);
  }

  async listWorkItemsWhere(filter: WorkItemFilter): Promise<WorkItem[]> {
    const { where, params } = whereOf(filter);
    const rows = await this.db.all(
      `SELECT * FROM work_items${where} ORDER BY updated_at DESC, ${this.db.dialect.seq} DESC LIMIT ?`,
      [...params, filter.limit],
    );
    return rows.map(rowToWorkItem);
  }

  async countWorkItemsWhere(filter: Omit<WorkItemFilter, "limit">): Promise<number> {
    const { where, params } = whereOf(filter);
    const [row] = await this.db.all(`SELECT COUNT(*) AS n FROM work_items${where}`, params);
    return Number(row?.n ?? 0);
  }

  async countWorkItemsByStage(): Promise<Record<Stage, number>> {
    const counts: Record<Stage, number> = { NEW: 0, READY: 0, RUNNING: 0, REVIEW: 0, CLOSED: 0 };
    const rows = await this.db.all("SELECT stage, COUNT(*) AS n FROM work_items GROUP BY stage");
    for (const r of rows) counts[r.stage as Stage] = Number(r.n);
    return counts;
  }

  async transition(input: TransitionInput): Promise<TransitionResult> {
    return this.db.transaction((tx) => this.applyTransition(tx, input));
  }

  /** transition() inside a caller's transaction. A refusal returns before anything is written. */
  private async applyTransition(tx: SqlExecutor, input: TransitionInput): Promise<TransitionResult> {
    const { forUpdate } = this.db.dialect;
    const current = await this.selectItem(tx, input.id, forUpdate);
    if (!current) return { ok: false, reason: "not_found" };
    if (current.version !== input.expected_version) return { ok: false, reason: "version_conflict", current };

    if (input.ack_run !== undefined) {
      const run = await this.selectRun(tx, input.ack_run, forUpdate);
      const finished = run && (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled");
      if (!run || run.work_item_id !== input.id || !finished || run.acknowledged_at !== null) {
        return { ok: false, reason: "run_not_ackable" };
      }
    }

    const { changes, sets, values } = diffPatch(current, input.patch);
    const now = this.now();
    const version = current.version + 1;
    const updated = await tx.run(
      `UPDATE work_items SET ${[...sets, "version = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`,
      [...values, version, now, input.id, input.expected_version],
    );
    if (updated !== 1) return { ok: false, reason: "version_conflict", current };

    const state_change = await this.insertStateChange(
      tx, input.id, version, input.actor, input.reason, changes, input.detail ?? null,
    );
    if (input.ack_run !== undefined) {
      await tx.run("UPDATE runs SET acknowledged_at = ?, updated_at = ? WHERE id = ?", [now, now, input.ack_run]);
    }
    const enqueued = input.enqueue ? await this.insertRun(tx, { ...input.enqueue, work_item_id: input.id }) : null;
    const cancelled = [
      ...(input.cancel_queued_runs ? await this.cancelRuns(tx, input.id, "queued", now) : []),
      ...(input.cancel_running_runs ? await this.cancelRuns(tx, input.id, "running", now) : []),
    ];
    const item = (await this.selectItem(tx, input.id))!;
    // Closing the item settles its checkpoints that have no outcome yet (design §6).
    const outcome = item.close_reason === null ? null : OUTCOME[item.close_reason];
    if (current.stage !== "CLOSED" && item.stage === "CLOSED" && outcome) {
      await tx.run("UPDATE budget_checkpoints SET outcome = ? WHERE work_item_id = ? AND outcome IS NULL", [outcome, input.id]);
    }
    // A closed item (its PR merged or closed: the merge path's transition) holds nothing from this commit on, so
    // the queued runs' decisions that name it go too; the next claim records what holds them now (design §5).
    // An approval stays: it is the human's, for that run.
    if (current.stage !== "CLOSED" && item.stage === "CLOSED") {
      await tx.run(
        `DELETE FROM claim_decisions WHERE holder_work_item_id = ? AND approved_by IS NULL
           AND run_id IN (SELECT id FROM runs WHERE status = 'queued')`,
        [input.id],
      );
    }
    return { ok: true, item, state_change, enqueued, cancelled };
  }

  async listStateChanges(id: WorkItemId): Promise<StateChange[]> {
    const rows = await this.db.all("SELECT * FROM state_changes WHERE work_item_id = ? ORDER BY version", [id]);
    return rows.map(rowToStateChange);
  }

  async recordVerdict(input: RecordVerdictInput): Promise<RecordVerdictResult> {
    const { forUpdate } = this.db.dialect;
    try {
      return await this.db.transaction(async (tx): Promise<RecordVerdictResult> => {
        const current = await this.selectItem(tx, input.id, forUpdate);
        if (!current) return { ok: false, reason: "not_found" };
        // Before the version: a redelivered comment is a no-op whatever happened to the item since.
        const existing = await this.selectVerdictByComment(tx, input.comment_id);
        if (existing) return { ok: false, reason: "duplicate", verdict: existing };
        if (current.version !== input.expected_version) return { ok: false, reason: "version_conflict", current };

        const now = this.now();
        const version = current.version + 1;
        const updated = await tx.run("UPDATE work_items SET version = ?, updated_at = ? WHERE id = ? AND version = ?", [
          version, now, input.id, input.expected_version,
        ]);
        if (updated !== 1) return { ok: false, reason: "version_conflict", current };

        const state_change = await this.insertStateChange(tx, input.id, version, input.actor, "human_verdict", {});
        const verdict: Verdict = {
          id: newId("vd") as VerdictId,
          work_item_id: input.id,
          state_change_id: state_change.id,
          verdict: input.verdict,
          severity: input.severity,
          reason: input.reason,
          comment_id: input.comment_id,
          target: input.target,
          at: now,
        };
        const inserted = await this.insertOnce(
          tx,
          `INSERT INTO verdicts (id, work_item_id, state_change_id, verdict, severity, reason, comment_id, target, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            verdict.id, verdict.work_item_id, verdict.state_change_id, verdict.verdict, verdict.severity,
            verdict.reason, verdict.comment_id, verdict.target, verdict.at,
          ],
        );
        // A concurrent delivery of the same comment committed first: undo the version bump and state change.
        if (!inserted) throw new DuplicateVerdict();
        return { ok: true, item: (await this.selectItem(tx, input.id))!, state_change, verdict };
      });
    } catch (err) {
      if (!(err instanceof DuplicateVerdict)) throw err;
      return { ok: false, reason: "duplicate", verdict: (await this.selectVerdictByComment(this.db, input.comment_id))! };
    }
  }

  async listVerdicts(id: WorkItemId): Promise<Verdict[]> {
    const rows = await this.db.all(`SELECT * FROM verdicts WHERE work_item_id = ? ORDER BY at, ${this.db.dialect.seq}`, [id]);
    return rows.map(rowToVerdict);
  }

  // Budget checkpoints

  async openBudgetCheckpoint(input: OpenBudgetCheckpointInput): Promise<BudgetCheckpointResult> {
    const { checkpoint, ...transition } = input;
    return this.db.transaction(async (tx): Promise<BudgetCheckpointResult> => {
      const [pending] = await tx.all("SELECT id FROM budget_checkpoints WHERE work_item_id = ? AND answer = 'pending'", [input.id]);
      if (pending) return { ok: false, reason: "checkpoint_pending" };
      const r = await this.applyTransition(tx, transition);
      if (!r.ok) return r;
      const id = newId("bc") as BudgetCheckpointId;
      await tx.run(
        `INSERT INTO budget_checkpoints (id, work_item_id, tier, tokens_spent, budget, suggested_budget, answer, granted_budget,
           held_run_kind, held_run_key, held_run_not_before, outcome, created_at, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL, ?, NULL)`,
        [
          id, input.id, checkpoint.tier, checkpoint.tokens_spent, checkpoint.budget, checkpoint.suggested_budget,
          checkpoint.held_run_kind, checkpoint.held_run_key, checkpoint.held_run_not_before, this.now(),
        ],
      );
      return { ...r, checkpoint: (await this.selectCheckpoint(tx, id))! };
    });
  }

  async answerBudgetCheckpoint(input: AnswerBudgetCheckpointInput): Promise<BudgetCheckpointResult> {
    const { checkpoint_id, answer, granted_budget, ...transition } = input;
    try {
      return await this.db.transaction(async (tx): Promise<BudgetCheckpointResult> => {
        const cp = await this.selectCheckpoint(tx, checkpoint_id, this.db.dialect.forUpdate);
        if (!cp || cp.work_item_id !== input.id || cp.answer !== "pending") return { ok: false, reason: "checkpoint_not_pending" };
        const r = await this.applyTransition(tx, transition);
        if (!r.ok) return r;
        const answered = await tx.run(
          "UPDATE budget_checkpoints SET answer = ?, granted_budget = ?, answered_at = ? WHERE id = ? AND answer = 'pending'",
          [answer, granted_budget, this.now(), checkpoint_id],
        );
        // A concurrent answer committed first: undo this transition.
        if (answered !== 1) throw new CheckpointAnswered();
        return { ...r, checkpoint: (await this.selectCheckpoint(tx, checkpoint_id))! };
      });
    } catch (err) {
      if (!(err instanceof CheckpointAnswered)) throw err;
      return { ok: false, reason: "checkpoint_not_pending" };
    }
  }

  async listBudgetCheckpoints(id: WorkItemId): Promise<BudgetCheckpoint[]> {
    const rows = await this.db.all(
      `SELECT * FROM budget_checkpoints WHERE work_item_id = ? ORDER BY created_at, ${this.db.dialect.seq}`,
      [id],
    );
    return rows.map(rowToBudgetCheckpoint);
  }

  async getTierHistory(project: string, tier: Tier): Promise<TierHistory> {
    const rows = await this.db.all(
      "SELECT close_reason, token_cost FROM work_items WHERE project = ? AND tier = ? AND stage = 'CLOSED'",
      [project, tier],
    );
    return {
      finished: rows.length,
      merged_token_costs: rows.filter((r) => r.close_reason === "completed").map((r) => Number(r.token_cost)),
    };
  }

  async listStatsRecords(reasons: readonly string[]): Promise<StatsRecord[]> {
    const { seq } = this.db.dialect;
    // Three plain reads, no transaction: a read-only command takes no write lock (SQLite) and no row lock.
    const items = await this.db.all(`SELECT id, tier, stage, token_cost, origin FROM work_items ORDER BY created_at, ${seq}`);
    const records = new Map<string, StatsRecord>();
    for (const r of items) {
      records.set(r.id as string, {
        id: r.id as WorkItemId,
        tier: r.tier === null ? null : (Number(r.tier) as Tier),
        stage: r.stage as Stage,
        token_cost: Number(r.token_cost),
        reasons: [],
        severities: [],
        origin: (r.origin as WorkItem["origin"] | null) ?? "factory",
      });
    }
    if (reasons.length > 0) {
      const changes = await this.db.all(
        `SELECT work_item_id, reason FROM state_changes WHERE reason IN (${placeholders(reasons.length)})
         ORDER BY work_item_id, version`,
        [...reasons],
      );
      for (const c of changes) records.get(c.work_item_id as string)?.reasons.push(c.reason as string);
    }
    const verdicts = await this.db.all(`SELECT work_item_id, severity FROM verdicts ORDER BY at, ${seq}`);
    for (const v of verdicts) records.get(v.work_item_id as string)?.severities.push(v.severity as VerdictSeverity);
    return [...records.values()];
  }

  // Runs

  async claimRun(input: ClaimInput): Promise<Run | null> {
    // An interactive run is a person's session, never a worker's (design §5, 2026-11-01).
    const kinds = input.kinds.filter((k) => k !== INTERACTIVE);
    if (kinds.length === 0) return null;
    const { seq, forUpdate } = this.db.dialect;
    const writeKinds = placeholders(IMPLEMENT_KINDS.length);
    return this.db.transaction(async (tx) => {
      // The lock row first: claimers run the same-item check below one at a time, so two of them can never both
      // see "nothing of this item is running" and claim two runs of one item. Only a claim moves a run to 'running',
      // so the running set read under the lock stays true until this commits. (SQLite: BEGIN IMMEDIATE already
      // serializes; the select is a no-op.)
      await tx.all(`SELECT name FROM claim_locks WHERE name = ?${forUpdate}`, [CLAIM_LOCK]);
      const now = this.now();
      // A usage or rate limit pauses every claim, for every item, on every replica; a forge 401/403 pauses the
      // implement-type claims only, and so does a failed push_access or pr_api preflight check; a GitHub rate
      // limit pauses implement-type and review claims (design §5 Restarts). All are rows of claim_pauses, read
      // under the lock.
      const pauses = new Map(
        (
          await tx.all("SELECT name, resume_at FROM claim_pauses WHERE name IN (?, ?, ?, ?, ?, ?)", [
            RATE_LIMIT_PAUSE, FORGE_AUTH_PAUSE, PREFLIGHT_ACCESS_PAUSE, GITHUB_RATE_LIMIT, MODEL_STALL, MODEL_ANSWERED,
          ])
        ).map((r) => [r.name as string, r.resume_at as string]),
      );
      const active = (name: ClaimPauseName) => (pauses.get(name) ?? "") > now;
      if (active(RATE_LIMIT_PAUSE)) return null;
      // A stall pauses every claim until a probe answers, not until a time (design §5 Restarts).
      if (stallInEffect(pauses.get(MODEL_STALL), pauses.get(MODEL_ANSWERED))) return null;
      // `workers pause`: this loop's own row or the all-flag stops its claims (design §5 Pause), read under the lock.
      const [workerPaused] = await tx.all("SELECT worker_id FROM worker_pauses WHERE worker_id IN (?, ?)", [input.worker_id, ALL_WORKERS]);
      if (workerPaused) return null;
      const forgePaused = active(FORGE_AUTH_PAUSE) || active(PREFLIGHT_ACCESS_PAUSE);
      const githubPaused = active(GITHUB_RATE_LIMIT);

      // Items with an implement-type run in progress (architecture §4, one branch writer per item). Items whose
      // allowed_paths overlap do run side by side; their conflicts are resolved at merge.
      const busy = new Set(
        (
          await tx.all(`SELECT work_item_id FROM runs WHERE status = 'running' AND kind IN (${writeKinds})`, [...IMPLEMENT_KINDS])
        ).map((r) => r.work_item_id as string),
      );
      // Open sessions (design §5, 2026-11-01): an implement-type run waits while its item has one or overlaps one.
      const sessions = (await this.runningPaths(tx, [INTERACTIVE])).map((r) => ({ id: r.work_item_id as string, paths: parseList(r.allowed_paths) }));
      const overlapsSession = async (itemId: string): Promise<boolean> => {
        if (sessions.length === 0 || sessions.some((x) => x.id === itemId)) return sessions.length > 0;
        const it = await this.selectItem(tx, itemId as WorkItemId);
        return it !== null && sessions.some((x) => pathsOverlap(it.allowed_paths, x.paths).length > 0);
      };

      // Queued runs by kind rank (runs that lead to a human decision first), then created_at, then insertion
      // order (design §5 Parallel workers). not_before: a retry waits out its backoff, whichever worker looks.
      const rank = CLAIM_ORDER.map((_, i) => `WHEN ? THEN ${i}`).join(" ");
      const queued = await tx.all(
        `SELECT r.id, r.kind, r.work_item_id FROM runs r
         WHERE r.status = 'queued' AND r.kind IN (${placeholders(kinds.length)})
           AND (r.not_before IS NULL OR r.not_before <= ?)
         ORDER BY CASE r.kind ${rank} ELSE ${CLAIM_ORDER.length} END, r.created_at, r.${seq}`,
        [...kinds, now, ...CLAIM_ORDER],
      );
      // Coordination (design §5, 2026-11-03): read once, only when an implement run is a candidate.
      const coord = queued.some((q) => q.kind === "implement")
        ? await this.coordinationContext(tx, queued, busy)
        : null;
      const settings = input.coordination ?? DEFAULT_COORDINATION;
      for (const next of queued) {
        // An implement-type run waits while its own item has one running, or while the forge refuses the
        // credentials; it stays queued. Triage and review never wait.
        const writer = (IMPLEMENT_KINDS as readonly string[]).includes(next.kind as string);
        if (writer && (forgePaused || busy.has(next.work_item_id as string))) continue;
        // A GitHub rate limit holds every kind that calls GitHub on its way (implement, update, review) until the
        // reset; triage and resolve still claim.
        if (githubPaused && (writer || next.kind === "review")) continue;
        if (writer && (await overlapsSession(next.work_item_id as string))) continue;
        // An implement run also waits for its dependencies and, before its PR exists, while its cost is too high.
        if (next.kind === "implement" && coord && !(await this.coordinate(tx, next.id as RunId, next.work_item_id as WorkItemId, coord, settings))) {
          continue;
        }
        const id = next.id as RunId;
        // A paused run's resume adds nothing to attempt (design §5 Pause): it was not a new try.
        const claimed = await tx.run(
          `UPDATE runs SET status = 'running', attempt = attempt + CASE WHEN paused_at IS NULL THEN 1 ELSE 0 END,
             lease_owner = ?, lease_token = lease_token + 1, lease_expires_at = ?, started_at = ?, updated_at = ?,
             paused_at = NULL, paused_by = NULL
           WHERE id = ? AND status = 'queued'`,
          [input.worker_id, this.after(input.lease_ms), now, now, id],
        );
        if (claimed === 1) {
          const run = (await this.selectRun(tx, id))!;
          await this.openAttempt(tx, run, now);
          return run;
        }
      }
      return null;
    });
  }

  /**
   * What the claim needs for coordination, read under the claim lock: the queued implement runs' items, the
   * items with an implement-type run running, every open PR's item, the queued items' dependency edges (with
   * the state of the work item each points to), recorded conflicts and the stored claim decisions.
   */
  private async coordinationContext(tx: SqlExecutor, queued: Row[], busy: ReadonlySet<string>): Promise<CoordContext> {
    const runs = queued.filter((q) => q.kind === "implement");
    const ids = [...new Set([...runs.map((q) => q.work_item_id as string), ...busy])];
    const items = new Map<string, WorkItem>();
    for (const r of await tx.all(`SELECT * FROM work_items WHERE id IN (${placeholders(ids.length)})`, ids)) {
      items.set(r.id as string, rowToWorkItem(r));
    }
    const openPrs = (await tx.all("SELECT * FROM work_items WHERE pr_number IS NOT NULL AND stage <> 'CLOSED'")).map(rowToWorkItem);
    for (const it of openPrs) items.set(it.id, it);
    const queuedIds = [...new Set(runs.map((q) => q.work_item_id as string))];
    const edges = await tx.all(
      `SELECT e.work_item_id, e.state, w.stage, w.close_reason, w.merge_sha FROM dependency_edges e
       LEFT JOIN work_items w ON w.source_type = 'github_issue' AND w.source_id = e.depends_on
       WHERE e.work_item_id IN (${placeholders(queuedIds.length)})`,
      queuedIds,
    );
    const unmet = new Set<string>();
    for (const e of edges) {
      const merged = e.state === "merged" || (e.stage === "CLOSED" && e.close_reason === "completed" && e.merge_sha !== null);
      if (!merged) unmet.add(e.work_item_id as string);
    }
    const projects = [...new Set([...items.values()].map((it) => it.project))];
    const conflicts = new Map<string, Map<string, number>>();
    if (projects.length > 0) {
      const rows = await tx.all(
        `SELECT project_key, path, COUNT(*) AS n FROM file_conflicts WHERE project_key IN (${placeholders(projects.length)})
         GROUP BY project_key, path`,
        projects,
      );
      for (const r of rows) {
        const m = conflicts.get(r.project_key as string) ?? new Map<string, number>();
        m.set(r.path as string, Number(r.n));
        conflicts.set(r.project_key as string, m);
      }
    }
    const runIds = runs.map((q) => q.id as string);
    const decisions = new Map<string, ClaimDecision>();
    for (const r of await tx.all(`SELECT * FROM claim_decisions WHERE run_id IN (${placeholders(runIds.length)})`, runIds)) {
      decisions.set(r.run_id as string, rowToClaimDecision(r));
    }
    const depHeld = (id: string) => unmet.has(id) || items.get(id)?.blocked_on === "dependency";
    // Holders: running items, open PRs, then other claimable queued implement runs of items with no PR.
    const holders: Holder[] = [];
    const ref = (it: WorkItem, self: string) => (it.pr_number !== null ? `#${it.pr_number}` : shortRef(it.source.id, self));
    const holderOf = (it: WorkItem, kind: Holder["kind"]): Holder => ({
      work_item_id: it.id,
      project: it.project,
      ref: ref(it, it.source.id),
      kind,
      files: it.pr_files ?? (it.pr_number === null ? it.files_to_change : null) ?? it.allowed_paths,
      fallback: kind === "pr" && it.pr_files === null,
    });
    for (const id of busy) {
      const it = items.get(id);
      if (it) holders.push(holderOf(it, "running"));
    }
    for (const it of openPrs) if (!busy.has(it.id)) holders.push(holderOf(it, "pr"));
    for (const id of queuedIds) {
      const it = items.get(id);
      if (it && it.pr_number === null && !busy.has(id) && !depHeld(id)) holders.push(holderOf(it, "waiting"));
    }
    return { items, holders, conflicts, decisions, depHeld };
  }

  /**
   * Whether queued implement run `runId` may be claimed now (design §5, 2026-11-03). Writes the run's claim
   * decision when the cost rule decided it and the decision changed. A `held` run then follows `hold_policy`
   * (issue #314), timed from `held_since`: the start of the hold, kept while the run stays held.
   */
  private async coordinate(
    tx: SqlExecutor, runId: RunId, itemId: WorkItemId, c: CoordContext, s: CoordinationSettings,
  ): Promise<boolean> {
    if (c.depHeld(itemId)) return false;
    const it = c.items.get(itemId);
    // A review fix or retry on an item with a PR: its conflicts are the PR's, handled at merge.
    if (!it || it.pr_number !== null) return true;
    const existing = c.decisions.get(runId) ?? null;
    // Holders named relative to this item, so one of the same repository is "#N".
    const holders = c.holders.map((h) => (h.work_item_id ? { ...h, ref: this.refFor(c, h.work_item_id, it) } : h));
    const holds = holdsOn({ work_item_id: it.id, project: it.project, files: it.files_to_change ?? it.allowed_paths }, holders,
      c.conflicts.get(it.project) ?? new Map(), s);
    const verdict = claimDecision(holds);
    if (verdict === "free") return true;
    const now = this.now();
    const since = existing?.decision === "held" ? (existing.held_since ?? existing.at) : now;
    const write = (decision: ClaimDecision["decision"]) => this.writeDecision(tx, it, runId, decision, holds[0]!, s.max_cost, existing, since);
    if (existing?.approved_by) {
      await write("approved");
      return true;
    }
    if (verdict === "deadlock") {
      await write("deadlock");
      return true;
    }
    const outcome = holdOutcome(holds, s, Date.parse(now) - Date.parse(since));
    await write(outcome);
    return outcome !== "held";
  }

  private refFor(c: CoordContext, holderId: string, self: WorkItem): string {
    const h = c.items.get(holderId);
    if (!h) return holderId;
    return h.pr_number !== null ? `#${h.pr_number}` : shortRef(h.source.id, self.source.id);
  }

  /** Upserts the run's claim decision; a decision equal to the stored one writes nothing. approved_by is kept. */
  private async writeDecision(
    tx: SqlExecutor, it: WorkItem, runId: RunId, decision: ClaimDecision["decision"], hold: Hold, threshold: number,
    existing: ClaimDecision | null, held_since: Timestamp,
  ): Promise<void> {
    const row = {
      decision,
      holder_work_item_id: hold.holder.work_item_id,
      holder_ref: hold.holder.ref,
      holder_kind: hold.holder.kind,
      shared: JSON.stringify(hold.shared),
      cost: hold.cost,
      threshold,
      fallback: hold.holder.fallback ? 1 : 0,
      held_since,
    };
    if (
      existing && existing.decision === row.decision && existing.holder_work_item_id === row.holder_work_item_id &&
      existing.holder_ref === row.holder_ref && existing.holder_kind === row.holder_kind &&
      JSON.stringify(existing.shared) === row.shared && existing.cost === row.cost && existing.threshold === row.threshold &&
      (existing.fallback ? 1 : 0) === row.fallback && existing.held_since === row.held_since
    ) {
      return;
    }
    const values = [
      row.decision, row.holder_work_item_id, row.holder_ref, row.holder_kind, row.shared, row.cost, row.threshold, row.fallback, row.held_since,
    ];
    const now = this.now();
    const updated = await tx.run(
      `UPDATE claim_decisions SET decision = ?, holder_work_item_id = ?, holder_ref = ?, holder_kind = ?, shared = ?, cost = ?,
         threshold = ?, fallback = ?, held_since = ?, at = ? WHERE run_id = ?`,
      [...values, now, runId],
    );
    if (updated === 0) {
      await this.insertOnce(
        tx,
        `INSERT INTO claim_decisions (run_id, work_item_id, decision, holder_work_item_id, holder_ref, holder_kind, shared, cost,
           threshold, fallback, held_since, approved_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [runId, it.id, ...values, now],
      );
    }
  }

  async pauseClaims(
    resume_at: Timestamp,
    name: ClaimPauseName = RATE_LIMIT_PAUSE,
  ): Promise<{ extended: boolean; started?: boolean; resume_at: Timestamp }> {
    // `started` for every name but rate_limit: the rate-limit pause's result stays exactly as it was (out of this change).
    const result = (extended: boolean, started: boolean, at: Timestamp) =>
      name === RATE_LIMIT_PAUSE ? { extended, resume_at: at } : { extended, started, resume_at: at };
    if (name === MODEL_STALL) return this.pauseForStall(resume_at);
    if (name === MODEL_STALL_SINCE) throw new Error("model_stall_since is written by the store when a stall pause starts");
    return this.db.transaction(async (tx) => {
      if (await this.insertOnce(tx, "INSERT INTO claim_pauses (name, resume_at) VALUES (?, ?)", [name, resume_at])) {
        return result(true, true, resume_at);
      }
      // Conditional, so concurrent callers never both start it: only the update that finds the pause already
      // ended starts a new one (the row stays after a pause ends), and only a later time moves a running one.
      const now = this.now();
      const restarted = await tx.run("UPDATE claim_pauses SET resume_at = ? WHERE name = ? AND resume_at <= ? AND resume_at < ?", [
        resume_at, name, now, resume_at,
      ]);
      if (restarted === 1) return result(true, true, resume_at);
      const moved = await tx.run("UPDATE claim_pauses SET resume_at = ? WHERE name = ? AND resume_at > ? AND resume_at < ?", [
        resume_at, name, now, resume_at,
      ]);
      if (moved === 1) return result(true, false, resume_at);
      const [row] = await tx.all("SELECT resume_at FROM claim_pauses WHERE name = ?", [name]);
      return result(false, false, row!.resume_at as Timestamp);
    });
  }

  /**
   * The stall pause (design §5 Restarts), under the claim lock so a claim, a stall and a probe never interleave.
   * It is in effect while its row's time (the next probe) is after the last answered probe, whatever the clock
   * says. Not in effect: this call starts one (`started`) and writes when it began (`model_stall_since`). In
   * effect: only a later probe time moves it.
   */
  private async pauseForStall(resume_at: Timestamp): Promise<{ extended: boolean; started: boolean; resume_at: Timestamp }> {
    const { forUpdate } = this.db.dialect;
    return this.db.transaction(async (tx) => {
      await tx.all(`SELECT name FROM claim_locks WHERE name = ?${forUpdate}`, [CLAIM_LOCK]);
      const rows = new Map(
        (await tx.all("SELECT name, resume_at FROM claim_pauses WHERE name IN (?, ?)", [MODEL_STALL, MODEL_ANSWERED]))
          .map((r) => [r.name as string, r.resume_at as Timestamp]),
      );
      const current = rows.get(MODEL_STALL);
      const answered = rows.get(MODEL_ANSWERED);
      if (current !== undefined && stallInEffect(current, answered)) {
        if (resume_at <= current) return { extended: false, started: false, resume_at: current };
        await tx.run("UPDATE claim_pauses SET resume_at = ? WHERE name = ?", [resume_at, MODEL_STALL]);
        return { extended: true, started: false, resume_at };
      }
      // A probe time not after the last answer would start a pause that is already over.
      if (answered !== undefined && resume_at <= answered) return { extended: false, started: false, resume_at: current ?? resume_at };
      const now = this.now();
      for (const [name, at] of [[MODEL_STALL, resume_at], [MODEL_STALL_SINCE, now]] as const) {
        if (!(await this.insertOnce(tx, "INSERT INTO claim_pauses (name, resume_at) VALUES (?, ?)", [name, at]))) {
          await tx.run("UPDATE claim_pauses SET resume_at = ? WHERE name = ?", [at, name]);
        }
      }
      return { extended: true, started: true, resume_at };
    });
  }

  async getClaimPause(name: ClaimPauseName = RATE_LIMIT_PAUSE): Promise<Timestamp | null> {
    if (name === MODEL_STALL || name === MODEL_STALL_SINCE) {
      // In effect until a probe answers, not until a time: the probe time is returned also once it passed.
      const rows = new Map(
        (await this.db.all("SELECT name, resume_at FROM claim_pauses WHERE name IN (?, ?, ?)", [MODEL_STALL, MODEL_STALL_SINCE, MODEL_ANSWERED]))
          .map((r) => [r.name as string, r.resume_at as Timestamp]),
      );
      if (!stallInEffect(rows.get(MODEL_STALL), rows.get(MODEL_ANSWERED))) return null;
      return rows.get(name) ?? null;
    }
    const [row] = await this.db.all("SELECT resume_at FROM claim_pauses WHERE name = ?", [name]);
    const at = (row?.resume_at as Timestamp | undefined) ?? null;
    return at !== null && at > this.now() ? at : null;
  }

  async endClaimPause(name: ClaimPauseName): Promise<{ ended: boolean }> {
    if (name === MODEL_STALL_SINCE || name === MODEL_ANSWERED) throw new Error(`${name} is not a pause of its own; end model_stall`);
    if (name === MODEL_STALL) return this.endStall();
    // Conditional: only a row still in effect moves, so a second call, or one with no pause, writes nothing.
    const now = this.now();
    const ended = await this.db.run("UPDATE claim_pauses SET resume_at = ? WHERE name = ? AND resume_at > ?", [now, name, now]);
    return { ended: ended === 1 };
  }

  /**
   * Ends a stall pause as an answered probe would, under the claim lock: model_answered and the probe time both
   * move to the earlier of the probe time and now. Never a future answer, so a stall right after starts a pause.
   */
  private async endStall(): Promise<{ ended: boolean }> {
    const { forUpdate } = this.db.dialect;
    return this.db.transaction(async (tx) => {
      await tx.all(`SELECT name FROM claim_locks WHERE name = ?${forUpdate}`, [CLAIM_LOCK]);
      const rows = new Map(
        (await tx.all("SELECT name, resume_at FROM claim_pauses WHERE name IN (?, ?)", [MODEL_STALL, MODEL_ANSWERED]))
          .map((r) => [r.name as string, r.resume_at as Timestamp]),
      );
      const probeAt = rows.get(MODEL_STALL);
      if (probeAt === undefined || !stallInEffect(probeAt, rows.get(MODEL_ANSWERED))) return { ended: false };
      const now = this.now();
      const at = probeAt < now ? probeAt : now;
      if (!(await this.insertOnce(tx, "INSERT INTO claim_pauses (name, resume_at) VALUES (?, ?)", [MODEL_ANSWERED, at]))) {
        await tx.run("UPDATE claim_pauses SET resume_at = ? WHERE name = ?", [at, MODEL_ANSWERED]);
      }
      await tx.run("UPDATE claim_pauses SET resume_at = ? WHERE name = ?", [at, MODEL_STALL]);
      return { ended: true };
    });
  }

  async takeStallProbe(due: Timestamp, next: Timestamp): Promise<{ taken: boolean }> {
    // Under the claim lock, as every stall write: a pause ended meanwhile is never moved back into effect.
    const { forUpdate } = this.db.dialect;
    return this.db.transaction(async (tx) => {
      await tx.all(`SELECT name FROM claim_locks WHERE name = ?${forUpdate}`, [CLAIM_LOCK]);
      const [answered] = await tx.all("SELECT resume_at FROM claim_pauses WHERE name = ?", [MODEL_ANSWERED]);
      if (!stallInEffect(due, answered?.resume_at as Timestamp | undefined) || next <= due) return { taken: false };
      const taken = await tx.run("UPDATE claim_pauses SET resume_at = ? WHERE name = ? AND resume_at = ?", [next, MODEL_STALL, due]);
      return { taken: taken === 1 };
    });
  }

  // Worker pauses (design §5 Pause)

  async pauseWorkers(input: { count: number } | { all: true }, by: string): Promise<{ paused: (WorkerId | "*")[] }> {
    const { seq, forUpdate } = this.db.dialect;
    return this.db.transaction(async (tx) => {
      const now = this.now();
      if ("all" in input) {
        return { paused: (await this.insertOnce(tx, PAUSE_INSERT, [ALL_WORKERS, by, now])) ? [ALL_WORKERS] : [] };
      }
      // Under the claim lock, so no claim moves a run to running between the read and the pause rows.
      await tx.all(`SELECT name FROM claim_locks WHERE name = ?${forUpdate}`, [CLAIM_LOCK]);
      const already = new Set((await tx.all("SELECT worker_id FROM worker_pauses")).map((r) => r.worker_id as string));
      const running = await tx.all(
        `SELECT lease_owner FROM runs WHERE status = 'running' AND lease_owner IS NOT NULL AND kind <> ? ORDER BY started_at DESC, ${seq} DESC`,
        [INTERACTIVE],
      );
      const paused: WorkerId[] = [];
      for (const r of running) {
        const owner = r.lease_owner as WorkerId;
        if (paused.length >= input.count) break;
        if (already.has(owner) || paused.includes(owner)) continue;
        if (await this.insertOnce(tx, PAUSE_INSERT, [owner, by, now])) paused.push(owner);
      }
      return { paused };
    });
  }

  async resumeWorkers(): Promise<{ cleared: number }> {
    return this.db.transaction(async (tx) => ({ cleared: await tx.run("DELETE FROM worker_pauses") }));
  }

  async workerPause(worker_id: WorkerId): Promise<WorkerPause | null> {
    const rows = (await this.db.all("SELECT * FROM worker_pauses WHERE worker_id IN (?, ?)", [worker_id, ALL_WORKERS])).map(rowToWorkerPause);
    return rows.find((p) => p.worker_id === worker_id) ?? rows[0] ?? null;
  }

  async listWorkerPauses(): Promise<WorkerPause[]> {
    return (await this.db.all(`SELECT * FROM worker_pauses ORDER BY paused_at, ${this.db.dialect.seq}`)).map(rowToWorkerPause);
  }

  async pauseRun(
    runId: RunId,
    token: number,
    pause: { paused_by: string; session_id: string | null; resume: RunResume },
  ): Promise<LeaseResult> {
    return this.db.transaction(async (tx) => {
      const now = this.now();
      // Conditional on status and token, like completeRun. attempt is left as it is: the resuming claim adds nothing.
      const paused = await tx.run(
        `UPDATE runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, not_before = NULL,
           paused_at = ?, paused_by = ?, session_id = ?, pause_state = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_token = ?`,
        [now, pause.paused_by, pause.session_id, JSON.stringify(pause.resume), now, runId, token],
      );
      if (paused === 1) await this.closeAttempt(tx, runId, token, "paused", now);
      return paused === 1 ? { ok: true, run: (await this.selectRun(tx, runId))! } : { ok: false, reason: "lease_lost" };
    });
  }

  // Lease checks below test status and token only, never lease_expires_at. Fencing comes from the token:
  // the reaper moves an expired run out of 'running' and only a claim bumps lease_token. So a holder whose
  // lease ran out (host sleep) but was not reaped yet can still renew and finish (design §5).
  async heartbeat(runId: RunId, token: number, lease_ms: number): Promise<LeaseResult> {
    return this.db.transaction(async (tx) => {
      const now = this.now();
      const extended = await tx.run(
        `UPDATE runs SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_token = ?`,
        [this.after(lease_ms), now, runId, token],
      );
      return extended === 1 ? { ok: true, run: (await this.selectRun(tx, runId))! } : { ok: false, reason: "lease_lost" };
    });
  }

  async completeRun(runId: RunId, token: number, outcome: RunOutcome): Promise<LeaseResult> {
    return this.db.transaction(async (tx) => {
      const now = this.now();
      const completed = await tx.run(
        `UPDATE runs SET status = ?, outcome = ?, lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_token = ?`,
        [outcome.status, JSON.stringify(outcome), now, now, runId, token],
      );
      if (completed === 1) await this.closeAttempt(tx, runId, token, outcome.status, now, outcome);
      return completed === 1 ? { ok: true, run: (await this.selectRun(tx, runId))! } : { ok: false, reason: "lease_lost" };
    });
  }

  async listUnacknowledgedRuns(limit: number): Promise<Run[]> {
    const rows = await this.db.all(
      `SELECT * FROM runs WHERE status IN ('succeeded', 'failed', 'cancelled') AND acknowledged_at IS NULL
       ORDER BY updated_at, ${this.db.dialect.seq} LIMIT ?`,
      [limit],
    );
    return rows.map(rowToRun);
  }

  async expireLeases(
    max_attempts: number,
    backoff_ms?: (attempt: number) => number,
    onAbandoned?: (attempt: AbandonedAttempt) => void,
  ): Promise<RunId[]> {
    const { forUpdateSkipLocked } = this.db.dialect;
    const { ids, abandoned } = await this.db.transaction(async (tx) => {
      const now = this.now();
      // A run another reaper holds right now is left for the next tick. started_at and updated_at (the last
      // heartbeat on a running run) are read here, before this transaction's write rewrites updated_at.
      const expired = await tx.all(
        `SELECT id, kind, attempt, lease_token, work_item_id, started_at, updated_at FROM runs
         WHERE status = 'running' AND lease_expires_at <= ?${forUpdateSkipLocked}`,
        [now],
      );
      const failed: RunOutcome = {
        status: "failed",
        error_code: "lease_expired",
        detail: `lease expired after ${max_attempts} attempts`,
        infra: true,
      };
      const abandoned: AbandonedAttempt[] = [];
      for (const run of expired) {
        const item = await this.selectItem(tx, run.work_item_id as WorkItemId);
        let outcome: AbandonedAttempt["outcome"];
        let moved: number;
        if (item?.stage === "CLOSED") {
          // A closed item never runs again: its expired run is cancelled, not requeued.
          outcome = "cancelled";
          moved = await tx.run(
            `UPDATE runs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'running'`,
            [now, run.id as string],
          );
        } else if (run.kind === INTERACTIVE) {
          // A closed terminal does not come back (design §5, 2026-11-01): never requeued, whatever the attempt count.
          const lost: RunOutcome = { status: "failed", error_code: SESSION_LOST, detail: "the session's lease expired", infra: false };
          outcome = "failed";
          moved = await tx.run(
            "UPDATE runs SET status = 'failed', outcome = ?, lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
            [JSON.stringify(lost), now, now, run.id as string],
          );
          if (moved === 1) {
            abandoned.push(abandonedAttempt(run, outcome));
            await this.closeAttempt(tx, run.id as RunId, Number(run.lease_token), "failed", now, lost);
          }
          continue;
        } else if (Number(run.attempt) >= max_attempts) {
          outcome = "failed";
          moved = await tx.run(
            `UPDATE runs SET status = 'failed', outcome = ?, lease_owner = NULL, lease_expires_at = NULL, finished_at = ?,
               updated_at = ?
             WHERE id = ? AND status = 'running'`,
            [JSON.stringify(failed), now, now, run.id as string],
          );
        } else {
          // Same backoff as any other retry, so a lasting outage does not use up the attempts at once.
          const not_before = backoff_ms ? this.after(backoff_ms(Number(run.attempt))) : null;
          outcome = "queued";
          moved = await tx.run(
            `UPDATE runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, not_before = ?, updated_at = ?
             WHERE id = ? AND status = 'running'`,
            [not_before, now, run.id as string],
          );
        }
        // Only a run this update changed was cut off here (issue #210): one abandoned attempt, never two. Whatever
        // happens to the run, the claim whose lease ran out ended there (design §6).
        if (moved === 1) {
          abandoned.push(abandonedAttempt(run, outcome));
          await this.closeAttempt(tx, run.id as RunId, Number(run.lease_token), "lease_expired", now);
        }
      }
      return { ids: expired.map((r) => r.id as RunId), abandoned };
    });
    // After the commit, so a rolled-back expiry reports nothing.
    if (onAbandoned) for (const a of abandoned) onAbandoned(a);
    return ids;
  }

  async getRun(id: RunId): Promise<Run | null> {
    return this.selectRun(this.db, id);
  }

  // Interactive sessions (design §5, 2026-11-01)

  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    const { forUpdate, seq } = this.db.dialect;
    return this.db.transaction(async (tx): Promise<StartSessionResult> => {
      // The claim lock first, as claimRun takes it: no claim moves a run to running between these checks and the insert.
      await tx.all(`SELECT name FROM claim_locks WHERE name = ?${forUpdate}`, [CLAIM_LOCK]);
      const current = await this.selectItem(tx, input.id, forUpdate);
      if (!current) return { ok: false, reason: "not_found" };
      if (current.version !== input.expected_version) return { ok: false, reason: "version_conflict", current };
      const own = await tx.all(`SELECT id, kind, status FROM runs WHERE work_item_id = ? AND status IN ('queued', 'running') ORDER BY created_at, ${seq}`, [input.id]);
      const open = own.find((r) => r.kind === INTERACTIVE && r.status === "running");
      if (open) return { ok: false, reason: "session_open", run_id: open.id as RunId };
      const writer = own.find((r) => (IMPLEMENT_KINDS as readonly string[]).includes(r.kind as string));
      if (writer) return { ok: false, reason: "implement_run", run_id: writer.id as RunId };
      for (const o of await this.runningPaths(tx, [...IMPLEMENT_KINDS, INTERACTIVE])) {
        const paths = pathsOverlap(input.patch.allowed_paths ?? current.allowed_paths, parseList(o.allowed_paths));
        if (o.work_item_id !== input.id && paths.length > 0) {
          return { ok: false, reason: "overlap", work_item_id: o.work_item_id as WorkItemId, run_id: o.id as RunId, paths };
        }
      }
      const runId = newId("run") as RunId;
      const now = this.now();
      const session: SessionRecord = { notes: [], last_finish: null };
      await tx.run(
        `INSERT INTO runs (id, work_item_id, kind, idempotency_key, status, attempt, lease_owner, lease_token, lease_expires_at, input, actor_id,
           transcript_url, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', 1, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        [runId, input.id, INTERACTIVE, `${input.id}:interactive:${runId}`, input.owner, this.after(input.lease_ms),
          JSON.stringify({ session } satisfies RunInput), input.actor.id, input.transcript_url, now, now, now],
      );
      // A session start is the run's one claim (design §6): it gets its attempt record like any claim.
      await this.openAttempt(tx, (await this.selectRun(tx, runId))!, now);
      const { changes, sets, values } = diffPatch(current, input.patch);
      const version = current.version + 1;
      await tx.run(`UPDATE work_items SET ${[...sets, "version = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`, [
        ...values, version, now, input.id, input.expected_version,
      ]);
      const state_change = await this.insertStateChange(tx, input.id, version, input.actor, input.reason, changes, { ...input.detail, run_id: runId });
      const cancelled: RunId[] = [];
      for (const r of own.filter((x) => x.kind === "triage")) {
        const n = await tx.run("UPDATE runs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'", [now, r.id as string]);
        if (n === 1) cancelled.push(r.id as RunId);
      }
      return { ok: true, item: (await this.selectItem(tx, input.id))!, run: (await this.selectRun(tx, runId))!, state_change, cancelled };
    });
  }

  async updateSession(runId: RunId, token: number, update: SessionUpdate): Promise<LeaseResult> {
    return this.db.transaction(async (tx): Promise<LeaseResult> => {
      const run = await this.selectRun(tx, runId, this.db.dialect.forUpdate);
      const s = run?.input?.session;
      if (!run || !s || run.status !== "running" || run.lease?.token !== token) return { ok: false, reason: "lease_lost" };
      const now = this.now();
      const next: SessionRecord = {
        ...s,
        ...(update.note !== undefined ? { notes: [...s.notes, { at: now, text: update.note }].slice(-MAX_SESSION_NOTES) } : {}),
        ...(update.last_finish !== undefined ? { last_finish: { ...update.last_finish, at: now } } : {}),
      };
      await tx.run("UPDATE runs SET input = ?, session_tokens = ?, transcript_url = ?, updated_at = ? WHERE id = ?", [
        JSON.stringify({ ...run.input, session: next }), update.tokens ?? run.session_tokens, update.transcript_url ?? run.transcript_url, now, runId,
      ]);
      return { ok: true, run: (await this.selectRun(tx, runId))! };
    });
  }

  /** Running runs of `kinds` with their item's allowed_paths. */
  private runningPaths(tx: SqlExecutor, kinds: readonly RunKind[]): Promise<Row[]> {
    return tx.all(
      `SELECT r.id, r.work_item_id, w.allowed_paths FROM runs r JOIN work_items w ON w.id = r.work_item_id
       WHERE r.status = 'running' AND r.kind IN (${placeholders(kinds.length)}) ORDER BY r.created_at, r.${this.db.dialect.seq}`,
      [...kinds],
    );
  }

  async listRunsByKind(kind: RunKind, statuses: readonly RunStatus[]): Promise<Run[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db.all(
      `SELECT * FROM runs WHERE kind = ? AND status IN (${placeholders(statuses.length)}) ORDER BY created_at, ${this.db.dialect.seq}`,
      [kind, ...statuses],
    );
    return rows.map(rowToRun);
  }

  async listRuns(id: WorkItemId): Promise<Run[]> {
    const rows = await this.db.all(`SELECT * FROM runs WHERE work_item_id = ? ORDER BY created_at, ${this.db.dialect.seq}`, [id]);
    return rows.map(rowToRun);
  }

  async listRunAttempts(id: WorkItemId): Promise<RunAttempt[]> {
    const { seq } = this.db.dialect;
    const rows = await this.db.all(
      `SELECT a.* FROM run_attempts a JOIN runs r ON r.id = a.run_id WHERE r.work_item_id = ?
       ORDER BY r.created_at, r.${seq}, a.attempt`,
      [id],
    );
    return rows.map(rowToRunAttempt);
  }

  async listRunsByStatus(statuses: readonly RunStatus[], limit: number): Promise<Run[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db.all(
      `SELECT * FROM runs WHERE status IN (${placeholders(statuses.length)}) ORDER BY created_at, ${this.db.dialect.seq} LIMIT ?`,
      [...statuses, limit],
    );
    return rows.map(rowToRun);
  }

  async listRunsFinishedWithin(window_ms: number): Promise<Run[]> {
    const rows = await this.db.all(
      `SELECT * FROM runs WHERE finished_at IS NOT NULL AND finished_at >= ? ORDER BY finished_at DESC, ${this.db.dialect.seq} DESC`,
      [this.after(-window_ms)],
    );
    return rows.map(rowToRun);
  }

  async listRunsFinishedBetween(start: Timestamp, end: Timestamp): Promise<Run[]> {
    const rows = await this.db.all(
      `SELECT * FROM runs WHERE finished_at IS NOT NULL AND finished_at >= ? AND finished_at < ? ORDER BY finished_at, ${this.db.dialect.seq}`,
      [start, end],
    );
    return rows.map(rowToRun);
  }

  async enqueueRun(input: NewRun): Promise<{ run: Run; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const run = await this.insertRun(tx, input);
      if (run) return { run, created: true };
      const [row] = await tx.all("SELECT * FROM runs WHERE idempotency_key = ?", [input.idempotency_key]);
      return { run: rowToRun(row!), created: false };
    });
  }

  // Improve reports (design §7)

  async recordImproveReport(input: NewImproveReport): Promise<{ report: ImproveReport; created: boolean }> {
    const report: ImproveReport = { ...input, id: newId("ir") as ImproveReportId, created_at: this.now() };
    const created = await this.insertOnce(
      this.db,
      `INSERT INTO improve_reports (id, run_id, project_key, window_start, window_end, failure_groups, patterns, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        report.id, report.run_id, report.project, report.window_start, report.window_end,
        JSON.stringify(report.groups), JSON.stringify(report.patterns), report.created_at,
      ],
    );
    return created ? { report, created } : { report: (await this.getImproveReport(input.run_id))!, created };
  }

  async getImproveReport(run_id: RunId): Promise<ImproveReport | null> {
    const [row] = await this.db.all("SELECT * FROM improve_reports WHERE run_id = ?", [run_id]);
    return row ? rowToImproveReport(row) : null;
  }

  // Standing approvals (design 05-standing-approvals)

  async putStandingRule(input: NewStandingRule): Promise<StandingRule> {
    return this.db.transaction(async (tx) => {
      const now = this.now();
      const enabled = input.enabled ? 1 : 0;
      const inserted = await this.insertOnce(
        tx,
        "INSERT INTO standing_rules (gate, tier, enabled, set_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [input.gate, input.tier, enabled, input.set_by, now, now],
      );
      if (!inserted) {
        await tx.run("UPDATE standing_rules SET enabled = ?, set_by = ?, updated_at = ? WHERE gate = ? AND tier = ?", [
          enabled, input.set_by, now, input.gate, input.tier,
        ]);
      }
      const [row] = await tx.all("SELECT * FROM standing_rules WHERE gate = ? AND tier = ?", [input.gate, input.tier]);
      return rowToStandingRule(row!);
    });
  }

  async listStandingRules(): Promise<StandingRule[]> {
    return (await this.db.all("SELECT * FROM standing_rules ORDER BY gate, tier")).map(rowToStandingRule);
  }

  async recordStandingProposal(input: NewStandingProposal): Promise<{ proposal: StandingProposal; created: boolean }> {
    const proposal: StandingProposal = { ...input, id: newId("sp") as StandingProposalId, created_at: this.now() };
    const created = await this.insertOnce(
      this.db,
      "INSERT INTO standing_proposals (id, gate, tier, run_length, threshold, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [proposal.id, proposal.gate, proposal.tier, proposal.run_length, proposal.threshold, proposal.created_at],
    );
    if (created) return { proposal, created };
    const [row] = await this.db.all("SELECT * FROM standing_proposals WHERE gate = ? AND tier = ? AND run_length = ?", [
      input.gate, input.tier, input.run_length,
    ]);
    return { proposal: rowToStandingProposal(row!), created };
  }

  async listStandingProposals(): Promise<StandingProposal[]> {
    return (await this.db.all("SELECT * FROM standing_proposals ORDER BY gate, tier, run_length")).map(rowToStandingProposal);
  }

  // Coordination (design §5, 2026-11-03)

  async replaceDependencyEdges(id: WorkItemId, links: readonly DependencyLink[], read_at?: Timestamp): Promise<DependencyEdge[]> {
    return this.db.transaction(async (tx) => {
      const now = this.now();
      const wanted = new Map<string, DependencyLink>();
      for (const l of links) if (!wanted.has(l.depends_on)) wanted.set(l.depends_on, l);
      const current = (await tx.all("SELECT depends_on FROM dependency_edges WHERE work_item_id = ?", [id])).map((r) => r.depends_on as string);
      for (const d of current) {
        if (!wanted.has(d)) await tx.run("DELETE FROM dependency_edges WHERE work_item_id = ? AND depends_on = ?", [id, d]);
      }
      for (const l of wanted.values()) {
        await this.insertOnce(
          tx,
          "INSERT INTO dependency_edges (work_item_id, depends_on, kind, state, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?)",
          [id, l.depends_on, l.kind, now, now],
        );
      }
      if (read_at !== undefined) {
        await tx.run("UPDATE dependency_edges SET source_updated_at = ? WHERE work_item_id = ?", [read_at, id]);
        await tx.run("UPDATE work_items SET edges_source_updated_at = ? WHERE id = ?", [read_at, id]);
      }
      const rows = await tx.all(`SELECT * FROM dependency_edges WHERE work_item_id = ? ORDER BY created_at, ${this.db.dialect.seq}`, [id]);
      return rows.map(rowToDependencyEdge);
    });
  }

  async dependencyLinksReadAt(id: WorkItemId): Promise<Timestamp | null> {
    const [row] = await this.db.all("SELECT edges_source_updated_at FROM work_items WHERE id = ?", [id]);
    return (row?.edges_source_updated_at as Timestamp | null | undefined) ?? null;
  }

  async markDependencyLinksStale(id: WorkItemId): Promise<void> {
    await this.db.run("UPDATE work_items SET edges_source_updated_at = NULL WHERE id = ?", [id]);
  }

  async listDependencyEdges(filter: { work_item_id?: WorkItemId; depends_on?: string } = {}): Promise<DependencyEdge[]> {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.work_item_id !== undefined) {
      where.push("work_item_id = ?");
      params.push(filter.work_item_id);
    }
    if (filter.depends_on !== undefined) {
      where.push("depends_on = ?");
      params.push(filter.depends_on);
    }
    const rows = await this.db.all(
      `SELECT * FROM dependency_edges${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, ${this.db.dialect.seq}`,
      params,
    );
    return rows.map(rowToDependencyEdge);
  }

  async setDependencyState(id: WorkItemId, depends_on: string, state: DependencyState): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.all("SELECT state FROM dependency_edges WHERE work_item_id = ? AND depends_on = ?", [id, depends_on]);
      if (!row) return false;
      if (row.state !== state) {
        await tx.run("UPDATE dependency_edges SET state = ?, updated_at = ? WHERE work_item_id = ? AND depends_on = ?", [
          state, this.now(), id, depends_on,
        ]);
      }
      return true;
    });
  }

  async recordConflicts(input: RecordConflictsInput): Promise<number> {
    assertProjectKey(input.project);
    const paths = [...new Set(input.paths.filter((p) => p.length > 0))];
    if (paths.length === 0) return 0;
    return this.db.transaction(async (tx) => {
      let n = 0;
      for (const path of paths) {
        const inserted = await this.insertOnce(tx, "INSERT INTO file_conflicts (project_key, path, event_key, at) VALUES (?, ?, ?, ?)", [
          input.project, path, input.event_key, this.now(),
        ]);
        if (inserted) n++;
      }
      return n;
    });
  }

  async conflictCounts(project: string): Promise<Map<string, number>> {
    const rows = await this.db.all("SELECT path, COUNT(*) AS n FROM file_conflicts WHERE project_key = ? GROUP BY path", [project]);
    return new Map(rows.map((r) => [r.path as string, Number(r.n)]));
  }

  async listClaimDecisions(id: WorkItemId): Promise<ClaimDecision[]> {
    const rows = await this.db.all(`SELECT * FROM claim_decisions WHERE work_item_id = ? ORDER BY at, ${this.db.dialect.seq}`, [id]);
    return rows.map(rowToClaimDecision);
  }

  async listLatestClaimDecisions(ids: readonly WorkItemId[]): Promise<Map<WorkItemId, ClaimDecision>> {
    const out = new Map<WorkItemId, ClaimDecision>();
    if (ids.length === 0) return out;
    const rows = await this.db.all(
      `SELECT * FROM claim_decisions WHERE work_item_id IN (${placeholders(ids.length)}) ORDER BY at, ${this.db.dialect.seq}`,
      [...ids],
    );
    for (const row of rows) {
      const d = rowToClaimDecision(row);
      out.set(d.work_item_id, d); // oldest first: the last one wins
    }
    return out;
  }

  async approveClaimHold(input: ApproveClaimHoldInput): Promise<ApproveClaimHoldResult> {
    const { forUpdate } = this.db.dialect;
    return this.db.transaction(async (tx): Promise<ApproveClaimHoldResult> => {
      const [row] = await tx.all(
        `SELECT d.* FROM claim_decisions d JOIN runs r ON r.id = d.run_id
         WHERE d.run_id = ? AND d.work_item_id = ? AND d.decision = 'held' AND d.approved_by IS NULL AND r.status = 'queued'${forUpdate}`,
        [input.run_id, input.id],
      );
      if (!row) return { ok: false, reason: "not_held" };
      const held = rowToClaimDecision(row);
      const r = await this.applyTransition(tx, {
        id: input.id,
        expected_version: input.expected_version,
        patch: {},
        actor: input.actor,
        reason: "coordination_approved",
        detail: { run_id: input.run_id, holder: held.holder_ref, cost: held.cost, threshold: held.threshold },
      });
      if (!r.ok) return r;
      await tx.run("UPDATE claim_decisions SET approved_by = ? WHERE run_id = ?", [input.actor.id, input.run_id]);
      const [after] = await tx.all("SELECT * FROM claim_decisions WHERE run_id = ?", [input.run_id]);
      return { ok: true, item: r.item, state_change: r.state_change, decision: rowToClaimDecision(after!) };
    });
  }

  // PR heads

  async recordPushedHead(runId: RunId, token: number, head_sha: string): Promise<{ ok: true } | { ok: false; reason: "lease_lost" }> {
    const { forShare } = this.db.dialect;
    return this.db.transaction(async (tx) => {
      // FOR SHARE, as appendHandoff: the run stays `running` with this token until this commits.
      const [held] = await tx.all(
        `SELECT work_item_id FROM runs WHERE id = ? AND status = 'running' AND lease_token = ?${forShare}`,
        [runId, token],
      );
      if (!held) return { ok: false, reason: "lease_lost" };
      await tx.run("UPDATE work_items SET last_head_sha = ? WHERE id = ?", [head_sha, held.work_item_id as string]);
      return { ok: true };
    });
  }

  async recordPrHead(input: RecordPrHeadInput): Promise<RecordPrHeadResult> {
    const { forUpdate } = this.db.dialect;
    return this.db.transaction(async (tx): Promise<RecordPrHeadResult> => {
      const current = await this.selectItem(tx, input.id, forUpdate);
      if (!current) return { ok: false, reason: "not_found" };
      if (current.last_head_sha !== input.expected_head) return { ok: false, reason: "head_moved", current };
      const moved = await tx.run(
        `UPDATE work_items SET last_head_sha = ? WHERE id = ? AND ${input.expected_head === null ? "last_head_sha IS NULL" : "last_head_sha = ?"}`,
        input.expected_head === null ? [input.head_sha, input.id] : [input.head_sha, input.id, input.expected_head],
      );
      if (moved !== 1) return { ok: false, reason: "head_moved", current };
      let run: Run | null = null;
      if (input.manual && input.expected_head !== null) {
        const now = this.now();
        const outcome: RunOutcome = {
          status: "succeeded",
          summary: "a person pushed to the PR branch",
          data: { actor: input.manual.actor, from_sha: input.expected_head, to_sha: input.head_sha, pr_number: input.manual.pr_number },
        };
        const id = newId("run") as RunId;
        // Written finished and acknowledged: never queued, so no claim returns it and the controller applies nothing.
        const inserted = await this.insertOnce(
          tx,
          `INSERT INTO runs (id, work_item_id, kind, idempotency_key, status, attempt, lease_token, outcome, acknowledged_at,
             started_at, finished_at, created_at, updated_at)
           VALUES (?, ?, 'manual', ?, 'succeeded', 0, 0, ?, ?, ?, ?, ?, ?)`,
          [id, input.id, `${input.id}:manual:${input.expected_head}..${input.head_sha}`, JSON.stringify(outcome), now, now, now, now, now],
        );
        run = inserted ? await this.selectRun(tx, id) : null;
      }
      return { ok: true, item: (await this.selectItem(tx, input.id))!, run };
    });
  }

  // Unreviewed merges

  async recordUnreviewedMerge(input: NewUnreviewedMerge): Promise<{ merge: UnreviewedMerge; created: boolean }> {
    assertProjectKey(input.project);
    return this.db.transaction(async (tx) => {
      const created = await this.insertOnce(
        tx,
        "INSERT INTO unreviewed_merges (id, project, pr_number, merge_sha, merger_id, at) VALUES (?, ?, ?, ?, ?, ?)",
        [newId("um") as UnreviewedMergeId, input.project, input.pr_number, input.merge_sha, input.merger_id, this.now()],
      );
      const [row] = await tx.all("SELECT * FROM unreviewed_merges WHERE project = ? AND pr_number = ?", [input.project, input.pr_number]);
      return { merge: rowToUnreviewedMerge(row!), created };
    });
  }

  async listUnreviewedMerges(limit: number): Promise<UnreviewedMerge[]> {
    const rows = await this.db.all(`SELECT * FROM unreviewed_merges ORDER BY at DESC, ${this.db.dialect.seq} DESC LIMIT ?`, [limit]);
    return rows.map(rowToUnreviewedMerge);
  }

  async countUnreviewedMergesSince(since: Timestamp): Promise<number> {
    const [row] = await this.db.all("SELECT COUNT(*) AS n FROM unreviewed_merges WHERE at >= ?", [since]);
    return Number(row!.n);
  }

  // Handoffs

  async appendHandoff(
    input: Omit<Handoff, "id" | "at">,
    token: number,
  ): Promise<{ ok: true; handoff: Handoff } | { ok: false; reason: "lease_lost" }> {
    const { forShare } = this.db.dialect;
    return this.db.transaction(async (tx) => {
      const now = this.now();
      // FOR SHARE: status and token are what fence the holder; the row lock keeps the reaper and a
      // completion from moving the run out of 'running' (and a reclaim from bumping the token) until this commits.
      const [holds] = await tx.all(
        `SELECT 1 AS held FROM runs WHERE id = ? AND work_item_id = ? AND status = 'running' AND lease_token = ?${forShare}`,
        [input.run_id, input.work_item_id, token],
      );
      if (!holds) return { ok: false, reason: "lease_lost" };
      await this.insertOnce(
        tx,
        `INSERT INTO handoffs (id, run_id, work_item_id, commit_sha, worked_on, next_steps, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId("ho"), input.run_id, input.work_item_id, input.commit_sha, input.worked_on, input.next_steps, now],
      );
      const [row] = await tx.all("SELECT * FROM handoffs WHERE run_id = ? AND commit_sha = ?", [input.run_id, input.commit_sha]);
      return { ok: true, handoff: rowToHandoff(row!) };
    });
  }

  async listHandoffs(id: WorkItemId): Promise<Handoff[]> {
    const rows = await this.db.all(`SELECT * FROM handoffs WHERE work_item_id = ? ORDER BY at, ${this.db.dialect.seq}`, [id]);
    return rows.map(rowToHandoff);
  }

  // Cursors

  async getCursor(name: string): Promise<string | null> {
    const [row] = await this.db.all("SELECT value FROM cursors WHERE name = ?", [name]);
    return (row?.value as string | undefined) ?? null;
  }

  async advanceCursor(name: string, expected: string | null, next: string): Promise<boolean> {
    return this.db.transaction(async (tx) =>
      expected === null
        ? this.insertOnce(tx, "INSERT INTO cursors (name, value) VALUES (?, ?)", [name, next])
        : (await tx.run("UPDATE cursors SET value = ? WHERE name = ? AND value = ?", [next, name, expected])) === 1,
    );
  }

  // Stream intake

  async appendInbox(input: NewInboxEvent): Promise<AppendInboxResult> {
    const { forUpdate } = this.db.dialect;
    return this.db.transaction(async (tx): Promise<AppendInboxResult> => {
      // FOR UPDATE on the lease row: a takeover (token + 1) waits for this append to commit, and appends of
      // one source type commit one at a time, so their seqs commit in order and a cursor never skips one.
      const [held] = await tx.all(
        `SELECT token FROM listener_leases WHERE source_type = ? AND token = ?${forUpdate}`,
        [input.source_type, input.lease_token],
      );
      if (!held) return { ok: false, reason: "lease_lost" };
      const existing = await this.selectInbox(tx, input.source_type, input.dedupe_key);
      if (existing) return { ok: true, row: existing, duplicate: true };
      const inserted = await this.insertOnce(
        tx,
        "INSERT INTO source_inbox (source_type, dedupe_key, event, received_at) VALUES (?, ?, ?, ?)",
        [input.source_type, input.dedupe_key, JSON.stringify(input.event), this.now()],
      );
      const row = (await this.selectInbox(tx, input.source_type, input.dedupe_key))!;
      return { ok: true, row, duplicate: !inserted };
    });
  }

  async listInboxAfter(source_type: SourceType, after_seq: number, limit: number): Promise<InboxRow[]> {
    const rows = await this.db.all("SELECT * FROM source_inbox WHERE source_type = ? AND seq > ? ORDER BY seq LIMIT ?", [
      source_type, after_seq, limit,
    ]);
    return rows.map(rowToInbox);
  }

  async pruneInbox(source_type: SourceType, through_seq: number, older_than_ms: number): Promise<number> {
    return this.db.transaction((tx) =>
      tx.run("DELETE FROM source_inbox WHERE source_type = ? AND seq <= ? AND received_at < ?", [
        source_type, through_seq, this.after(-older_than_ms),
      ]),
    );
  }

  async acquireListenerLease(source_type: SourceType, owner: string, lease_ms: number): Promise<ListenerLeaseResult> {
    return this.db.transaction(async (tx): Promise<ListenerLeaseResult> => {
      const expires_at = this.after(lease_ms);
      const created = await this.insertOnce(
        tx,
        "INSERT INTO listener_leases (source_type, owner, token, expires_at) VALUES (?, ?, 1, ?)",
        [source_type, owner, expires_at],
      );
      if (created) return { ok: true, lease: { source_type, owner, token: 1, expires_at } };
      // Conditional: only an expired (or released) lease can be taken, and taking it bumps the token.
      const taken = await tx.run(
        "UPDATE listener_leases SET owner = ?, token = token + 1, expires_at = ? WHERE source_type = ? AND expires_at <= ?",
        [owner, expires_at, source_type, this.now()],
      );
      const lease = await this.selectListenerLease(tx, source_type);
      return taken === 1 ? { ok: true, lease: lease! } : { ok: false, reason: "held", holder: lease };
    });
  }

  async renewListenerLease(source_type: SourceType, token: number, lease_ms: number): Promise<ListenerLeaseResult> {
    return this.db.transaction(async (tx): Promise<ListenerLeaseResult> => {
      const renewed = await tx.run("UPDATE listener_leases SET expires_at = ? WHERE source_type = ? AND token = ?", [
        this.after(lease_ms), source_type, token,
      ]);
      const lease = await this.selectListenerLease(tx, source_type);
      return renewed === 1 ? { ok: true, lease: lease! } : { ok: false, reason: "lease_lost", holder: lease };
    });
  }

  async releaseListenerLease(source_type: SourceType, token: number): Promise<void> {
    await this.db.transaction((tx) =>
      tx.run("UPDATE listener_leases SET expires_at = ? WHERE source_type = ? AND token = ?", [this.now(), source_type, token]),
    );
  }

  // Identity links (design 2026-11-01)

  async resolveLink(provider: LinkedAccount["provider"], subject: string): Promise<UserId | null> {
    const [row] = await this.db.all("SELECT user_id FROM user_links WHERE provider = ? AND subject = ?", [provider, subject]);
    return row ? (String(row.user_id) as UserId) : null;
  }

  async listLinks(user_id: UserId): Promise<LinkedAccount[]> {
    const rows = await this.db.all(
      `SELECT provider, subject FROM user_links WHERE user_id = ? ORDER BY created_at, ${this.db.dialect.seq}`,
      [user_id],
    );
    return rows.map((r) => ({ provider: String(r.provider) as LinkedAccount["provider"], subject: String(r.subject) }));
  }

  async createLinkCode(user_id: UserId, code: string): Promise<{ expires_at: Timestamp }> {
    const expires_at = this.after(LINK_CODE_TTL_MS);
    await this.db.transaction((tx) =>
      tx.run("INSERT INTO link_codes (code_hash, user_id, expires_at, failures, created_at) VALUES (?, ?, ?, 0, ?)", [
        hashCode(code), user_id, expires_at, this.now(),
      ]),
    );
    return { expires_at };
  }

  async redeemLinkCode(code: string, account: LinkedAccount): Promise<RedeemLinkResult> {
    const now = this.now();
    return this.db.transaction(async (tx): Promise<RedeemLinkResult> => {
      const [row] = await tx.all(`SELECT * FROM link_codes WHERE code_hash = ?${this.db.dialect.forUpdate}`, [hashCode(code)]);
      const user_id = row ? (String(row.user_id) as UserId) : null;
      if (row && row.used_at !== null && row.used_provider === account.provider && row.used_subject === account.subject) {
        return { ok: true, user_id: user_id! };
      }
      const reason = !row ? "invalid" : row.used_at !== null ? "used" : String(row.expires_at) <= now ? "expired"
        : Number(row.failures) >= LINK_CODE_MAX_FAILURES ? "locked" : null;
      if (reason !== null) {
        // A failed attempt counts against every live code, so guessing cannot outlast the lock.
        await tx.run("UPDATE link_codes SET failures = failures + 1 WHERE used_at IS NULL AND expires_at > ?", [now]);
        return { ok: false, reason };
      }
      const [linked] = await tx.all("SELECT user_id FROM user_links WHERE provider = ? AND subject = ?", [account.provider, account.subject]);
      if (linked && linked.user_id !== user_id) return { ok: false, reason: "already_linked" };
      if (!linked) {
        await tx.run("INSERT INTO user_links (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)", [
          account.provider, account.subject, user_id, now,
        ]);
      }
      await tx.run("UPDATE link_codes SET used_at = ?, used_provider = ?, used_subject = ? WHERE code_hash = ?", [
        now, account.provider, account.subject, row!.code_hash as string,
      ]);
      return { ok: true, user_id: user_id! };
    });
  }

  // Local users (issue #318)

  async getLocalUser(user_id: UserId): Promise<LocalUser | null> {
    const [row] = await this.db.all("SELECT * FROM local_users WHERE user_id = ?", [user_id]);
    return row ? rowToLocalUser(row) : null;
  }

  async listLocalUsers(): Promise<LocalUser[]> {
    const rows = await this.db.all("SELECT * FROM local_users ORDER BY CASE WHEN owner_slot = 1 THEN 0 ELSE 1 END, created_at, user_id");
    return rows.map(rowToLocalUser);
  }

  async claimLocalOwner(user_id: UserId): Promise<LocalUser> {
    const owner = async () => {
      const [row] = await this.db.all("SELECT * FROM local_users WHERE owner_slot = 1");
      return row ? rowToLocalUser(row) : null;
    };
    const now = this.now();
    try {
      return await this.db.transaction(async (tx): Promise<LocalUser> => {
        const [held] = await tx.all(`SELECT * FROM local_users WHERE owner_slot = 1${this.db.dialect.forUpdate}`);
        if (held) return rowToLocalUser(held);
        const updated = await tx.run("UPDATE local_users SET role = 'owner', owner_slot = 1, added_by = ? WHERE user_id = ?", [user_id, user_id]);
        if (updated === 0) {
          await tx.run("INSERT INTO local_users (user_id, role, owner_slot, added_by, created_at) VALUES (?, 'owner', 1, ?, ?)", [user_id, user_id, now]);
        }
        const [row] = await tx.all("SELECT * FROM local_users WHERE user_id = ?", [user_id]);
        return rowToLocalUser(row!);
      });
    } catch (err) {
      // Another claim won the one owner slot first (unique `owner_slot`): that owner stands.
      const won = await owner();
      if (won) return won;
      throw err;
    }
  }

  async setLocalUserRole(
    user_id: UserId, role: Exclude<LocalRole, "owner">, added_by: UserId,
  ): Promise<{ ok: true; created: boolean } | { ok: false; reason: "owner" }> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const [row] = await tx.all(`SELECT role FROM local_users WHERE user_id = ?${this.db.dialect.forUpdate}`, [user_id]);
      if (row && row.role === "owner") return { ok: false as const, reason: "owner" as const };
      if (row) {
        await tx.run("UPDATE local_users SET role = ?, added_by = ? WHERE user_id = ?", [role, added_by, user_id]);
        return { ok: true as const, created: false };
      }
      await tx.run("INSERT INTO local_users (user_id, role, owner_slot, added_by, created_at) VALUES (?, ?, NULL, ?, ?)", [user_id, role, added_by, now]);
      return { ok: true as const, created: true };
    });
  }

  async removeLocalUser(user_id: UserId): Promise<"removed" | "missing" | "owner"> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.all(`SELECT role FROM local_users WHERE user_id = ?${this.db.dialect.forUpdate}`, [user_id]);
      if (!row) return "missing" as const;
      if (row.role === "owner") return "owner" as const;
      await tx.run("DELETE FROM local_users WHERE user_id = ?", [user_id]);
      return "removed" as const;
    });
  }

  // Runtime settings overrides (design 2026-11-03)

  async listSettingOverrides(): Promise<SettingOverride[]> {
    const rows = await this.db.all("SELECT * FROM settings_overrides ORDER BY setting_key, project_key");
    return rows.map(rowToOverride);
  }

  async setSettingOverride(input: SetSettingInput): Promise<SettingChange> {
    const at = this.now();
    return this.db.transaction(async (tx) => {
      const old = await this.selectOverride(tx, input.key, input.project);
      if (old) {
        await tx.run("UPDATE settings_overrides SET value_json = ?, set_by = ?, set_at = ? WHERE setting_key = ? AND project_key = ?", [
          input.value, input.actor, at, input.key, input.project,
        ]);
      } else {
        await tx.run("INSERT INTO settings_overrides (setting_key, project_key, value_json, set_by, set_at) VALUES (?, ?, ?, ?, ?)", [
          input.key, input.project, input.value, input.actor, at,
        ]);
      }
      return this.insertSettingChange(tx, input.key, input.project, old?.value ?? null, input.value, input.actor, at);
    });
  }

  async resetSettingOverride(input: ResetSettingInput): Promise<SettingChange | null> {
    const at = this.now();
    return this.db.transaction(async (tx) => {
      const old = await this.selectOverride(tx, input.key, input.project);
      if (!old) return null;
      const n = await tx.run("DELETE FROM settings_overrides WHERE setting_key = ? AND project_key = ?", [input.key, input.project]);
      if (n === 0) return null;
      return this.insertSettingChange(tx, input.key, input.project, old.value, null, input.actor, at);
    });
  }

  async listSettingChanges(limit: number): Promise<SettingChange[]> {
    const rows = await this.db.all(`SELECT * FROM settings_changes ORDER BY seq DESC LIMIT ${Math.max(0, Math.floor(limit))}`);
    return rows.map(rowToSettingChange);
  }

  private async selectOverride(tx: SqlExecutor, key: string, project: string): Promise<SettingOverride | null> {
    const [row] = await tx.all(`SELECT * FROM settings_overrides WHERE setting_key = ? AND project_key = ?${this.db.dialect.forUpdate}`, [key, project]);
    return row ? rowToOverride(row) : null;
  }

  private async insertSettingChange(
    tx: SqlExecutor, key: string, project: string, old_value: string | null, new_value: string | null, actor: string, at: Timestamp,
  ): Promise<SettingChange> {
    await tx.run("INSERT INTO settings_changes (setting_key, project_key, old_value, new_value, actor, at) VALUES (?, ?, ?, ?, ?, ?)", [
      key, project, old_value, new_value, actor, at,
    ]);
    const [row] = await tx.all("SELECT * FROM settings_changes WHERE setting_key = ? AND project_key = ? ORDER BY seq DESC LIMIT 1", [key, project]);
    return rowToSettingChange(row!);
  }

  // Merge checks (design §5 Merge check, issue #248): one latest row per item, replaced on each check.

  async recordMergeCheck(c: NewMergeCheck): Promise<MergeCheck> {
    const checked_at = this.now();
    const values: SqlValue[] = [c.mergeable ? 1 : 0, JSON.stringify(c.conflicts), c.head_sha, c.base_sha, checked_at];
    const update = () =>
      this.db.run(
        "UPDATE merge_checks SET mergeable = ?, conflicts = ?, head_sha = ?, base_sha = ?, checked_at = ? WHERE work_item_id = ?",
        [...values, c.work_item_id],
      );
    // Keyed by work_item_id: update the row, else insert it; a concurrent first insert that loses updates instead.
    if ((await update()) === 0) {
      try {
        await this.db.run(
          "INSERT INTO merge_checks (mergeable, conflicts, head_sha, base_sha, checked_at, work_item_id) VALUES (?, ?, ?, ?, ?, ?)",
          [...values, c.work_item_id],
        );
      } catch (err) {
        if (!this.db.isDuplicateKey(err)) throw err;
        await update();
      }
    }
    return { ...c, conflicts: [...c.conflicts], checked_at };
  }

  async getMergeCheck(work_item_id: WorkItemId): Promise<MergeCheck | null> {
    const [row] = await this.db.all("SELECT * FROM merge_checks WHERE work_item_id = ?", [work_item_id]);
    return row ? rowToMergeCheck(row) : null;
  }

  async listMergeChecks(work_item_ids: readonly WorkItemId[]): Promise<MergeCheck[]> {
    if (work_item_ids.length === 0) return [];
    const rows = await this.db.all(`SELECT * FROM merge_checks WHERE work_item_id IN (${placeholders(work_item_ids.length)})`, [...work_item_ids]);
    return rows.map(rowToMergeCheck);
  }

  // GitHub sync records (design §5, GitHub call budget): posted comments and label states, shared by replicas.

  async getPostedComment(
    source_id: string, marker: string, body: string,
  ): Promise<(PostedComment & { same_body: boolean; waiting: boolean }) | null> {
    const [row] = await this.db.all("SELECT * FROM posted_comments WHERE source_id = ? AND marker = ?", [source_id, marker]);
    if (!row) return null;
    const c = rowToPostedComment(row);
    return { ...c, same_body: c.body_hash === bodyHash(body), waiting: c.next_attempt_at !== null && c.next_attempt_at > this.now() };
  }

  async recordPostedComment(c: NewPostedComment): Promise<void> {
    const now = this.now();
    const values: SqlValue[] = [c.comment_id, c.url, bodyHash(c.body), now];
    // A row of failed posts only gets the comment; a row that has one keeps it.
    const update = () =>
      this.db.run(
        `UPDATE posted_comments SET comment_id = ?, url = ?, body_hash = ?, attempts = 0, next_attempt_at = NULL, updated_at = ?
         WHERE source_id = ? AND marker = ? AND comment_id IS NULL`,
        [...values, c.source_id, c.marker],
      );
    if ((await update()) > 0) return;
    try {
      await this.db.run(
        `INSERT INTO posted_comments (comment_id, url, body_hash, attempts, next_attempt_at, created_at, updated_at, source_id, marker)
         VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?)`,
        [...values, now, c.source_id, c.marker],
      );
    } catch (err) {
      if (!this.db.isDuplicateKey(err)) throw err;
      await update();
    }
  }

  async recordCommentFailure(source_id: string, marker: string, attempts: number, delay_ms: number): Promise<boolean> {
    const now = this.now();
    const next_attempt_at = this.after(delay_ms);
    if (attempts === 1) {
      const inserted = await this.insertOnce(
        this.db,
        `INSERT INTO posted_comments (source_id, marker, comment_id, url, body_hash, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, NULL, 1, ?, ?, ?)`,
        [source_id, marker, next_attempt_at, now, now],
      );
      if (inserted) return true;
    }
    const changed = await this.db.run(
      "UPDATE posted_comments SET attempts = ?, next_attempt_at = ?, updated_at = ? WHERE source_id = ? AND marker = ? AND attempts = ?",
      [attempts, next_attempt_at, now, source_id, marker, attempts - 1],
    );
    return changed > 0;
  }

  async claimLabelWrite(source_id: string, target: LabelTarget, status: string, ttl_ms: number): Promise<string | null> {
    const token = newId("lbl");
    const now = this.now();
    const until = this.after(ttl_ms);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.all(
        `SELECT * FROM label_states WHERE source_id = ? AND target = ?${this.db.dialect.forUpdate}`, [source_id, target],
      );
      if (!row) {
        const inserted = await this.insertOnce(
          tx,
          `INSERT INTO label_states (source_id, target, status, claim_token, claim_status, claim_until, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?)`,
          [source_id, target, token, status, until, now],
        );
        // A concurrent first claim committed first: that write is under way.
        return inserted ? token : null;
      }
      if (row.status === status) return null;
      const held = row.claim_token !== null && row.claim_status === status && String(row.claim_until) > now;
      if (held) return null;
      // Conditional on the claim read, so of two replicas taking over the same row only one wins.
      const changed = await tx.run(
        `UPDATE label_states SET claim_token = ?, claim_status = ?, claim_until = ?, updated_at = ?
         WHERE source_id = ? AND target = ? AND ${row.claim_token === null ? "claim_token IS NULL" : "claim_token = ?"}`,
        [token, status, until, now, source_id, target, ...(row.claim_token === null ? [] : [row.claim_token as string])],
      );
      return changed > 0 ? token : null;
    });
  }

  async recordLabelState(source_id: string, target: LabelTarget, status: string, token: string): Promise<void> {
    await this.db.run(
      `UPDATE label_states SET status = ?, claim_token = NULL, claim_status = NULL, claim_until = NULL, updated_at = ?
       WHERE source_id = ? AND target = ? AND claim_token = ?`,
      [status, this.now(), source_id, target, token],
    );
  }

  async releaseLabelClaim(source_id: string, target: LabelTarget, token: string): Promise<void> {
    await this.db.run(
      "UPDATE label_states SET claim_token = NULL, claim_status = NULL, claim_until = NULL WHERE source_id = ? AND target = ? AND claim_token = ?",
      [source_id, target, token],
    );
  }

  async listLabelStates(source_ids: readonly string[]): Promise<LabelState[]> {
    const out: LabelState[] = [];
    // In chunks, so a long list stays under every backend's parameter limit.
    for (let i = 0; i < source_ids.length; i += 500) {
      const chunk = source_ids.slice(i, i + 500);
      const rows = await this.db.all(`SELECT * FROM label_states WHERE source_id IN (${placeholders(chunk.length)})`, [...chunk]);
      out.push(...rows.map(rowToLabelState));
    }
    return out;
  }

  // Worker processes (design §5 Coordination, 2026-11-07)

  async reportWorkerProcess(r: WorkerProcessReport): Promise<WorkerProcess> {
    const reported_at = this.now();
    const values: SqlValue[] = [r.pid, r.host, r.slots, r.max_slots, r.busy, r.index_base, r.started_at, reported_at];
    const update = () =>
      this.db.run(
        `UPDATE worker_processes SET pid = ?, host = ?, slots = ?, max_slots = ?, busy = ?, index_base = ?, started_at = ?, reported_at = ?
         WHERE process_id = ?`,
        [...values, r.process_id],
      );
    // Keyed by process_id: update the row, else insert it; a concurrent first insert that loses updates instead.
    if ((await update()) === 0) {
      try {
        await this.db.run(
          `INSERT INTO worker_processes (pid, host, slots, max_slots, busy, index_base, started_at, reported_at, process_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...values, r.process_id],
        );
      } catch (err) {
        if (!this.db.isDuplicateKey(err)) throw err;
        await update();
      }
    }
    return { ...r, reported_at };
  }

  async listWorkerProcesses(max_age_ms: number): Promise<WorkerProcess[]> {
    const since = new Date(this.clock.now().getTime() - max_age_ms).toISOString();
    const rows = await this.db.all("SELECT * FROM worker_processes WHERE reported_at >= ? ORDER BY host, pid, process_id", [since]);
    return rows.map(rowToWorkerProcess);
  }

  async removeWorkerProcess(process_id: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM worker_processes WHERE process_id = ?", [process_id])) > 0;
  }

  // Host sleeps (design §5 Host sleep, issue #218): one row per (worker_id, woke_at).

  async recordHostSleep(sleep: HostSleep): Promise<{ created: boolean; sleep: HostSleep }> {
    const existing = await this.selectHostSleep(sleep.worker_id, sleep.woke_at);
    if (existing) return { created: false, sleep: existing };
    const created = await this.insertOnce(
      this.db,
      "INSERT INTO host_sleeps (worker_id, woke_at, gap_ms, run_id) VALUES (?, ?, ?, ?)",
      [sleep.worker_id, sleep.woke_at, Math.round(sleep.gap_ms), sleep.run_id],
    );
    // A concurrent first write that lost the insert reports the row the other one stored.
    return { created, sleep: (await this.selectHostSleep(sleep.worker_id, sleep.woke_at))! };
  }

  async listHostSleeps(opts: { limit: number; work_item_id?: WorkItemId }): Promise<HostSleep[]> {
    const limit = Math.max(0, Math.floor(opts.limit));
    // limit is an integer computed here, inlined as the other paged reads do.
    const rows = opts.work_item_id === undefined
      ? await this.db.all(`SELECT * FROM host_sleeps ORDER BY woke_at DESC, worker_id DESC LIMIT ${limit}`)
      : await this.db.all(
          `SELECT h.* FROM host_sleeps h JOIN runs r ON r.id = h.run_id WHERE r.work_item_id = ?
           ORDER BY h.woke_at DESC, h.worker_id DESC LIMIT ${limit}`,
          [opts.work_item_id],
        );
    return rows.map(rowToHostSleep);
  }

  private async selectHostSleep(worker_id: WorkerId, woke_at: Timestamp): Promise<HostSleep | null> {
    const [row] = await this.db.all("SELECT * FROM host_sleeps WHERE worker_id = ? AND woke_at = ?", [worker_id, woke_at]);
    return row ? rowToHostSleep(row) : null;
  }

  // Alerts (design 05-alarms): the pattern's row is the dedupe, the alert row the record.

  async recordAlert(input: NewAlert, dedupe_ms: number): Promise<{ created: true; alert: Alert } | { created: false }> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      // Conditional: only the first write of a pattern, or the one that finds its last alert dedupe_ms old, wins.
      const due =
        (await this.insertOnce(tx, "INSERT INTO alert_patterns (pattern_key, last_alert_at) VALUES (?, ?)", [input.pattern_key, now])) ||
        (await tx.run("UPDATE alert_patterns SET last_alert_at = ? WHERE pattern_key = ? AND last_alert_at <= ?", [
          now, input.pattern_key, this.after(-dedupe_ms),
        ])) === 1;
      if (!due) return { created: false as const };
      const alert: Alert = { ...input, id: newId("al"), created_at: now };
      await tx.run(
        "INSERT INTO alerts (id, pattern, pattern_key, error_code, count, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [alert.id, alert.pattern, alert.pattern_key, alert.error_code, alert.count, alert.detail, alert.created_at],
      );
      return { created: true as const, alert };
    });
  }

  async listAlerts(opts: { limit: number }): Promise<Alert[]> {
    const limit = Math.max(0, Math.floor(opts.limit));
    // limit is an integer computed here, inlined as the other paged reads do.
    const rows = await this.db.all(`SELECT * FROM alerts ORDER BY created_at DESC, id DESC LIMIT ${limit}`);
    return rows.map(rowToAlert);
  }

  // Local work items (issue #198). Messages live in `item_thread`, commands in `command_inbox` (migration 24, issue #281).

  async recordItemMessage(input: NewItemMessage): Promise<{ created: boolean; message: ItemMessage }> {
    return this.db.transaction(async (tx) => {
      const existing = await this.selectItemMessage(tx, input.work_item_id, input.marker);
      if (existing) return { created: false, message: existing };
      const now = this.now();
      const created = await this.insertOnce(
        tx,
        "INSERT INTO item_thread (work_item_id, marker, body, created_at) VALUES (?, ?, ?, ?)",
        [input.work_item_id, input.marker, input.body, now],
      );
      const message = (await this.selectItemMessage(tx, input.work_item_id, input.marker))!;
      const d = input.delivery;
      if (created && d) {
        await tx.run(
          `INSERT INTO thread_outbox (thread_seq, work_item_id, source_type, target, link_field, attempts, next_attempt_at, claim_token,
             created_at) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?)`,
          [message.seq, input.work_item_id, d.source_type, JSON.stringify(d.target), d.link_field ?? null, now, now],
        );
      }
      return { created, message };
    });
  }

  // The thread outbox (issue #282). Claims are fenced by a token that only a claim bumps, like run leases.

  async listPendingDeliveries(source_types: readonly SourceType[], limit: number): Promise<ThreadDelivery[]> {
    if (source_types.length === 0) return [];
    const now = this.now();
    const rows = await this.db.all(
      `${DELIVERY_SELECT} WHERE o.delivered_at IS NULL AND o.source_type IN (${placeholders(source_types.length)})
         AND o.next_attempt_at <= ? AND (o.claimed_until IS NULL OR o.claimed_until <= ?)
       ORDER BY o.seq LIMIT ${Math.max(0, Math.floor(limit))}`,
      [...source_types, now, now],
    );
    return rows.map(rowToDelivery);
  }

  async listDeliveries(work_item_id: WorkItemId): Promise<ThreadDelivery[]> {
    const rows = await this.db.all(`${DELIVERY_SELECT} WHERE o.work_item_id = ? ORDER BY o.seq`, [work_item_id]);
    return rows.map(rowToDelivery);
  }

  async claimDelivery(seq: number, lease_ms: number): Promise<number | null> {
    return this.db.transaction(async (tx) => {
      const now = this.now();
      const until = new Date(this.clock.now().getTime() + Math.max(0, lease_ms)).toISOString();
      const n = await tx.run(
        `UPDATE thread_outbox SET claim_token = claim_token + 1, claimed_until = ?
         WHERE seq = ? AND delivered_at IS NULL AND (claimed_until IS NULL OR claimed_until <= ?)`,
        [until, seq, now],
      );
      if (n === 0) return null;
      const [row] = await tx.all("SELECT claim_token FROM thread_outbox WHERE seq = ?", [seq]);
      return Number(row!.claim_token);
    });
  }

  async finishDelivery(seq: number, token: number, url: string | null): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const now = this.now();
      const n = await tx.run(
        `UPDATE thread_outbox SET delivered_at = ?, url = ?, claimed_until = NULL, last_error = NULL
         WHERE seq = ? AND claim_token = ? AND delivered_at IS NULL AND claimed_until IS NOT NULL`,
        [now, url, seq, token],
      );
      if (n === 0) return false;
      const [row] = await tx.all("SELECT work_item_id, link_field FROM thread_outbox WHERE seq = ?", [seq]);
      const field = row!.link_field as string | null;
      if (url !== null && (field === "spec_comment_url" || field === "failure_comment_url")) {
        // Only the item's newest entry for this field fills it: an older one delivered late never hides a newer.
        await tx.run(
          `UPDATE work_items SET ${field} = ? WHERE id = ? AND NOT EXISTS (
             SELECT 1 FROM thread_outbox n WHERE n.work_item_id = ? AND n.link_field = ? AND n.seq > ?)`,
          [url, row!.work_item_id as string, row!.work_item_id as string, field, seq],
        );
      }
      return true;
    });
  }

  async failDelivery(seq: number, token: number, error: string, retry_in_ms: number): Promise<boolean> {
    const next = new Date(this.clock.now().getTime() + Math.max(0, retry_in_ms)).toISOString();
    const n = await this.db.run(
      `UPDATE thread_outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, claimed_until = NULL
       WHERE seq = ? AND claim_token = ? AND delivered_at IS NULL AND claimed_until IS NOT NULL`,
      [error.slice(0, 1000), next, seq, token],
    );
    return n > 0;
  }

  async listItemMessages(work_item_id: WorkItemId): Promise<ItemMessage[]> {
    const rows = await this.db.all("SELECT * FROM item_thread WHERE work_item_id = ? ORDER BY seq", [work_item_id]);
    return rows.map(rowToItemMessage);
  }

  async appendCliCommand(input: NewCliCommand): Promise<{ created: boolean; command: CliCommand }> {
    return this.db.transaction(async (tx) => {
      const existing = await this.selectCliCommand(tx, input.key);
      if (existing) return { created: false, command: existing };
      const created = await this.insertOnce(
        tx,
        "INSERT INTO command_inbox (command_key, actor, command, args, created_at) VALUES (?, ?, ?, ?, ?)",
        [input.key, input.actor, input.command, JSON.stringify(input.args), this.now()],
      );
      return { created, command: (await this.selectCliCommand(tx, input.key))! };
    });
  }

  async listCliCommandsAfter(after_seq: number, limit: number): Promise<CliCommand[]> {
    const rows = await this.db.all(`SELECT * FROM command_inbox WHERE seq > ? ORDER BY seq LIMIT ${Math.max(0, Math.floor(limit))}`, [
      after_seq,
    ]);
    return rows.map(rowToCliCommand);
  }

  // App command requests (issue #245)

  async recordAppCommandRequest(input: NewAppCommandRequest): Promise<{ created: boolean; request: AppCommandRequest }> {
    return this.db.transaction(async (tx) => {
      const existing = await this.selectAppCommandRequest(tx, input.key);
      if (existing) return { created: false, request: existing };
      const now = this.now();
      const created = await this.insertOnce(
        tx,
        "INSERT INTO app_command_requests (request_key, actor, command, args, created_at) VALUES (?, ?, ?, ?, ?)",
        [input.key, input.actor, input.command, JSON.stringify(input.args), now],
      );
      const request = (await this.selectAppCommandRequest(tx, input.key))!;
      // The controller reads every command from the inbox (issue #282): the request goes there too, by its seq.
      if (created) {
        await this.insertOnce(
          tx,
          "INSERT INTO command_inbox (command_key, actor, command, args, created_at) VALUES (?, ?, ?, ?, ?)",
          [`app:${request.seq}`, input.actor, input.command, JSON.stringify({ app_request: request.seq }), now],
        );
      }
      return { created, request };
    });
  }

  async markAppCommandRequest(seq: number, refusal: string | null): Promise<boolean> {
    const n = await this.db.run("UPDATE app_command_requests SET handled_at = ?, refusal = ? WHERE seq = ? AND handled_at IS NULL", [
      this.now(),
      refusal,
      seq,
    ]);
    return n > 0;
  }

  async getAppCommandRequest(seq: number): Promise<AppCommandRequest | null> {
    const [row] = await this.db.all("SELECT * FROM app_command_requests WHERE seq = ?", [seq]);
    return row ? rowToAppCommandRequest(row) : null;
  }

  async listAppCommandRequestsForItem(id: WorkItemId, limit: number): Promise<AppCommandRequest[]> {
    // `args` is JSON text written by JSON.stringify on both backends, so the pair appears verbatim; LIKE narrows
    // (its wildcards escaped with `!`), and the exact check below drops any row whose id only looked alike.
    const needle = `${JSON.stringify("work_item_id")}:${JSON.stringify(id)}`.replace(/[!%_]/g, (c) => `!${c}`);
    const rows = await this.db.all(
      `SELECT * FROM app_command_requests WHERE args LIKE ? ESCAPE '!' ORDER BY seq DESC LIMIT ${Math.max(0, Math.floor(limit))}`,
      [`%${needle}%`],
    );
    return rows.map(rowToAppCommandRequest).filter((r) => r.args.work_item_id === id).reverse();
  }

  // Raw table reads (design §9 Data page, issue #239). Names come only from the catalog; see ident().

  async listTables(): Promise<StoreTable[]> {
    const out: StoreTable[] = [];
    for (const t of await this.catalog()) {
      const [row] = await this.db.all(`SELECT COUNT(*) AS n FROM ${ident(t.name)}`);
      out.push({ ...t, rows: Number(row?.n ?? 0) });
    }
    return out;
  }

  async listTableRows(input: TablePageInput): Promise<TablePage | null> {
    const t = (await this.catalog()).find((c) => c.name === input.table);
    if (!t) return null;
    if (input.filter && !t.columns.includes(input.filter.column)) return null;
    const limit = pageLimit(input.limit);
    const offset = Number.isFinite(input.offset) ? Math.max(0, Math.floor(input.offset!)) : 0;
    const where = input.filter ? ` WHERE ${ident(input.filter.column)} = ?` : "";
    const params: SqlValue[] = input.filter ? [input.filter.value] : [];
    const order = t.order_by.length ? ` ORDER BY ${t.order_by.map((c) => `${ident(c)} DESC`).join(", ")}` : "";
    const [count] = await this.db.all(`SELECT COUNT(*) AS n FROM ${ident(t.name)}${where}`, params);
    // limit and offset are integers computed here, inlined as the other paged reads do.
    const rows = await this.db.all(`SELECT * FROM ${ident(t.name)}${where}${order} LIMIT ${limit} OFFSET ${offset}`, params);
    return {
      rows: rows.map((r) => Object.fromEntries(t.columns.map((c) => [c, toCell(r[c])]))),
      total: Number(count?.n ?? 0),
      limit,
      offset,
    };
  }

  /**
   * The schema's tables from the database's own catalog, without row counts. SQLite's driver orders rows by
   * `rowid`, MySQL's by its `seq` column; that dialect value tells the two catalogs apart.
   */
  private async catalog(): Promise<Omit<StoreTable, "rows">[]> {
    const tables = new Map<string, { columns: string[]; pk: { name: string; pos: number }[] }>();
    if (this.db.dialect.seq === "rowid") {
      const names = await this.db.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
      );
      for (const n of names) {
        const cols = await this.db.all("SELECT name, pk FROM pragma_table_info(?) ORDER BY cid", [n.name as string]);
        tables.set(n.name as string, {
          columns: cols.map((c) => c.name as string),
          pk: cols.filter((c) => Number(c.pk) > 0).map((c) => ({ name: c.name as string, pos: Number(c.pk) })),
        });
      }
    } else {
      const cols = await this.db.all(
        `SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c FROM information_schema.COLUMNS c
         JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME
         WHERE c.TABLE_SCHEMA = DATABASE() AND tb.TABLE_TYPE = 'BASE TABLE'
         ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
      );
      for (const r of cols) {
        const t = tables.get(r.t as string) ?? { columns: [], pk: [] };
        t.columns.push(r.c as string);
        tables.set(r.t as string, t);
      }
      const keys = await this.db.all(
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, ORDINAL_POSITION AS pos FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'PRIMARY'`,
      );
      for (const k of keys) tables.get(k.t as string)?.pk.push({ name: k.c as string, pos: Number(k.pos) });
    }
    const out: Omit<StoreTable, "rows">[] = [];
    for (const [name, t] of [...tables].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const primary_key = t.pk.sort((a, b) => a.pos - b.pos).map((p) => p.name);
      const time = TIME_COLUMNS.find((c) => t.columns.includes(c));
      const order_by = [...(time ? [time] : []), ...primary_key.filter((c) => c !== time)];
      out.push({ name, columns: t.columns, primary_key, order_by });
    }
    return out;
  }

  private async selectItemMessage(q: SqlExecutor, work_item_id: WorkItemId, marker: string): Promise<ItemMessage | null> {
    const [row] = await q.all("SELECT * FROM item_thread WHERE work_item_id = ? AND marker = ?", [work_item_id, marker]);
    return row ? rowToItemMessage(row) : null;
  }

  private async selectAppCommandRequest(q: SqlExecutor, key: string): Promise<AppCommandRequest | null> {
    const [row] = await q.all("SELECT * FROM app_command_requests WHERE request_key = ?", [key]);
    return row ? rowToAppCommandRequest(row) : null;
  }

  private async selectCliCommand(q: SqlExecutor, key: string): Promise<CliCommand | null> {
    const [row] = await q.all("SELECT * FROM command_inbox WHERE command_key = ?", [key]);
    return row ? rowToCliCommand(row) : null;
  }

  // Internals

  private async selectInbox(q: SqlExecutor, source_type: SourceType, dedupe_key: string): Promise<InboxRow | null> {
    const [row] = await q.all("SELECT * FROM source_inbox WHERE source_type = ? AND dedupe_key = ?", [source_type, dedupe_key]);
    return row ? rowToInbox(row) : null;
  }

  private async selectListenerLease(q: SqlExecutor, source_type: SourceType): Promise<ListenerLease | null> {
    const [row] = await q.all("SELECT * FROM listener_leases WHERE source_type = ?", [source_type]);
    return row
      ? {
          source_type: row.source_type as SourceType,
          owner: row.owner as string,
          token: Number(row.token),
          expires_at: row.expires_at as Timestamp,
        }
      : null;
  }

  /** False if a unique key says the row is already there. */
  private async insertOnce(tx: SqlExecutor, sql: string, params: (string | number | null)[]): Promise<boolean> {
    try {
      await tx.run(sql, params);
      return true;
    } catch (err) {
      if (this.db.isDuplicateKey(err)) return false;
      throw err;
    }
  }

  private now(): Timestamp {
    return this.clock.now().toISOString() as Timestamp;
  }

  private after(ms: number): Timestamp {
    return new Date(this.clock.now().getTime() + ms).toISOString() as Timestamp;
  }

  private async selectItem(q: SqlExecutor, id: WorkItemId, lock = ""): Promise<WorkItem | null> {
    const [row] = await q.all(`SELECT * FROM work_items WHERE id = ?${lock}`, [id]);
    return row ? rowToWorkItem(row) : null;
  }

  private async selectItemBySource(q: SqlExecutor, type: SourceType, sourceId: string): Promise<WorkItem | null> {
    const [row] = await q.all("SELECT * FROM work_items WHERE source_type = ? AND source_id = ?", [type, sourceId]);
    return row ? rowToWorkItem(row) : null;
  }

  private async selectVerdictByComment(q: SqlExecutor, commentId: string): Promise<Verdict | null> {
    const [row] = await q.all("SELECT * FROM verdicts WHERE comment_id = ?", [commentId]);
    return row ? rowToVerdict(row) : null;
  }

  private async selectCheckpoint(q: SqlExecutor, id: BudgetCheckpointId, lock = ""): Promise<BudgetCheckpoint | null> {
    const [row] = await q.all(`SELECT * FROM budget_checkpoints WHERE id = ?${lock}`, [id]);
    return row ? rowToBudgetCheckpoint(row) : null;
  }

  private async selectRun(q: SqlExecutor, id: RunId, lock = ""): Promise<Run | null> {
    const [row] = await q.all(`SELECT * FROM runs WHERE id = ?${lock}`, [id]);
    return row ? rowToRun(row) : null;
  }

  /**
   * Cancels the item's runs in `status` and clears their leases. Each update is conditional on that status,
   * so a run that moved on concurrently (a queued run a claim took first, a running run that just completed)
   * is left as it is and not reported. The lease token is kept: status alone fences a stopped run's heartbeat,
   * completion and tool calls.
   */
  private async cancelRuns(
    tx: SqlExecutor, workItemId: WorkItemId, status: "queued" | "running", now: Timestamp,
  ): Promise<RunId[]> {
    const rows = await tx.all(`SELECT id FROM runs WHERE work_item_id = ? AND status = ?${this.db.dialect.forUpdate}`, [
      workItemId, status,
    ]);
    const cancelled: RunId[] = [];
    for (const r of rows) {
      const n = await tx.run(
        "UPDATE runs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = ?",
        [now, r.id as string, status],
      );
      if (n === 1) {
        cancelled.push(r.id as RunId);
        if (status === "running") await this.closeAttempt(tx, r.id as RunId, null, "cancelled", now);
      }
    }
    return cancelled;
  }

  /**
   * The attempt record of a claim that just committed in `tx` (design §6): numbered after the run's last record,
   * so a resume of a paused run gets its own; keyed to the claim's lease token for the close.
   */
  private async openAttempt(tx: SqlExecutor, run: Run, now: Timestamp): Promise<void> {
    const [last] = await tx.all("SELECT MAX(attempt) AS n FROM run_attempts WHERE run_id = ?", [run.id]);
    await tx.run(
      `INSERT INTO run_attempts (run_id, attempt, lease_token, worker_id, status, started_at, finished_at, error_code,
         failure_class, tokens) VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, 0)`,
      [run.id, Number(last?.n ?? 0) + 1, run.lease!.token, run.lease!.owner, now],
    );
  }

  /**
   * Closes the run's open attempt record. `token`: only the record that claim opened (completeRun, pauseRun, the
   * reaper); null: whichever is open (a cancel, which holds no token). A failed outcome gives its error code,
   * failureClass() and outcomeTokens(); a reaped claim gives lease_expired and infra; anything else neither.
   */
  private async closeAttempt(
    tx: SqlExecutor, runId: RunId, token: number | null, status: Exclude<RunAttemptStatus, "running">, now: Timestamp,
    outcome: RunOutcome | null = null,
  ): Promise<void> {
    const failed = outcome?.status === "failed" ? outcome : null;
    const error_code = failed ? failed.error_code : status === "lease_expired" ? "lease_expired" : null;
    const failure_class = failed ? failureClass(failed) : status === "lease_expired" ? "infra" : null;
    await tx.run(
      `UPDATE run_attempts SET status = ?, finished_at = ?, error_code = ?, failure_class = ?, tokens = ?
       WHERE run_id = ? AND status = 'running'${token === null ? "" : " AND lease_token = ?"}`,
      [status, now, error_code, failure_class, outcomeTokens(outcome), runId, ...(token === null ? [] : [token])],
    );
  }

  /** Returns the new run, or null if the idempotency key already existed. */
  private async insertRun(tx: SqlExecutor, input: NewRun): Promise<Run | null> {
    const id = newId("run") as RunId;
    const now = this.now();
    const inserted = await this.insertOnce(
      tx,
      `INSERT INTO runs (id, work_item_id, kind, idempotency_key, status, attempt, lease_token, not_before, input, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?)`,
      [
        id, input.work_item_id, input.kind, input.idempotency_key, input.not_before ?? null,
        input.input ? JSON.stringify(input.input) : null, now, now,
      ],
    );
    return inserted ? this.selectRun(tx, id) : null;
  }

  private async insertStateChange(
    tx: SqlExecutor,
    workItemId: WorkItemId,
    version: number,
    actor: Actor,
    reason: string,
    changes: StateChange["changes"],
    detail: StateChangeDetail | null = null,
  ): Promise<StateChange> {
    const change: StateChange = {
      id: newId("sc") as StateChangeId,
      work_item_id: workItemId,
      version,
      at: this.now(),
      actor,
      reason,
      changes,
      detail,
    };
    await tx.run(
      "INSERT INTO state_changes (id, work_item_id, version, at, actor, reason, changes, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        change.id, workItemId, version, change.at, JSON.stringify(actor), reason, JSON.stringify(changes),
        detail === null ? null : JSON.stringify(detail),
      ],
    );
    return change;
  }
}

/** Thrown inside recordVerdict's transaction to roll it back when the verdict's comment id is already taken. */
class DuplicateVerdict extends Error {}

/** Thrown inside answerBudgetCheckpoint's transaction to roll it back when another answer won. */
class CheckpointAnswered extends Error {}

/** A closed item's checkpoint outcome, by close_reason. Other close reasons leave it null. */
const OUTCOME: Partial<Record<CloseReason, BudgetOutcome>> = { completed: "merged", rejected: "rejected", failed: "failed" };

/** The claim pause for a usage or rate limit on the agent harness: no claim of any kind. */
const RATE_LIMIT_PAUSE: ClaimPauseName = "rate_limit";
/**
 * The claim pause for a forge 401/403: no implement-type claim. A second row of the same table (migration 4,
 * both backends), so no schema change.
 */
const FORGE_AUTH_PAUSE: ClaimPauseName = "forge_auth";
/**
 * The claim pause for a push_access or pr_api preflight check that failed other than with a 401/403 (issue #216):
 * no implement-type claim, as for forge_auth. Its own row of the same table, so no schema change.
 */
const PREFLIGHT_ACCESS_PAUSE: ClaimPauseName = "preflight_access";

/** A stall pause is in effect while its next probe time is after the last answered probe (none: always). */
function stallInEffect(probeAt: string | undefined, answeredAt: string | undefined): boolean {
  return probeAt !== undefined && probeAt > (answeredAt ?? "");
}

function rowToOverride(row: Row): SettingOverride {
  return {
    key: String(row.setting_key),
    project: String(row.project_key),
    value: String(row.value_json),
    set_by: String(row.set_by),
    set_at: String(row.set_at) as Timestamp,
  };
}

function rowToSettingChange(row: Row): SettingChange {
  return {
    seq: Number(row.seq),
    key: String(row.setting_key),
    project: String(row.project_key),
    old_value: row.old_value === null || row.old_value === undefined ? null : String(row.old_value),
    new_value: row.new_value === null || row.new_value === undefined ? null : String(row.new_value),
    actor: String(row.actor),
    at: String(row.at) as Timestamp,
  };
}

function rowToInbox(row: Row): InboxRow {
  return {
    seq: Number(row.seq),
    source_type: row.source_type as SourceType,
    dedupe_key: row.dedupe_key as string,
    event: JSON.parse(row.event as string) as SourceEvent,
    received_at: row.received_at as Timestamp,
  };
}

function rowToItemMessage(row: Row): ItemMessage {
  return {
    seq: Number(row.seq),
    work_item_id: row.work_item_id as WorkItemId,
    marker: row.marker as string,
    body: row.body as string,
    created_at: row.created_at as Timestamp,
  };
}

const DELIVERY_SELECT =
  "SELECT o.*, t.marker AS thread_marker, t.body AS thread_body FROM thread_outbox o JOIN item_thread t ON t.seq = o.thread_seq";

function rowToDelivery(row: Row): ThreadDelivery {
  return {
    seq: Number(row.seq),
    thread_seq: Number(row.thread_seq),
    work_item_id: row.work_item_id as WorkItemId,
    source_type: row.source_type as SourceType,
    target: JSON.parse(row.target as string) as SourceRef,
    link_field: (row.link_field as ThreadLinkField | null) ?? null,
    marker: row.thread_marker as string,
    body: row.thread_body as string,
    attempts: Number(row.attempts),
    next_attempt_at: row.next_attempt_at as Timestamp,
    delivered_at: (row.delivered_at as Timestamp | null) ?? null,
    url: (row.url as string | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
    created_at: row.created_at as Timestamp,
  };
}

function rowToCliCommand(row: Row): CliCommand {
  return {
    seq: Number(row.seq),
    key: row.command_key as string,
    actor: row.actor as string,
    command: row.command as string,
    args: JSON.parse(row.args as string) as Record<string, unknown>,
    created_at: row.created_at as Timestamp,
  };
}

function rowToAppCommandRequest(row: Row): AppCommandRequest {
  return {
    seq: Number(row.seq),
    key: row.request_key as string,
    actor: row.actor as UserId,
    command: row.command as string,
    args: JSON.parse(row.args as string) as Record<string, unknown>,
    created_at: row.created_at as Timestamp,
    handled_at: (row.handled_at ?? null) as Timestamp | null,
    refusal: (row.refusal ?? null) as string | null,
  };
}

/** The WHERE clause (with leading space, or empty) for a WorkItemFilter. */
function whereOf(filter: Omit<WorkItemFilter, "limit">): { where: string; params: SqlValue[] } {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (filter.stage !== undefined) {
    where.push("stage = ?");
    params.push(filter.stage);
  } else if (filter.exclude_closed) {
    where.push("stage <> 'CLOSED'");
  }
  if (filter.blocked_on !== undefined) {
    where.push("blocked_on = ?");
    params.push(filter.blocked_on);
  }
  return { where: where.length ? ` WHERE ${where.join(" AND ")}` : "", params };
}

/** What claimRun reads once for the coordination check (design §5, 2026-11-03). */
interface CoordContext {
  items: Map<string, WorkItem>;
  holders: Holder[];
  /** Recorded conflicts per project, then per path. */
  conflicts: Map<string, Map<string, number>>;
  decisions: Map<string, ClaimDecision>;
  /** Held by a dependency: an edge not yet merged, or `blocked_on: dependency`. */
  depHeld: (id: string) => boolean;
}

/** Notes kept per session: the newest ones. */
const MAX_SESSION_NOTES = 200;

/** The one row in `claim_locks`: every claim takes it first (migration 7). */
const CLAIM_LOCK = "claim";

/** The `worker_pauses` row that pauses every worker loop (`workers pause --all`). */
const ALL_WORKERS = "*" as const;
const PAUSE_INSERT = "INSERT INTO worker_pauses (worker_id, paused_by, paused_at) VALUES (?, ?, ?)";

function rowToWorkerPause(r: Row): WorkerPause {
  return { worker_id: r.worker_id as WorkerId | "*", paused_by: r.paused_by as string, paused_at: r.paused_at as Timestamp };
}

/**
 * claimRun's kind rank (design §5 Parallel workers): runs that lead to a human decision first (review takes a PR
 * toward ready-to-merge, triage gives the owner a spec), then the branch writers, resolve last. Within a kind,
 * created_at, then insertion order.
 */
const CLAIM_ORDER: readonly RunKind[] = ["review", "triage", "update", "implement", "resolve"];

/** A JSON string array column (allowed_paths). */
function parseList(value: unknown): string[] {
  return typeof value === "string" ? (JSON.parse(value) as string[]) : [];
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** Link codes are stored only as this hash (design 2026-11-01). */
function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function abandonedAttempt(row: Row, outcome: AbandonedAttempt["outcome"]): AbandonedAttempt {
  const started_at = (row.started_at as Timestamp | null) ?? null;
  const ended_at = (row.updated_at as Timestamp | null) ?? null;
  const start = started_at ? Date.parse(started_at) : NaN;
  const end = ended_at ? Date.parse(ended_at) : NaN;
  return {
    run_id: row.id as RunId,
    work_item_id: row.work_item_id as WorkItemId,
    attempt: Number(row.attempt),
    outcome,
    started_at,
    ended_at,
    duration_ms: Number.isFinite(start) && Number.isFinite(end) ? end - start : null,
  };
}

/** A posted comment's body is stored only as this hash: enough to tell that a repeat post changed it. */
function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function rowToPostedComment(row: Row): PostedComment {
  return {
    source_id: row.source_id as string,
    marker: row.marker as string,
    comment_id: (row.comment_id as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    body_hash: (row.body_hash as string | null) ?? null,
    attempts: Number(row.attempts),
    next_attempt_at: (row.next_attempt_at as Timestamp | null) ?? null,
  };
}

function rowToLabelState(row: Row): LabelState {
  return {
    source_id: row.source_id as string,
    target: row.target as LabelTarget,
    status: (row.status as string | null) ?? null,
    updated_at: row.updated_at as Timestamp,
  };
}

function rowToMergeCheck(row: Row): MergeCheck {
  return {
    work_item_id: row.work_item_id as WorkItemId,
    mergeable: Number(row.mergeable) === 1,
    conflicts: JSON.parse(row.conflicts as string) as string[],
    head_sha: row.head_sha as string,
    base_sha: row.base_sha as string,
    checked_at: row.checked_at as Timestamp,
  };
}

function rowToAlert(row: Row): Alert {
  return {
    id: row.id as string,
    pattern: row.pattern as Alert["pattern"],
    pattern_key: row.pattern_key as string,
    error_code: row.error_code as string,
    count: Number(row.count),
    detail: (row.detail as string | null) ?? null,
    created_at: row.created_at as Timestamp,
  };
}

function rowToImproveReport(row: Row): ImproveReport {
  return {
    id: row.id as ImproveReportId,
    run_id: row.run_id as RunId,
    project: row.project_key as string,
    window_start: row.window_start as Timestamp,
    window_end: row.window_end as Timestamp,
    groups: JSON.parse(row.failure_groups as string) as ImproveReport["groups"],
    patterns: JSON.parse(row.patterns as string) as ImproveReport["patterns"],
    created_at: row.created_at as Timestamp,
  };
}

function rowToStandingRule(row: Row): StandingRule {
  return {
    gate: row.gate as StandingGate,
    tier: Number(row.tier) as Tier,
    enabled: Number(row.enabled) === 1,
    set_by: row.set_by as UserId,
    created_at: row.created_at as Timestamp,
    updated_at: row.updated_at as Timestamp,
  };
}

function rowToStandingProposal(row: Row): StandingProposal {
  return {
    id: row.id as StandingProposalId,
    gate: row.gate as StandingGate,
    tier: Number(row.tier) as Tier,
    run_length: Number(row.run_length),
    threshold: Number(row.threshold),
    created_at: row.created_at as Timestamp,
  };
}

function rowToWorkerProcess(row: Row): WorkerProcess {
  return {
    process_id: row.process_id as string,
    pid: Number(row.pid),
    host: row.host as string,
    slots: Number(row.slots),
    max_slots: Number(row.max_slots),
    busy: Number(row.busy),
    index_base: Number(row.index_base),
    started_at: row.started_at as Timestamp,
    reported_at: row.reported_at as Timestamp,
  };
}

/** A table's order column is the first of these it has (design §9 Data page). */
const TIME_COLUMNS = ["created_at", "at", "started_at", "updated_at", "woke_at"] as const;

/**
 * A quoted identifier. Only names read from the database's catalog reach here; anything that is not a plain
 * name is refused, so no caller text is ever spliced into SQL. Backticks quote on SQLite and MySQL alike.
 */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`not a plain identifier: ${JSON.stringify(name)}`);
  return `\`${name}\``;
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return TABLE_PAGE_DEFAULT;
  return Math.min(TABLE_PAGE_MAX, Math.max(1, Math.floor(limit)));
}

/** A driver value as a TableCell: dates as ISO text, big integers as numbers when exact, else text. */
function toCell(v: unknown): TableCell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  return String(v);
}

function rowToLocalUser(r: Row): LocalUser {
  return {
    user_id: String(r.user_id) as UserId,
    role: String(r.role) as LocalRole,
    added_by: String(r.added_by) as UserId,
    created_at: String(r.created_at) as Timestamp,
  };
}
