import type { TierHistory } from "../../../core/budget.js";
import type {
  Actor, BudgetCheckpoint, BudgetCheckpointId, BudgetOutcome, ClaimDecision, CloseReason, DependencyState, FiledPattern,
  FiledPatternId, Handoff, HostSleep, ImproveReport, ImproveReportId, Run, RunAttempt, RunAttemptStatus, RunId, RunKind, RunOutcome,
  RunInput, RunStatus, SessionRecord, SourceRef, SourceType, Stage, StandingGate, StandingProposal, StandingProposalId, StandingRule, StateChange,
  StateChangeDetail, StateChangeId, Tier, Timestamp, UnreviewedMergeId, UserId, Verdict, VerdictId, VerdictSeverity,
  WorkItem, WorkItemId, WorkItemPatch, ClaimPauseName, RunResume, WorkerId, WorkerPause,
} from "../../../core/types.js";
import { RECURRING_FAILURE, outcomeTokens } from "../../../core/types.js";
import {
  type CoordinationSettings, type DependencyLink, type Holder,
  DEFAULT_COORDINATION,
  aheadOf,
  claimDecision,
  conflictWindowStart,
  holdOutcome,
  holdsOn,
  sessionHold, shortRef,
} from "../../../core/coordination.js";
import {
  GITHUB_RATE_LIMIT, IMPLEMENT_KINDS, INTERACTIVE, MODEL_ANSWERED, MODEL_STALL, NETWORK, NETWORK_ANSWERED, PROBE_PAUSES, type ProbePause,
  SESSION_LOST, TAKEOVER_OUTCOME, failureClass, probePauseOf,
} from "../../../core/policy.js";
import { assertProjectKey } from "../../../core/project.js";
import type { StatsRecord } from "../../../core/stats.js";
import type { LinkedAccount } from "../../../interfaces/auth-provider.js";
import type { Clock } from "../../../interfaces/clock.js";
import type {
  AbandonedAttempt,
  AnswerBudgetCheckpointInput,
  ApproveClaimHoldInput,
  RunIntent,
  BudgetCheckpointResult,
  ClaimInput,
  FactoryStore,
  LeaseResult,
  ListenerLease,
  ForgeBudget,
  SyncFence,
  SyncLease,
  SyncLeaseResult,
  LabelTarget,
  NewMergeCheck,
  NewPostedComment,
  PostedComment,
  ListenerLeaseResult,
  NewAppCommandRequest,
  NewCliCommand,
  NewAlert,
  NewFiledPattern,
  NewImproveReport,
  NewInboxEvent,
  NewItemMessage,
  NewRun,
  NewSignal,
  NewStandingProposal,
  NewStandingRule,
  NewUnreviewedMerge,
  NewWorkItem,
  OpenBudgetCheckpointInput,
  RecordConflictsInput,
  RecordPrHeadInput,
  RecordVerdictInput,
  RecordVerdictResult,
  OwnerDecision,
  ResetSettingInput,
  SchemaVersion,
  SessionUpdate,
  SetSettingInput,
  StartSessionInput,
  StartSessionResult,
  TablePageInput,
  TransitionInput,
  TransitionResult,
  WorkItemFilter,
  WorkerProcessReport,
} from "../../../interfaces/factory-store.js";
import { EXTRA_SLOT_KINDS } from "../../../interfaces/factory-store.js";
import { type ChildRestart, migrationPendingError } from "../../../interfaces/updater.js";
import type { Row, SqlDriver, SqlExecutor, SqlValue } from "../../../state/index.js";
import { countLegacyProjectRows, legacyRowsMessage } from "../project-keys.js";
import { changeAssignments, changeFields } from "./change-fields.js";
import { diffPatch, newId, newWorkItem, rowToBudgetCheckpoint, rowToRun, rowToRunAttempt, rowToStateChange, rowToVerdict, rowToWorkItem, workItemInsert } from "./rows.js";
import * as filed from "./filed-patterns.js";
import * as settingsSql from "./settings.js";
import { PAUSE_END_INSERT, PAUSE_INSERT_ROW, pauseAt, placeholders, pruneDeliveredOutbox, pruneHandledCommands, pruneHistory } from "./retention.js";
import { insertActivity, leaseExpiryActivity, migrateWithActivity, prunedWithActivity } from "./activity.js";
import * as signals from "./signals.js";
import * as evaluations from "./merge-evaluations.js";
import * as proposals from "./command-proposals.js";
import * as tasks from "./tasks.js"; import * as chat from "./chat.js"; import * as held from "./held-writes.js"; import { readPermissionMode } from "../../../core/authorize.js";
import { SqlRoutineStore } from "./routines.js";
import { claimLock, endReservations, liveReservations, reservationOf } from "./reservations.js";
import { type CoordContext, claimDecisionsOf, claimOrder, claimOrderSql, implementTimes, releaseHolder, writeClaimDecision } from "./claim-coordination.js";
import * as notices from "./notices.js";
import * as alerts from "./alerts.js";
import * as noticeMessages from "./notice-messages.js";
import * as basePush from "./base-push.js";
import * as posted from "./posted-comments.js";
import * as verdicts from "./verdicts.js";
import * as standing from "./standing-rules.js";
import { type StoreSteps, type StoreTime, insertOnce } from "./store-steps.js";
import * as sessions from "./sessions.js";
import * as improve from "./improve-reports.js";
import * as deps from "./dependencies.js";
import * as prHeads from "./pr-heads.js";
import * as merges from "./unreviewed-merges.js";
import * as intake from "./intake.js";
import * as links from "./identity-links.js";
import * as sync from "./github-sync.js";
import * as health from "./worker-health.js";
import * as local from "./local-items.js";
import * as tables from "./tables.js";

/**
 * FactoryStore over a SqlDriver (SQLite; `db` is public for components owning tables). Every write is one driver transaction. Correctness
 * never depends on the row locks alone: every state change is also a conditional UPDATE (version,
 * status, lease token), and uniqueness is enforced by keys, with a duplicate treated as "already there". Task projects: SqlProjectStore, schedules: SqlScheduleStore (schedules.ts), skill evals: SqlSkillEvalStore (skill-evals.ts), skill drafts: SqlSkillDraftStore (skill-drafts.ts), attachments: SqlAttachmentStore (attachments.ts), routines: SqlRoutineStore (routines.ts).
 */
export class SqlFactoryStore extends SqlRoutineStore implements FactoryStore {
  constructor(db: SqlDriver, private readonly clock: Clock) {
    super(db, () => clock.now().toISOString() as Timestamp);
  }

  /** The store's time and its own transaction steps, for the method groups in their own modules (store-steps.ts). */
  private readonly time: StoreTime = { now: () => this.now(), after: (ms) => this.after(ms) };
  private readonly steps: StoreSteps = {
    selectItem: (q, id) => this.selectItem(q, id), selectRun: (q, id) => this.selectRun(q, id), applyTransition: (tx, input) => this.applyTransition(tx, input),
  };

  /**
   * The schema (the driver builds it), then the project-key check: the store
   * refuses to open while any project column still holds `owner/name` (design 2026-11-01), so a new controller
   * never runs on unmigrated rows. `npm run migrate` rewrites them.
   */
  async migrate(): Promise<void> {
    await migrateWithActivity(this.db, () => this.now(), "open"); // each migration this open applies gets its Activity row (./activity.ts)
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

      const item = newWorkItem(input, await changeFields(tx, input.project, input.adopted?.change_ref ?? null), this.now());
      const { columns, values } = workItemInsert(item);
      const inserted = await this.insertOnce(
        tx,
        `INSERT INTO controller_work_items (${columns}) VALUES (${placeholders(values.length)})`,
        values,
      );
      // A concurrent intake of the same source committed first.
      if (!inserted) return { item: (await this.selectItemBySource(tx, input.source.type, input.source.id))!, created: false };

      if (input.adopted) {
        await this.insertStateChange(tx, item.id, 1, actor, "pr_adopted", {
          stage: { from: null as never, to: "REVIEW" },
          change_ref: { from: null, to: input.adopted.change_ref },
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

  async findWorkItemIds(prefix: string): Promise<WorkItemId[]> {
    const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1); // IDs with the prefix sort in [prefix, end)
    return prefix === "" ? [] : (await this.db.all("SELECT id FROM controller_work_items WHERE id >= ? AND id < ? ORDER BY id", [prefix, end])).map((r) => r.id as WorkItemId);
  }

  async getWorkItemBySource(type: SourceType, sourceId: string): Promise<WorkItem | null> {
    return this.selectItemBySource(this.db, type, sourceId);
  }

  async getWorkItemByPr(project: string, change_ref: string): Promise<WorkItem | null> {
    const sql = `SELECT * FROM controller_work_items WHERE project = ? AND change_ref = ? ORDER BY created_at, ${this.db.dialect.seq} LIMIT 1`;
    const [row] = await this.db.all(sql, [project, change_ref]);
    return row ? rowToWorkItem(row) : null;
  }

  async getWorkItemByMergeSha(project: string, sha: string): Promise<WorkItem | null> {
    const sql = `SELECT * FROM controller_work_items WHERE merge_sha = ? AND project = ? ORDER BY created_at, ${this.db.dialect.seq} LIMIT 1`;
    const [row] = await this.db.all(sql, [sha, project]);
    return row ? rowToWorkItem(row) : null;
  }

  async listPhases(parentId: WorkItemId): Promise<WorkItem[]> {
    const rows = await this.db.all(`SELECT * FROM controller_work_items WHERE parent_id = ? ORDER BY phase, ${this.db.dialect.seq}`, [parentId]);
    return rows.map(rowToWorkItem);
  }

  async listWorkItems(limit: number): Promise<WorkItem[]> {
    const rows = await this.db.all(`SELECT * FROM controller_work_items ORDER BY created_at DESC, ${this.db.dialect.seq} DESC LIMIT ?`, [
      limit,
    ]);
    return rows.map(rowToWorkItem);
  }

  async listWorkItemsWhere(filter: WorkItemFilter): Promise<WorkItem[]> {
    const { where, params } = whereOf(filter);
    const rows = await this.db.all(
      `SELECT * FROM controller_work_items${where} ORDER BY updated_at DESC, ${this.db.dialect.seq} DESC LIMIT ?`,
      [...params, filter.limit],
    );
    return rows.map(rowToWorkItem);
  }

  async countWorkItemsWhere(filter: Omit<WorkItemFilter, "limit">): Promise<number> {
    const { where, params } = whereOf(filter);
    const [row] = await this.db.all(`SELECT COUNT(*) AS n FROM controller_work_items${where}`, params);
    return Number(row?.n ?? 0);
  }

  async countWorkItemsByStage(): Promise<Record<Stage, number>> {
    const counts: Record<Stage, number> = { NEW: 0, READY: 0, RUNNING: 0, REVIEW: 0, CLOSED: 0 };
    const rows = await this.db.all("SELECT stage, COUNT(*) AS n FROM controller_work_items WHERE blocked_reason IS NULL OR blocked_reason <> 'system_item' GROUP BY stage");
    for (const r of rows) counts[r.stage as Stage] = Number(r.n);
    return counts;
  }

  async transition(input: TransitionInput): Promise<TransitionResult> {
    return this.db.transaction((tx) => this.applyTransition(tx, input));
  }

  /** transition() inside a caller's transaction. A refusal returns before anything is written. */
  private async applyTransition(tx: SqlExecutor, input: TransitionInput): Promise<TransitionResult> {
    const current = await this.selectItem(tx, input.id);
    if (!current) return { ok: false, reason: "not_found" };
    if (current.version !== input.expected_version) return { ok: false, reason: "version_conflict", current };

    if (input.ack_run !== undefined) {
      const run = await this.selectRun(tx, input.ack_run);
      const finished = run && (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled");
      if (!run || run.work_item_id !== input.id || !finished || run.acknowledged_at !== null) {
        return { ok: false, reason: "run_not_ackable" };
      }
    }

    const { changes, sets, values } = await this.patchSql(tx, current, input.patch);
    const now = this.now();
    const version = current.version + 1;
    const updated = await tx.run(
      `UPDATE controller_work_items SET ${[...sets, "version = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`,
      [...values, version, now, input.id, input.expected_version],
    );
    if (updated !== 1) return { ok: false, reason: "version_conflict", current };

    const state_change = await this.insertStateChange(tx, input.id, version, input.actor, input.reason, changes, input.detail ?? null);
    if (input.activity) await insertActivity(tx, now, input.activity);
    if (input.ack_run !== undefined) {
      await tx.run("UPDATE worker_runs SET acknowledged_at = ?, updated_at = ? WHERE id = ?", [now, now, input.ack_run]);
    }
    const cancelled = [ // any close cancels the item's queued runs, whichever path closes it (design 05-restarts, 2026-11-22)
      ...(input.cancel_queued_runs || (current.stage !== "CLOSED" && input.patch.stage === "CLOSED") ? await this.cancelRuns(tx, input.id, "queued", now) : []),
      ...(input.cancel_running_runs ? await this.cancelRuns(tx, input.id, "running", now) : []),
    ];
    const enqueued = input.enqueue ? await this.insertRun(tx, { ...input.enqueue, work_item_id: input.id }) : null;
    const item = (await this.selectItem(tx, input.id))!;
    // Closing the item settles its checkpoints that have no outcome yet (design §6).
    const outcome = item.close_reason === null ? null : OUTCOME[item.close_reason];
    if (current.stage !== "CLOSED" && item.stage === "CLOSED" && outcome) {
      await tx.run("UPDATE controller_budget_checkpoints SET outcome = ? WHERE work_item_id = ? AND outcome IS NULL", [outcome, input.id]);
    }
    await evaluations.onMergeTransition(tx, current, item, input.actor.id, now); // a merge stores its evaluation once (design §6)
    // A closed item (its PR merged or closed: the merge path's transition) holds nothing from this commit on (releaseHolder); the next claim records
    // what holds the runs it held (design §5). A completed close completes linked tasks; a rejected one moves them to its replacement (design 02-tasks-build).
    if (current.stage !== "CLOSED" && item.stage === "CLOSED") {
      if (item.close_reason === "completed" || item.close_reason === "rejected") await tasks.onItemClosed(this.db, tx, item, now);
      await releaseHolder(tx, input.id);
    }
    return { ok: true, item, state_change, enqueued, cancelled };
  }

  async listStateChanges(id: WorkItemId): Promise<StateChange[]> {
    const rows = await this.db.all("SELECT * FROM controller_state_changes WHERE work_item_id = ? ORDER BY version", [id]);
    return rows.map(rowToStateChange);
  }

  async recordVerdict(input: RecordVerdictInput): Promise<RecordVerdictResult> {
    try {
      return await this.db.transaction(async (tx): Promise<RecordVerdictResult> => {
        const current = await this.selectItem(tx, input.id);
        if (!current) return { ok: false, reason: "not_found" };
        // Before the version: a redelivered comment is a no-op whatever happened to the item since.
        const existing = await this.selectVerdictByComment(tx, input.comment_id);
        if (existing && verdicts.isDuplicate(existing, input)) return { ok: false, reason: "duplicate", verdict: existing };
        if (current.version !== input.expected_version) return { ok: false, reason: "version_conflict", current };
        // One verdict per PR head (design §4): an implicit one never adds a second, an explicit one replaces it.
        if (input.pr_head !== null) {
          const [onHead] = await tx.all(
            `SELECT * FROM controller_verdicts WHERE work_item_id = ? AND pr_head = ? ORDER BY at, ${this.db.dialect.seq}`,
            [input.id, input.pr_head],
          );
          if (onHead && input.implicit) return { ok: false, reason: "duplicate", verdict: rowToVerdict(onHead) };
          if (onHead) await tx.run("DELETE FROM controller_verdicts WHERE work_item_id = ? AND pr_head = ? AND implicit = 1", [input.id, input.pr_head]);
        }

        const now = this.now();
        const version = current.version + 1;
        const updated = await tx.run("UPDATE controller_work_items SET version = ?, updated_at = ? WHERE id = ? AND version = ?", [
          version, now, input.id, input.expected_version,
        ]);
        if (updated !== 1) return { ok: false, reason: "version_conflict", current };
        const state_change = await this.insertStateChange(tx, input.id, version, input.actor, input.implicit ? "implicit_verdict" : "human_verdict", {});
        if (existing) return { ok: true, item: (await this.selectItem(tx, input.id))!, state_change, verdict: await verdicts.replaceVerdict(tx, existing, input, state_change.id, now) };
        const verdict: Verdict = {
          id: newId("vd") as VerdictId,
          work_item_id: input.id,
          state_change_id: state_change.id,
          verdict: input.verdict,
          severity: input.severity,
          reason: input.reason,
          comment_id: input.comment_id,
          target: input.target,
          implicit: input.implicit,
          pr_head: input.pr_head,
          at: now,
        };
        const inserted = await this.insertOnce(
          tx,
          `INSERT INTO controller_verdicts (id, work_item_id, state_change_id, verdict, severity, reason, comment_id, target, implicit, pr_head, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            verdict.id, verdict.work_item_id, verdict.state_change_id, verdict.verdict, verdict.severity,
            verdict.reason, verdict.comment_id, verdict.target, verdict.implicit ? 1 : 0, verdict.pr_head, verdict.at,
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
    const rows = await this.db.all(`SELECT * FROM controller_verdicts WHERE work_item_id = ? ORDER BY at, ${this.db.dialect.seq}`, [id]);
    return rows.map(rowToVerdict);
  }
  // Signal ledger (design 11-signal-ledger): in ./signals.ts.
  recordSignal(s: NewSignal): Promise<boolean> { return signals.recordSignal(this.db, s); }
  latestSignalTimes(): Promise<ReadonlyMap<string, Timestamp>> { return signals.latestSignalTimes(this.db); }
  listSignalRefs(windows: Parameters<FactoryStore["listSignalRefs"]>[0]) { return signals.listSignalRefs(this.db, windows); }
  listStateChangesSince(q: Parameters<FactoryStore["listStateChangesSince"]>[0]): Promise<StateChange[]> { return signals.listStateChangesSince(this.db, q); }
  listVerdictsSince(since: Timestamp | null): Promise<Verdict[]> { return signals.listVerdictsSince(this.db, since); }
  listRunsFinishedSince(q: Parameters<FactoryStore["listRunsFinishedSince"]>[0]): Promise<Run[]> { return signals.listRunsFinishedSince(this.db, q); }
  listMergeEvaluations(since: Parameters<FactoryStore["listMergeEvaluations"]>[0]) { return evaluations.listMergeEvaluations(this.db, since !== null && typeof since === "object" ? this.after(-since.within_ms) : since); }
  // Command proposals (design 04-gate-commands, issue #584): command-proposals.ts
  recordCommandProposals(rows: Parameters<FactoryStore["recordCommandProposals"]>[0]) { return proposals.recordCommandProposals(this.db, rows, this.now()); }
  listCommandProposals(proposal_id: string) { return proposals.listCommandProposals(this.db, proposal_id); }
  answerCommandProposal(a: Parameters<FactoryStore["answerCommandProposal"]>[0]) { return proposals.answerCommandProposal(this.db, a, this.now()); }
  appendChatMessages(id: string, m: Parameters<FactoryStore["appendChatMessages"]>[1]) { return chat.appendChatMessages(this.db, id, m, this.now()); } listChatMessages(id: string) { return chat.listChatMessages(this.db, id); } recordChatSpend(s: Parameters<FactoryStore["recordChatSpend"]>[0]) { return chat.recordChatSpend(this.db, s, this.now()); } listChatSpendBetween(...[from, to, kind]: Parameters<FactoryStore["listChatSpendBetween"]>) { return chat.listChatSpendBetween(this.db, from, to, kind); } startChatTurn(id: string, session: string) { return chat.startChatTurn(this.db, id, session, this.now()); } finishChatTurn(...a: Parameters<FactoryStore["finishChatTurn"]>) { return chat.finishChatTurn(this.db, ...a, this.now()); } listChatTurns(limit: number) { return chat.listChatTurns(this.db, limit); } holdWrite(w: Parameters<FactoryStore["holdWrite"]>[0]) { return held.holdWrite(this.db, w, this.now()); } listHeldWrites(limit: number) { return held.listHeldWrites(this.db, limit); } getHeldWrite(id: string) { return held.getHeldWrite(this.db, id); } answerHeldWrite(a: Parameters<FactoryStore["answerHeldWrite"]>[0]) { return held.answerHeldWrite(this.db, a); } recordAgentWrite(w: Parameters<FactoryStore["recordAgentWrite"]>[0]) { return local.recordAgentWrite(this.db, this.time, w); } refuseCommand(id: string, refusal: string) { return local.refuseCommand(this.db, this.time, id, refusal); } // chat.ts, held-writes.ts, local-items.ts
  // Plain tasks (design 02-tasks, issue #606): tasks.ts
  addTask(t: Parameters<FactoryStore["addTask"]>[0]) { return tasks.addTask(this.db, t, this.clock.now()); }
  listTasks(limit: number) { return tasks.listTasks(this.db, limit); } listDoneTasks(w: Parameters<FactoryStore["listDoneTasks"]>[0]) { return tasks.listDoneTasks(this.db, w); }
  completeTask(id: string) { return tasks.completeTask(this.db, id, this.now()); } reopenTask(id: string) { return tasks.reopenTask(this.db, id); }
  getTask(id: string) { return tasks.getTask(this.db, id); } countOpenSubTasks() { return tasks.countOpenSubTasks(this.db); }
  linkTask(id: string, work_item_id: WorkItemId) { return tasks.linkTask(this.db, id, work_item_id); }
  closeLinkedTasks(work_item_id: WorkItemId) { return tasks.closeLinkedTasks(this.db, work_item_id, this.now()); }
  updateTask(id: string, edit: Parameters<FactoryStore["updateTask"]>[1]) { return tasks.updateTask(this.db, id, edit, this.clock.now()); }
  setTaskBody(id: string, body: string | null) { return tasks.setTaskBody(this.db, id, body); } deleteTask(id: string, opts?: { with_sub_tasks?: boolean }) { return tasks.deleteTask(this.db, id, opts); }
  addSubTask(parent_task_id: string, t: Parameters<FactoryStore["addSubTask"]>[1]) { return tasks.addSubTask(this.db, parent_task_id, t, this.clock.now()); }
  listDueReminders(now: Date) { return tasks.listDueReminders(this.db, now); } remindTask(...a: Parameters<FactoryStore["remindTask"]>) { return tasks.remindTask(this.db, ...a); }
  // Owner notices (design 09-notifications): notices.ts
  recordNotice(n: Parameters<FactoryStore["recordNotice"]>[0]) { return notices.recordNotice(this.db, n); }
  listNoticesFor(work_item_ids: readonly string[]) { return notices.listNoticesFor(this.db, work_item_ids); }
  listHeldNotices() { return notices.listHeldNotices(this.db); }
  listPendingNotices() { return notices.listPendingNotices(this.db); }
  // The Slack source's notice records (design 05-sources, "Replies under a notice"): notice-messages.ts
  recordNoticeMessage(m: Parameters<FactoryStore["recordNoticeMessage"]>[0]) { return noticeMessages.recordNoticeMessage(this.db, m, this.now()); }
  getNoticeMessage(channel: string, ts: string) { return noticeMessages.getNoticeMessage(this.db, channel, ts); }
  recordNoticeQuestion(q: Parameters<FactoryStore["recordNoticeQuestion"]>[0]) { return noticeMessages.recordNoticeQuestion(this.db, q, this.now()); }
  getNoticeQuestion(id: string) { return noticeMessages.getNoticeQuestion(this.db, id); }

  // Budget checkpoints

  async openBudgetCheckpoint(input: OpenBudgetCheckpointInput): Promise<BudgetCheckpointResult> {
    const { checkpoint, ...transition } = input;
    return this.db.transaction(async (tx): Promise<BudgetCheckpointResult> => {
      const [pending] = await tx.all("SELECT id FROM controller_budget_checkpoints WHERE work_item_id = ? AND answer = 'pending'", [input.id]);
      if (pending) return { ok: false, reason: "checkpoint_pending" };
      const r = await this.applyTransition(tx, transition);
      if (!r.ok) return r;
      const id = newId("bc") as BudgetCheckpointId;
      await tx.run(
        `INSERT INTO controller_budget_checkpoints (id, work_item_id, tier, tokens_spent, budget, suggested_budget, answer, granted_budget,
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
        const cp = await this.selectCheckpoint(tx, checkpoint_id);
        if (!cp || cp.work_item_id !== input.id || cp.answer !== "pending") return { ok: false, reason: "checkpoint_not_pending" };
        const r = await this.applyTransition(tx, transition);
        if (!r.ok) return r;
        const answered = await tx.run(
          "UPDATE controller_budget_checkpoints SET answer = ?, granted_budget = ?, answered_at = ? WHERE id = ? AND answer = 'pending'",
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
      `SELECT * FROM controller_budget_checkpoints WHERE work_item_id = ? ORDER BY created_at, ${this.db.dialect.seq}`,
      [id],
    );
    return rows.map(rowToBudgetCheckpoint);
  }

  async getTierHistory(project: string, tier: Tier): Promise<TierHistory> {
    const rows = await this.db.all(
      "SELECT close_reason, token_cost FROM controller_work_items WHERE project = ? AND tier = ? AND stage = 'CLOSED'",
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
    const items = await this.db.all(`SELECT id, tier, stage, close_reason, token_cost, origin FROM controller_work_items ORDER BY created_at, ${seq}`);
    const records = new Map<string, StatsRecord>();
    for (const r of items) {
      records.set(r.id as string, {
        id: r.id as WorkItemId,
        tier: r.tier === null ? null : (Number(r.tier) as Tier),
        stage: r.stage as Stage,
        token_cost: Number(r.token_cost),
        reasons: [], severities: [],
        implicit: 0, pushed: false, // a person's push sets `pushed`: an implicit `changes` verdict (design §6 Autonomy)
        origin: (r.origin as WorkItem["origin"] | null) ?? "factory",
        merged: r.stage === "CLOSED" && r.close_reason === "completed",
      });
    }
    if (reasons.length > 0) {
      const changes = await this.db.all(
        `SELECT work_item_id, reason FROM controller_state_changes WHERE reason IN (${placeholders(reasons.length)})
         ORDER BY work_item_id, version`,
        [...reasons],
      );
      for (const c of changes) records.get(c.work_item_id as string)?.reasons.push(c.reason as string);
    }
    const verdicts = await this.db.all(`SELECT work_item_id, verdict, severity, implicit FROM controller_verdicts ORDER BY at, ${seq}`);
    for (const v of verdicts) {
      const record = records.get(v.work_item_id as string);
      if (!record) continue;
      if (Number(v.implicit) !== 1) record.severities.push(v.severity as VerdictSeverity);
      else Object.assign(record, { implicit: (record.implicit ?? 0) + 1, pushed: record.pushed === true || v.verdict === "changes" });
    }
    return [...records.values()];
  }

  // Runs

  async claimRun(input: ClaimInput): Promise<Run | null> {
    // An interactive run is a person's session, never a worker's (design §5, 2026-11-01).
    const kinds = input.kinds.filter((k) => k !== INTERACTIVE);
    if (kinds.length === 0) return null;
    const { seq } = this.db.dialect;
    const writeKinds = placeholders(IMPLEMENT_KINDS.length);
    return this.db.transaction(async (tx) => {
      await claimLock(tx); // first: the same-item check below runs one claimer at a time
      const now = this.now();
      const reserved = await liveReservations(tx, now); // a waiting session's NEW item: its runs stay queued (05-interactive-sessions)
      // A usage or rate limit pauses every claim, for every item, on every replica; a forge 401/403 pauses the
      // implement-type claims only, and so does a failed push_access or pr_api preflight check; a GitHub rate
      // limit pauses implement-type and review claims (design §5 Restarts). All are rows of claim_pauses, read
      // under the lock.
      const pauseNames = [RATE_LIMIT_PAUSE, FORGE_AUTH_PAUSE, PREFLIGHT_ACCESS_PAUSE, GITHUB_RATE_LIMIT, MODEL_STALL, MODEL_ANSWERED, NETWORK, NETWORK_ANSWERED];
      const pauseRows = await tx.all(`SELECT name, resume_at FROM worker_claim_pauses WHERE name IN (${placeholders(pauseNames.length)})`, pauseNames);
      const pauses = new Map(pauseRows.map((r) => [r.name as string, r.resume_at as string]));
      const active = (name: ClaimPauseName) => (pauses.get(name) ?? "") > now;
      if (active(RATE_LIMIT_PAUSE)) return null;
      // A stall or a dead network pauses every claim until a probe passes, not until a time (design §5 Restarts).
      const probing = (p: ProbePause) => probeInEffect(pauses.get(p), pauses.get(PROBE_PAUSES[p].answered));
      if (probing(MODEL_STALL) || probing(NETWORK)) return null;
      // `workers pause`: this loop's own row or the all-flag stops its claims (design §5 Pause), read under the lock.
      const [workerPaused] = await tx.all("SELECT worker_id FROM worker_pauses WHERE worker_id IN (?, ?)", [input.worker_id, ALL_WORKERS]);
      if (workerPaused) return null;
      const forgePaused = active(FORGE_AUTH_PAUSE) || active(PREFLIGHT_ACCESS_PAUSE);
      const githubPaused = active(GITHUB_RATE_LIMIT);

      // Items with an implement-type run in progress (architecture §4, one branch writer per item). Items whose
      // allowed_paths overlap do run side by side; their conflicts are resolved at merge.
      const writing = await tx.all(`SELECT work_item_id FROM worker_runs WHERE status = 'running' AND kind IN (${writeKinds})`, [...IMPLEMENT_KINDS]);
      const busy = new Set(writing.map((r) => r.work_item_id as string));
      // Open sessions (design §5, 2026-11-01): an implement-type run waits while its item has one, or while its cost against one reaches max_cost (sessionHold, 2026-11-21).
      const sessions = await this.runningItems(tx, [INTERACTIVE]), sc = input.coordination ?? DEFAULT_COORDINATION;
      const overlapsSession = async (itemId: string): Promise<boolean> => {
        if (sessions.length === 0 || sessions.some((x) => x.item.id === itemId)) return sessions.length > 0;
        const it = await this.selectItem(tx, itemId as WorkItemId);
        return it !== null && sessionHold(it, sessions, await this.projectConflicts(tx, it.project, sc), sc) !== null;
      };

      // Queued runs in claim order (claimOrderSql, design §5 Coordination). not_before: a retry waits out its backoff, whichever worker looks; a held item's (05-alarms) waits for its release.
      const order = claimOrderSql(seq);
      const queued = await tx.all(
        `SELECT r.id, r.kind, r.work_item_id FROM worker_runs r
         WHERE r.status = 'queued' AND r.kind IN (${placeholders(kinds.length)})
           AND (r.not_before IS NULL OR r.not_before <= ?) AND NOT EXISTS (SELECT 1 FROM controller_work_items w WHERE w.id = r.work_item_id AND w.blocked_reason = ?)
         ORDER BY ${order.sql}`,
        [...kinds, now, RECURRING_FAILURE, ...order.params],
      );
      // Coordination (design §5, 2026-11-03): read once, only when an implement run is a candidate.
      const settings = input.coordination ?? DEFAULT_COORDINATION;
      const coord = queued.some((q) => q.kind === "implement") ? await this.coordinationContext(tx, queued, busy, settings) : null;
      const fits = input.workers ? await this.slotCheck(tx, input.workers) : () => true; // the cap: every kind waits at `workers`, a merge check gets one slot beyond
      for (const next of queued) {
        if (!fits(next.kind as RunKind) || reserved.has(next.work_item_id as string)) continue;
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
          `UPDATE worker_runs SET status = 'running', attempt = attempt + CASE WHEN paused_at IS NULL THEN 1 ELSE 0 END,
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

  /** The slot cap (design §5): which kinds fit, by every process's running runs (not interactive) under the claim lock. */
  private async slotCheck(tx: SqlExecutor, { count }: NonNullable<ClaimInput["workers"]>): Promise<(kind: RunKind) => boolean> {
    const running = (await tx.all(`SELECT kind FROM worker_runs WHERE status = 'running' AND kind <> 'interactive'`, [])).map((r) => r.kind as RunKind);
    return (kind) => running.length < count || (count > 0 && running.length === count && EXTRA_SLOT_KINDS.includes(kind));
  }

  async listQueuedInClaimOrder(limit: number): Promise<Run[]> {
    const order = claimOrderSql(this.db.dialect.seq);
    return (await this.db.all(`SELECT r.* FROM worker_runs r WHERE r.status = 'queued' ORDER BY ${order.sql} LIMIT ?`, [...order.params, limit])).map(rowToRun);
  }

  async runNext(id: WorkItemId): Promise<Run[]> {
    return this.db.transaction(async (tx) => {
      await claimLock(tx); // one bump at a time, so each gets its own place
      const [top] = await tx.all("SELECT MAX(run_next_seq) AS n FROM worker_runs"), mine = "work_item_id = ? AND status = 'queued' AND kind <> ?";
      await tx.run(`UPDATE worker_runs SET run_next_seq = ? WHERE ${mine}`, [Number(top?.n ?? 0) + 1, id, INTERACTIVE]);
      return (await tx.all(`SELECT * FROM worker_runs WHERE ${mine} ORDER BY created_at`, [id, INTERACTIVE])).map(rowToRun);
    });
  }

  /**
   * What the claim needs for coordination, read under the claim lock: the queued implement runs' items, the
   * items with an implement-type run running, every open PR's item, the queued items' dependency edges (with
   * the state of the work item each points to), recorded conflicts and the stored claim decisions.
   */
  private async coordinationContext(tx: SqlExecutor, queued: Row[], busy: ReadonlySet<string>, s: CoordinationSettings): Promise<CoordContext> {
    const runs = queued.filter((q) => q.kind === "implement");
    const ids = [...new Set([...runs.map((q) => q.work_item_id as string), ...busy])];
    const items = new Map<string, WorkItem>();
    for (const r of await tx.all(`SELECT * FROM controller_work_items WHERE id IN (${placeholders(ids.length)})`, ids)) {
      items.set(r.id as string, rowToWorkItem(r));
    }
    const openPrs = (await tx.all(`SELECT * FROM controller_work_items WHERE change_ref IS NOT NULL AND stage <> 'CLOSED'`)).map(rowToWorkItem);
    for (const it of openPrs) items.set(it.id, it);
    const queuedIds = [...new Set(runs.map((q) => q.work_item_id as string))];
    const edges = await tx.all(
      `SELECT e.work_item_id, e.state, w.stage, w.close_reason, w.merge_sha FROM controller_dependency_edges e
       LEFT JOIN controller_work_items w ON w.source_type = 'github_issue' AND w.source_id = e.depends_on
       WHERE e.work_item_id IN (${placeholders(queuedIds.length)})`,
      queuedIds,
    );
    const unmet = new Set<string>();
    for (const e of edges) {
      const merged = e.state === "merged" || (e.stage === "CLOSED" && e.close_reason === "completed" && e.merge_sha !== null);
      if (!merged) unmet.add(e.work_item_id as string);
    }
    const conflicts = await this.conflictsByProject(tx, [...new Set([...items.values()].map((it) => it.project))], conflictWindowStart(this.clock.now(), s));
    const runIds = runs.map((q) => q.id as string);
    const { decisions, released } = await claimDecisionsOf(tx, runIds);
    const depHeld = (id: string) => unmet.has(id) || items.get(id)?.blocked_on === "dependency";
    const times = await implementTimes(tx, [...items.keys()]);
    // Holders: running items, open PRs, then other claimable queued implement runs of items with no PR.
    const holders: Holder[] = [];
    const ref = (it: WorkItem, self: string) => (it.change_ref !== null ? `#${it.change_ref}` : shortRef(it.source.id, self));
    const holderOf = (it: WorkItem, kind: Holder["kind"]): Holder => ({
      work_item_id: it.id,
      project: it.project,
      ref: ref(it, it.source.id),
      kind,
      files: it.pr_files ?? (it.change_ref === null ? it.files_to_change : null) ?? it.allowed_paths,
      fallback: kind === "pr" && it.pr_files === null,
      ...(kind === "waiting" ? {} : { queued: times.get(it.id)?.queued ?? null, started: times.get(it.id)?.started ?? null }),
    });
    for (const id of busy) {
      const it = items.get(id);
      if (it) holders.push(holderOf(it, "running"));
    }
    for (const it of openPrs) if (!busy.has(it.id)) holders.push(holderOf(it, "pr"));
    for (const id of queuedIds) {
      const it = items.get(id);
      if (it && it.change_ref === null && !busy.has(id) && !depHeld(id)) holders.push(holderOf(it, "waiting"));
    }
    return { items, holders, conflicts, decisions, released, depHeld, times, ...claimOrder(runs, decisions) };
  }

  /**
   * Whether queued implement run `runId` may be claimed now (design §5, 2026-11-03). Writes the run's claim
   * decision when the cost rule decided it and the decision changed. A `held` run then follows `hold_policy`
   * (issue #314), timed from `held_since`: the start of the hold, kept while the run stays held. Oldest held first
   * (design 05-dependencies, 2026-11-23): a run already held is held only by running items and open PRs that were
   * ahead of it (`aheadOf`), and an older queued run that is held holds it too.
   */
  private async coordinate(
    tx: SqlExecutor, runId: RunId, itemId: WorkItemId, c: CoordContext, s: CoordinationSettings,
  ): Promise<boolean> {
    if (c.depHeld(itemId)) return false;
    const it = c.items.get(itemId);
    // A review fix or retry on an item with a PR: its conflicts are the PR's, handled at merge.
    if (!it || it.change_ref !== null) return true;
    const existing = c.decisions.get(runId) ?? null;
    const now = this.now();
    // A hold goes on across its named holder closing (`released`): the start stays, and so does the order rule.
    const heldSince = existing?.decision === "held" ? (existing.held_since ?? existing.at) : (c.released.get(runId) ?? null);
    const wasHeld = heldSince !== null;
    const since = heldSince ?? now;
    const queued = c.times.get(itemId)?.queued ?? now;
    const mine = c.order.get(itemId) ?? Infinity;
    // Holders named relative to this item, so one of the same repository is "#N". On a first hold every running
    // item and open PR started before now, so the order rule applies only to a run already held.
    const holders = c.holders
      .filter((h) => !wasHeld || aheadOf(h, since, queued))
      .map((h) => ({
        ...h,
        ...(h.work_item_id ? { ref: this.refFor(c, h.work_item_id, it) } : {}),
        ...(h.kind === "waiting" ? { held: c.held.get(h.work_item_id!) === true && (c.order.get(h.work_item_id!) ?? Infinity) < mine } : {}),
      }));
    const holds = holdsOn({ work_item_id: it.id, project: it.project, files: it.files_to_change ?? it.allowed_paths }, holders,
      c.conflicts.get(it.project) ?? new Map(), s);
    const verdict = claimDecision(holds);
    if (verdict === "free") return true;
    const write = (decision: ClaimDecision["decision"]) =>
      writeClaimDecision(tx, (sql, params) => this.insertOnce(tx, sql, params), now, { it, runId, decision, hold: holds[0]!, threshold: s.max_cost, existing, held_since: since });
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
    c.held.set(itemId, outcome === "held"); // newer runs in this claim wait behind it (rule 2)
    return outcome !== "held";
  }

  private refFor(c: CoordContext, holderId: string, self: WorkItem): string {
    const h = c.items.get(holderId);
    if (!h) return holderId;
    return h.change_ref !== null ? `#${h.change_ref}` : shortRef(h.source.id, self.source.id);
  }

  async pauseClaims(resume_at: Timestamp, name: ClaimPauseName = RATE_LIMIT_PAUSE): Promise<{ extended: boolean; started?: boolean; resume_at: Timestamp }> {
    // `started` for every name but rate_limit: the rate-limit pause's result stays exactly as it was (out of this change).
    const result = (extended: boolean, started: boolean, at: Timestamp) =>
      name === RATE_LIMIT_PAUSE ? { extended, resume_at: at } : { extended, started, resume_at: at };
    const probe = probePauseOf(name);
    if (probe === name) return this.pauseForProbe(probe, resume_at);
    if (probe !== null && name === PROBE_PAUSES[probe].since) throw new Error(`${name} is written by the store when a ${probe} pause starts`);
    return this.db.transaction(async (tx) => {
      if (await this.insertOnce(tx, "INSERT INTO worker_claim_pauses (name, resume_at) VALUES (?, ?)", [name, resume_at])) {
        return result(true, true, resume_at);
      }
      // Conditional, so concurrent callers never both start it: only the update that finds the pause already
      // ended starts a new one (the row stays after a pause ends), and only a later time moves a running one.
      const now = this.now();
      const restarted = await tx.run("UPDATE worker_claim_pauses SET resume_at = ? WHERE name = ? AND resume_at <= ? AND resume_at < ?", [
        resume_at, name, now, resume_at,
      ]);
      if (restarted === 1) return result(true, true, resume_at);
      const moved = await tx.run("UPDATE worker_claim_pauses SET resume_at = ? WHERE name = ? AND resume_at > ? AND resume_at < ?", [
        resume_at, name, now, resume_at,
      ]);
      if (moved === 1) return result(true, false, resume_at);
      const [row] = await tx.all("SELECT resume_at FROM worker_claim_pauses WHERE name = ?", [name]);
      return result(false, false, row!.resume_at as Timestamp);
    });
  }

  /**
   * A probe pause, `model_stall` or `network` (design §5 Restarts), under the claim lock so a claim, a failure and a probe never interleave.
   * It is in effect while its row's time (the next probe) is after its answered row, whatever the clock says. Not in effect: this call
   * starts one (`started`) and writes when it began (its since row). In effect: only a later probe time moves it.
   */
  private async pauseForProbe(pause: ProbePause, resume_at: Timestamp): Promise<{ extended: boolean; started: boolean; resume_at: Timestamp }> {
    const { since: sinceRow } = PROBE_PAUSES[pause];
    return this.db.transaction(async (tx) => {
      const { current, answered } = await this.probeRows(tx, pause, true);
      if (current !== undefined && probeInEffect(current, answered)) {
        if (resume_at <= current) return { extended: false, started: false, resume_at: current };
        await tx.run("UPDATE worker_claim_pauses SET resume_at = ? WHERE name = ?", [resume_at, pause]);
        return { extended: true, started: false, resume_at };
      }
      // A probe time not after the last answer would start a pause that is already over.
      if (answered !== undefined && resume_at <= answered) return { extended: false, started: false, resume_at: current ?? resume_at };
      await this.setPauseRows(tx, [[pause, resume_at], [sinceRow, this.now()]]);
      return { extended: true, started: true, resume_at };
    });
  }

  /** A probe pause's row and its answered row; `lock`: read under the claim lock first. */
  private async probeRows(tx: SqlExecutor, pause: ProbePause, lock: boolean): Promise<{ current?: Timestamp; answered?: Timestamp }> {
    if (lock) await claimLock(tx);
    const answeredRow = PROBE_PAUSES[pause].answered;
    const rows = new Map(
      (await tx.all("SELECT name, resume_at FROM worker_claim_pauses WHERE name IN (?, ?)", [pause, answeredRow]))
        .map((r) => [r.name as string, r.resume_at as Timestamp]),
    );
    const current = rows.get(pause);
    const answered = rows.get(answeredRow);
    return { ...(current !== undefined && { current }), ...(answered !== undefined && { answered }) };
  }

  /** Writes each claim_pauses row, inserting the ones not there yet. */
  private async setPauseRows(tx: SqlExecutor, rows: readonly (readonly [string, Timestamp])[]): Promise<void> {
    for (const [name, at] of rows) {
      if (!(await this.insertOnce(tx, "INSERT INTO worker_claim_pauses (name, resume_at) VALUES (?, ?)", [name, at]))) {
        await tx.run("UPDATE worker_claim_pauses SET resume_at = ? WHERE name = ?", [at, name]);
      }
    }
  }

  async getClaimPause(name: ClaimPauseName = RATE_LIMIT_PAUSE): Promise<Timestamp | null> {
    const probe = probePauseOf(name);
    if (probe !== null && name !== PROBE_PAUSES[probe].answered) {
      // In effect until a probe passes, not until a time: the probe time is returned also once it passed.
      const { since, answered } = PROBE_PAUSES[probe];
      const rows = new Map(
        (await this.db.all("SELECT name, resume_at FROM worker_claim_pauses WHERE name IN (?, ?, ?)", [probe, since, answered]))
          .map((r) => [r.name as string, r.resume_at as Timestamp]),
      );
      if (!probeInEffect(rows.get(probe), rows.get(answered))) return null;
      return rows.get(name) ?? null;
    }
    const [row] = await this.db.all("SELECT resume_at FROM worker_claim_pauses WHERE name = ?", [name]);
    const at = (row?.resume_at as Timestamp | undefined) ?? null;
    return at !== null && at > this.now() ? at : null;
  }

  async endClaimPause(name: ClaimPauseName): Promise<{ ended: boolean }> {
    const probe = probePauseOf(name);
    if (probe !== null && probe !== name) throw new Error(`${name} is not a pause of its own; end ${probe}`);
    if (probe !== null) return this.endProbe(probe);
    // Conditional: only a row still in effect moves, so a second call, or one with no pause in effect, writes nothing.
    const now = this.now();
    const ended = await this.db.run("UPDATE worker_claim_pauses SET resume_at = ? WHERE name = ? AND resume_at > ?", [now, name, now]);
    return { ended: ended === 1 };
  }

  /**
   * Ends a probe pause as a passing probe does, under the claim lock: its row and its answered row both move to the earlier of the probe
   * time and now. Never a future answer, so a failure right after starts a pause. The pause history gets it, from its since row to now (design §7).
   */
  private async endProbe(pause: ProbePause): Promise<{ ended: boolean }> {
    return this.db.transaction(async (tx) => {
      const { current, answered } = await this.probeRows(tx, pause, true);
      if (current === undefined || !probeInEffect(current, answered)) return { ended: false };
      const now = this.now();
      const at = current < now ? current : now;
      await this.setPauseRows(tx, [[pause, at], [PROBE_PAUSES[pause].answered, at]]);
      await this.insertOnce(tx, PAUSE_END_INSERT, [pause, now, PROBE_PAUSES[pause].since]);
      return { ended: true };
    });
  }

  async claimProbe(name: ProbePause, due: Timestamp, next: Timestamp): Promise<boolean> {
    // Under the claim lock, as every probe pause write: a pause ended meanwhile is never moved back into effect.
    // Conditional on the probe time the caller read: of replicas that saw the same due probe, one write lands.
    return this.db.transaction(async (tx) => {
      const { answered } = await this.probeRows(tx, name, true);
      if (!probeInEffect(due, answered) || next <= due) return false;
      return (await tx.run("UPDATE worker_claim_pauses SET resume_at = ? WHERE name = ? AND resume_at = ?", [next, name, due])) === 1;
    });
  }

  // Worker pauses (design §5 Pause)

  async pauseWorkers(input: { count: number } | { all: true }, by: string): Promise<{ paused: (WorkerId | "*")[] }> {
    const { seq } = this.db.dialect;
    return this.db.transaction(async (tx) => {
      const now = this.now();
      if ("all" in input) {
        return { paused: (await this.insertOnce(tx, PAUSE_INSERT, [ALL_WORKERS, by, now])) ? [ALL_WORKERS] : [] };
      }
      // Under the claim lock, so no claim moves a run to running between the read and the pause rows.
      await claimLock(tx);
      const already = new Set((await tx.all("SELECT worker_id FROM worker_pauses")).map((r) => r.worker_id as string));
      const running = await tx.all(
        `SELECT lease_owner FROM worker_runs WHERE status = 'running' AND lease_owner IS NOT NULL AND kind <> ? ORDER BY started_at DESC, ${seq} DESC`,
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
    pause: { paused_by: string; session_id: string | null; resume: RunResume | null },
  ): Promise<LeaseResult> {
    return this.db.transaction(async (tx) => {
      const now = this.now();
      // Conditional on status and token, like completeRun. attempt is left as it is: the resuming claim adds nothing.
      const paused = await tx.run(
        `UPDATE worker_runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, not_before = NULL,
           paused_at = ?, paused_by = ?, session_id = ?, pause_state = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_token = ?`,
        [now, pause.paused_by, pause.session_id, pause.resume === null ? null : JSON.stringify(pause.resume), now, runId, token],
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
        `UPDATE worker_runs SET lease_expires_at = ?, updated_at = ?
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
        `UPDATE worker_runs SET status = ?, outcome = ?, lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_token = ?`,
        [outcome.status, JSON.stringify(outcome), now, now, runId, token],
      );
      if (completed === 1) await this.closeAttempt(tx, runId, token, outcome.status, now, outcome); // same tx: run and attempt never disagree
      return completed === 1 ? { ok: true, run: (await this.selectRun(tx, runId))! } : { ok: false, reason: "lease_lost" };
    });
  }

  async listUnacknowledgedRuns(limit: number): Promise<Run[]> {
    const rows = await this.db.all(
      `SELECT * FROM worker_runs WHERE status IN ('succeeded', 'failed', 'cancelled') AND acknowledged_at IS NULL
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
    const { ids, abandoned } = await this.db.transaction(async (tx) => {
      const now = this.now();
      // A run another reaper holds right now is left for the next tick. started_at and updated_at (the last
      // heartbeat on a running run) are read here, before this transaction's write rewrites updated_at.
      const expired = await tx.all(
        `SELECT id, kind, attempt, lease_token, work_item_id, started_at, updated_at FROM worker_runs
         WHERE status = 'running' AND lease_expires_at <= ?`,
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
            `UPDATE worker_runs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'running'`,
            [now, run.id as string],
          );
        } else if (run.kind === INTERACTIVE) {
          // A closed terminal does not come back (design §5, 2026-11-01): never requeued; the detail names the last heartbeat.
          const lost: RunOutcome = { status: "failed", error_code: SESSION_LOST, detail: `the session's lease expired; last heartbeat at ${String(run.updated_at)}`, infra: false };
          outcome = "failed";
          moved = await tx.run(
            "UPDATE worker_runs SET status = 'failed', outcome = ?, lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
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
            `UPDATE worker_runs SET status = 'failed', outcome = ?, lease_owner = NULL, lease_expires_at = NULL, finished_at = ?,
               updated_at = ?
             WHERE id = ? AND status = 'running'`,
            [JSON.stringify(failed), now, now, run.id as string],
          );
        } else {
          // Same backoff as any other retry, so a lasting outage does not use up the attempts at once.
          const not_before = backoff_ms ? this.after(backoff_ms(Number(run.attempt))) : null;
          outcome = "queued";
          moved = await tx.run(
            `UPDATE worker_runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, not_before = ?, updated_at = ?
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
      await leaseExpiryActivity(tx, now, abandoned, max_attempts); // one Activity row per run moved, in this transaction
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
    const { seq } = this.db.dialect;
    return this.db.transaction(async (tx): Promise<StartSessionResult> => {
      // The claim lock first, as claimRun takes it: no claim moves a run to running between these checks and the insert.
      await claimLock(tx);
      const current = await this.selectItem(tx, input.id);
      if (!current) return { ok: false, reason: "not_found" };
      if (current.version !== input.expected_version) return { ok: false, reason: "version_conflict", current };
      const held = await reservationOf(tx, input.id, this.now());
      if (held && held.owner !== input.owner) return { ok: false, reason: "reserved", reservation: held };
      const own = await tx.all(`SELECT id, kind, status FROM worker_runs WHERE work_item_id = ? AND status IN ('queued', 'running') ORDER BY created_at, ${seq}`, [input.id]);
      const open = own.find((r) => r.kind === INTERACTIVE && r.status === "running");
      if (open) return { ok: false, reason: "session_open", run_id: open.id as RunId };
      const writes = (r: Row) => (IMPLEMENT_KINDS as readonly string[]).includes(r.kind as string), writer = own.find((r) => writes(r) && r.status === "running");
      if (writer) return { ok: false, reason: "implement_run", run_id: writer.id as RunId };
      // Running work of another item refuses only at the workers' cost (sessionHold, design 05-dependencies 2026-11-21).
      const s = input.coordination ?? DEFAULT_COORDINATION, mine = { ...current, files_to_change: input.patch.files_to_change ?? current.files_to_change, allowed_paths: input.patch.allowed_paths ?? current.allowed_paths };
      const hold = sessionHold(mine, await this.runningItems(tx, [...IMPLEMENT_KINDS, INTERACTIVE]), await this.projectConflicts(tx, current.project, s), s);
      if (hold) return { ok: false, reason: "overlap", work_item_id: hold.holder.work_item_id as WorkItemId, run_id: hold.run_id as RunId, paths: hold.shared.map((p) => p.path), cost: hold.cost, max_cost: s.max_cost };
      const runId = newId("run") as RunId;
      const now = this.now();
      const session: SessionRecord = { notes: [], last_finish: null };
      await tx.run(
        `INSERT INTO worker_runs (id, work_item_id, kind, idempotency_key, status, attempt, lease_owner, lease_token, lease_expires_at, input, actor_id,
           transcript_url, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', 1, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        [runId, input.id, INTERACTIVE, `${input.id}:interactive:${runId}`, input.owner, this.after(input.lease_ms),
          JSON.stringify({ session } satisfies RunInput), input.actor.id, input.transcript_url, now, now, now],
      );
      // A session start is the run's one claim (design §6): it gets its attempt record like any claim.
      await this.openAttempt(tx, (await this.selectRun(tx, runId))!, now);
      const { changes, sets, values } = await this.patchSql(tx, current, input.patch);
      const version = current.version + 1;
      await tx.run(`UPDATE controller_work_items SET ${[...sets, "version = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`, [
        ...values, version, now, input.id, input.expected_version,
      ]);
      // Every check passed, so the takeover (design §5 Restarts): queued implement-type runs get TAKEOVER_OUTCOME (no attempt).
      const [taken_over, cancelled]: [RunId[], RunId[]] = [[], []];
      for (const r of own.filter((x) => x.status === "queued" && (writes(x) || x.kind === "triage")))
        if (await this.cancelRun(tx, r.id as RunId, "queued", now, writes(r) ? TAKEOVER_OUTCOME : null)) (writes(r) ? taken_over : cancelled).push(r.id as RunId);
      await endReservations(tx, input.id);
      const state_change = await this.insertStateChange(tx, input.id, version, input.actor, input.reason, changes,
        { ...input.detail, run_id: runId, ...(taken_over.length > 0 ? { taken_over: taken_over.join(",") } : {}) });
      return { ok: true, item: (await this.selectItem(tx, input.id))!, run: (await this.selectRun(tx, runId))!, state_change, cancelled, taken_over };
    });
  }

  // A session start is a claim, so it stays here; its updates: sessions.ts
  updateSession(runId: RunId, token: number, update: SessionUpdate) { return sessions.updateSession(this.db, this.time, this.steps, runId, token, update); }

  /** Running runs of `kinds` with their items; the recorded conflicts of one project inside `conflict_window_days`. */
  private async runningItems(tx: SqlExecutor, kinds: readonly RunKind[]): Promise<{ run_id: string; item: WorkItem }[]> {
    return (await tx.all(`SELECT r.id AS run_id, w.* FROM worker_runs r JOIN controller_work_items w ON w.id = r.work_item_id
       WHERE r.status = 'running' AND r.kind IN (${placeholders(kinds.length)}) ORDER BY r.created_at, r.${this.db.dialect.seq}`, [...kinds])).map((r) => ({ run_id: r.run_id as string, item: rowToWorkItem(r) }));
  }
  private async projectConflicts(q: SqlExecutor, project: string, s: CoordinationSettings): Promise<Map<string, number>> {
    return (await this.conflictsByProject(q, [project], conflictWindowStart(this.clock.now(), s))).get(project) ?? new Map<string, number>();
  }

  async listRunsByKind(kind: RunKind, statuses: readonly RunStatus[]): Promise<Run[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db.all(
      `SELECT * FROM worker_runs WHERE kind = ? AND status IN (${placeholders(statuses.length)}) ORDER BY created_at, ${this.db.dialect.seq}`,
      [kind, ...statuses],
    );
    return rows.map(rowToRun);
  }

  async listRuns(id: WorkItemId): Promise<Run[]> {
    const rows = await this.db.all(`SELECT * FROM worker_runs WHERE work_item_id = ? ORDER BY created_at, ${this.db.dialect.seq}`, [id]);
    return rows.map(rowToRun);
  }

  async listRunAttempts(id: WorkItemId): Promise<RunAttempt[]> {
    const { seq } = this.db.dialect;
    const rows = await this.db.all(
      `SELECT a.* FROM worker_run_attempts a JOIN worker_runs r ON r.id = a.run_id WHERE r.work_item_id = ?
       ORDER BY r.created_at, r.${seq}, a.attempt`,
      [id],
    );
    return rows.map(rowToRunAttempt);
  }

  async listRunsByStatus(statuses: readonly RunStatus[], limit: number): Promise<Run[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db.all(
      `SELECT * FROM worker_runs WHERE status IN (${placeholders(statuses.length)}) ORDER BY created_at, ${this.db.dialect.seq} LIMIT ?`,
      [...statuses, limit],
    );
    return rows.map(rowToRun);
  }

  async listRunsFinishedWithin(window_ms: number): Promise<Run[]> {
    const rows = await this.db.all(
      `SELECT * FROM worker_runs WHERE finished_at IS NOT NULL AND finished_at >= ? ORDER BY finished_at DESC, ${this.db.dialect.seq} DESC`,
      [this.after(-window_ms)],
    );
    return rows.map(rowToRun);
  }

  async listRunsFinishedBetween(start: Timestamp, end: Timestamp): Promise<Run[]> {
    const rows = await this.db.all(
      `SELECT * FROM worker_runs WHERE finished_at IS NOT NULL AND finished_at >= ? AND finished_at < ? ORDER BY finished_at, ${this.db.dialect.seq}`,
      [start, end],
    );
    return rows.map(rowToRun);
  }

  async enqueueRun(input: NewRun): Promise<{ run: Run; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const run = await this.insertRun(tx, input);
      if (run) return { run, created: true };
      const [row] = await tx.all("SELECT * FROM worker_runs WHERE idempotency_key = ?", [input.idempotency_key]);
      return { run: rowToRun(row!), created: false };
    });
  }

  // Improve reports (design §7): improve-reports.ts
  recordImproveReport(input: NewImproveReport) { return improve.recordImproveReport(this.db, this.time, input); }
  getImproveReport(run_id: RunId) { return improve.getImproveReport(this.db, run_id); }
  getLatestImproveReport(project?: string) { return improve.getLatestImproveReport(this.db, project); }
  listImproveReports(project: string, since: Timestamp) { return improve.listImproveReports(this.db, project, since); }
  setImproveGroups(id: ImproveReportId, groups: ImproveReport["groups"], patterns?: ImproveReport["patterns"]) { return improve.setImproveGroups(this.db, id, groups, patterns); }

  // Filed patterns (design 07-self-improvement): in ./filed-patterns.ts.
  getFiledPattern(project: string, pattern_key: string): Promise<FiledPattern | null> {
    return filed.getFiledPattern(this.db, project, pattern_key);
  }

  takeFiledPattern(input: NewFiledPattern, from?: filed.TakeFrom): Promise<{ row: FiledPattern; taken: boolean }> {
    return filed.takeFiledPattern(this.db, (sql, params) => this.insertOnce(this.db, sql, params), input, this.now(), from);
  }

  getOpenWorkItemByTitle(project: string, title: string): Promise<WorkItem | null> {
    return filed.getOpenWorkItemByTitle(this.db, project, title);
  }

  setFiledPatternRef(id: FiledPatternId, report_id: ImproveReportId, ref: SourceRef): Promise<void> {
    return filed.setFiledPatternRef(this.db, id, report_id, ref);
  }
  async listFiledPatternsWithin(within_ms: number) { const since = this.after(-within_ms); return { since, rows: await filed.listFiledPatternsSince(this.db, since) }; }
  listFiledPatternsWithoutOutcome(project: string): Promise<FiledPattern[]> { return filed.listFiledPatternsWithoutOutcome(this.db, project); }
  setFiledPatternOutcome(id: FiledPatternId, outcome: NonNullable<FiledPattern["outcome"]>, at: Timestamp): Promise<boolean> {
    return filed.setFiledPatternOutcome(this.db, id, outcome, at);
  }

  // Standing approvals (design 05-standing-approvals); rules and their change records: standing-rules.ts
  putStandingRule(input: NewStandingRule): Promise<StandingRule> { return standing.putStandingRule(this.db, this.now(), input); }
  listStandingRules(): Promise<StandingRule[]> { return standing.listStandingRules(this.db); }
  deleteStandingRule(input: Parameters<FactoryStore["deleteStandingRule"]>[0]) { return standing.deleteStandingRule(this.db, this.now(), input); }
  recordStandingRuleChange(input: Parameters<FactoryStore["recordStandingRuleChange"]>[0]) { return standing.recordStandingRuleChange(this.db, this.now(), input); }
  listStandingRuleChanges() { return standing.listStandingRuleChanges(this.db); }

  async recordStandingProposal(input: NewStandingProposal): Promise<{ proposal: StandingProposal; created: boolean }> {
    const proposal: StandingProposal = { ...input, id: newId("sp") as StandingProposalId, created_at: this.now() };
    const created = await this.insertOnce(
      this.db,
      "INSERT INTO controller_standing_proposals (id, gate, tier, run_length, threshold, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [proposal.id, proposal.gate, proposal.tier, proposal.run_length, proposal.threshold, proposal.created_at],
    );
    if (created) return { proposal, created };
    const [row] = await this.db.all("SELECT * FROM controller_standing_proposals WHERE gate = ? AND tier = ? AND run_length = ?", [
      input.gate, input.tier, input.run_length,
    ]);
    return { proposal: rowToStandingProposal(row!), created };
  }

  async listStandingProposals(): Promise<StandingProposal[]> {
    return (await this.db.all("SELECT * FROM controller_standing_proposals ORDER BY gate, tier, run_length")).map(rowToStandingProposal);
  }

  // Coordination (design §5, 2026-11-03): dependency edges and claim holds in dependencies.ts; the recorded conflicts the claim reads stay here
  replaceDependencyEdges(id: WorkItemId, links: readonly DependencyLink[], read_at?: Timestamp) { return deps.replaceDependencyEdges(this.db, this.time, id, links, read_at); }
  dependencyLinksReadAt(id: WorkItemId) { return deps.dependencyLinksReadAt(this.db, id); }
  markDependencyLinksStale(id: WorkItemId) { return deps.markDependencyLinksStale(this.db, id); }
  listDependencyEdges(filter?: { work_item_id?: WorkItemId; depends_on?: string }) { return deps.listDependencyEdges(this.db, filter); }
  setDependencyState(id: WorkItemId, depends_on: string, state: DependencyState) { return deps.setDependencyState(this.db, this.time, id, depends_on, state); }

  async recordConflicts(input: RecordConflictsInput): Promise<number> {
    assertProjectKey(input.project);
    const paths = [...new Set(input.paths.filter((p) => p.length > 0))];
    if (paths.length === 0) return 0;
    return this.db.transaction(async (tx) => {
      let n = 0;
      for (const path of paths) {
        const inserted = await this.insertOnce(tx, "INSERT INTO controller_file_conflicts (project_key, path, event_key, at) VALUES (?, ?, ?, ?)", [
          input.project, path, input.event_key, this.now(),
        ]);
        if (inserted) n++;
      }
      return n;
    });
  }

  async conflictCounts(project: string, since?: Timestamp): Promise<Map<string, number>> {
    return (await this.conflictsByProject(this.db, [project], since)).get(project) ?? new Map();
  }

  /** Recorded conflicts per project and path, only rows at or after `since` when given (design 05-dependencies). */
  private async conflictsByProject(q: SqlExecutor, projects: readonly string[], since?: Timestamp): Promise<Map<string, Map<string, number>>> {
    const out = new Map<string, Map<string, number>>();
    const when = since === undefined ? "" : "AND at >= ?";
    const rows = projects.length === 0 ? [] : await q.all(`SELECT project_key, path, COUNT(*) AS n FROM controller_file_conflicts
       WHERE project_key IN (${placeholders(projects.length)}) ${when} GROUP BY project_key, path`, since === undefined ? [...projects] : [...projects, since]);
    for (const r of rows) out.set(r.project_key as string, (out.get(r.project_key as string) ?? new Map<string, number>()).set(r.path as string, Number(r.n)));
    return out;
  }

  listClaimDecisions(id: WorkItemId) { return deps.listClaimDecisions(this.db, id); }
  listClaimDecisionsSince(since: Timestamp) { return deps.listClaimDecisionsSince(this.db, since); }
  listLatestClaimDecisions(ids: readonly WorkItemId[]) { return deps.listLatestClaimDecisions(this.db, ids); }
  approveClaimHold(input: ApproveClaimHoldInput) { return deps.approveClaimHold(this.db, this.steps, input); }

  // PR heads and handoffs: pr-heads.ts
  recordPushedHead(runId: RunId, token: number, head_sha: string) { return prHeads.recordPushedHead(this.db, runId, token, head_sha); }
  recordPrHead(input: RecordPrHeadInput) { return prHeads.recordPrHead(this.db, this.time, this.steps, input); }
  appendHandoff(input: Omit<Handoff, "id" | "at">, token: number) { return prHeads.appendHandoff(this.db, this.time, input, token); }
  listHandoffs(id: WorkItemId) { return prHeads.listHandoffs(this.db, id); }

  // Unreviewed merges: unreviewed-merges.ts
  async recordUnreviewedMerge(input: NewUnreviewedMerge) { assertProjectKey(input.project); return merges.recordUnreviewedMerge(this.db, this.now(), input); }
  listUnreviewedMerges(limit: number) { return merges.listUnreviewedMerges(this.db, limit); }
  countUnreviewedMergesSince(since: Timestamp) { return merges.countUnreviewedMergesSince(this.db, since); }
  listUntitledUnreviewedMerges(project: string, limit: number) { return merges.listUntitledUnreviewedMerges(this.db, project, limit); }
  setUnreviewedMergeTitle(id: UnreviewedMergeId, title: string) { return merges.setUnreviewedMergeTitle(this.db, id, title); }

  // Cursors and stream intake: intake.ts
  getCursor(name: string) { return intake.getCursor(this.db, name); }
  advanceCursor(name: string, expected: string | null, next: string) { return intake.advanceCursor(this.db, name, expected, next); }
  appendInbox(input: NewInboxEvent) { return intake.appendInbox(this.db, this.time, input); }
  listInboxAfter(source_type: SourceType, after_seq: number, limit: number) { return intake.listInboxAfter(this.db, source_type, after_seq, limit); }

  async acquireListenerLease(source_type: SourceType, owner: string, lease_ms: number): Promise<ListenerLeaseResult> {
    return this.db.transaction(async (tx): Promise<ListenerLeaseResult> => {
      const expires_at = this.after(lease_ms);
      const created = await this.insertOnce(
        tx,
        "INSERT INTO inbound_listener_leases (source_type, owner, token, expires_at) VALUES (?, ?, 1, ?)",
        [source_type, owner, expires_at],
      );
      if (created) return { ok: true, lease: { source_type, owner, token: 1, expires_at } };
      // Conditional: only an expired (or released) lease can be taken, and taking it bumps the token.
      const taken = await tx.run(
        "UPDATE inbound_listener_leases SET owner = ?, token = token + 1, expires_at = ? WHERE source_type = ? AND expires_at <= ?",
        [owner, expires_at, source_type, this.now()],
      );
      const lease = await this.selectListenerLease(tx, source_type);
      return taken === 1 ? { ok: true, lease: lease! } : { ok: false, reason: "held", holder: lease };
    });
  }

  async renewListenerLease(source_type: SourceType, token: number, lease_ms: number): Promise<ListenerLeaseResult> {
    return this.db.transaction(async (tx): Promise<ListenerLeaseResult> => {
      const renewed = await tx.run("UPDATE inbound_listener_leases SET expires_at = ? WHERE source_type = ? AND token = ?", [
        this.after(lease_ms), source_type, token,
      ]);
      const lease = await this.selectListenerLease(tx, source_type);
      return renewed === 1 ? { ok: true, lease: lease! } : { ok: false, reason: "lease_lost", holder: lease };
    });
  }

  async releaseListenerLease(source_type: SourceType, token: number): Promise<void> {
    await this.db.transaction((tx) =>
      tx.run("UPDATE inbound_listener_leases SET expires_at = ? WHERE source_type = ? AND token = ?", [this.now(), source_type, token]),
    );
  }

  // Sync leases (design 05-coordination, sync lease)

  async acquireSyncLease(name: string, owner: string, lease_ms: number): Promise<SyncLeaseResult> {
    return this.db.transaction(async (tx): Promise<SyncLeaseResult> => {
      const expires_at = this.after(lease_ms);
      const created = await this.insertOnce(tx, "INSERT INTO inbound_sync_leases (name, owner, token, expires_at) VALUES (?, ?, 1, ?)", [
        name, owner, expires_at,
      ]);
      if (created) return { ok: true, lease: { name, owner, token: 1, expires_at } };
      // Conditional: the holder itself extends its lease with the same token; anyone else takes only an expired (or
      // released) lease, and taking it bumps the token.
      const taken = await tx.run(
        `UPDATE inbound_sync_leases SET token = CASE WHEN owner = ? THEN token ELSE token + 1 END, owner = ?, expires_at = ?
         WHERE name = ? AND (owner = ? OR expires_at <= ?)`,
        [owner, owner, expires_at, name, owner, this.now()],
      );
      const lease = await this.selectSyncLease(tx, name);
      return taken === 1 ? { ok: true, lease: lease! } : { ok: false, reason: "held", holder: lease };
    });
  }

  async renewSyncLease(name: string, token: number, lease_ms: number): Promise<SyncLeaseResult> {
    return this.db.transaction(async (tx): Promise<SyncLeaseResult> => {
      const renewed = await tx.run("UPDATE inbound_sync_leases SET expires_at = ? WHERE name = ? AND token = ?", [this.after(lease_ms), name, token]);
      const lease = await this.selectSyncLease(tx, name);
      return renewed === 1 ? { ok: true, lease: lease! } : { ok: false, reason: "lease_lost", holder: lease };
    });
  }

  async releaseSyncLease(name: string, token: number): Promise<void> {
    await this.db.transaction((tx) => tx.run("UPDATE inbound_sync_leases SET expires_at = ? WHERE name = ? AND token = ?", [this.now(), name, token]));
  }

  async getSyncLease(name: string): Promise<SyncLease | null> {
    return this.selectSyncLease(this.db, name);
  }
  // ./retention.ts; each batch that deletes rows writes its Activity row in its transaction (./activity.ts)
  pruneDeliveredOutbox(ms: number, limit: number) { return prunedWithActivity(this.db, () => this.now(), "outbox", ms, (tx) => pruneDeliveredOutbox(tx, this.after(-ms), limit)); }
  pruneHandledCommands(ms: number, limit: number) { return prunedWithActivity(this.db, () => this.now(), "commands", ms, (tx) => pruneHandledCommands(tx, this.after(-ms), limit)); }
  pruneHistory(ms: number, limit: number) { return prunedWithActivity(this.db, () => this.now(), "history", ms, (tx) => pruneHistory(tx, this.after(-ms), this.now(), limit)); }
  recordEndedPause(p: Parameters<FactoryStore["recordEndedPause"]>[0]) { return this.insertOnce(this.db, PAUSE_INSERT_ROW, [p.name, p.started_at, p.ended_at]); } // ./retention.ts
  pauseAt(at: Timestamp) { return pauseAt(this.db, at); }

  // Forge budget (design 05-sources, call budget)

  async getForgeBudget(project: string, plugin: string): Promise<ForgeBudget | null> {
    const [row] = await this.db.all("SELECT * FROM outbound_forge_budget WHERE project_key = ? AND plugin = ?", [project, plugin]);
    return row ? rowToForgeBudget(row) : null;
  }

  async putForgeBudget(b: ForgeBudget): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const values = [b.remaining, b.limit, b.reset_at, b.updated_at];
      const created = await this.insertOnce(
        tx,
        "INSERT INTO outbound_forge_budget (project_key, plugin, remaining, `limit`, reset_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [b.project, b.plugin, ...values],
      );
      if (created) return true;
      // Conditional: only a newer reading replaces the row, so replicas writing out of order keep the latest.
      const n = await tx.run(
        "UPDATE outbound_forge_budget SET remaining = ?, `limit` = ?, reset_at = ?, updated_at = ? WHERE project_key = ? AND plugin = ? AND updated_at < ?",
        [...values, b.project, b.plugin, b.updated_at],
      );
      return n === 1;
    });
  }

  // Identity links (design 2026-11-01) and the one owner (issue #577): identity-links.ts
  resolveLink(provider: LinkedAccount["provider"], subject: string) { return links.resolveLink(this.db, provider, subject); }
  listLinks(user_id: UserId) { return links.listLinks(this.db, user_id); }
  createLinkCode(user_id: UserId, code: string) { return links.createLinkCode(this.db, this.time, user_id, code); }
  redeemLinkCode(code: string, account: LinkedAccount) { return links.redeemLinkCode(this.db, this.time, code, account); }
  getOwner() { return links.getOwner(this.db); }
  claimOwner(user_id: UserId) { return links.claimOwner(this.db, this.time, user_id); }
  recordOwnerDecision(d: OwnerDecision) { return links.recordOwnerDecision(this.db, this.time, d); }

  // Runtime settings overrides (design 2026-11-03): settings.ts
  listSettingOverrides() { return settingsSql.listSettingOverrides(this.db); }
  setSettingOverride(input: SetSettingInput) { return settingsSql.setSettingOverride(this.db, this.time, input); }
  resetSettingOverride(input: ResetSettingInput) { return settingsSql.resetSettingOverride(this.db, this.time, input); }
  listSettingChanges(limit: number) { return settingsSql.listSettingChanges(this.db, limit); }

  // Learned settings (design 08-settings): in ./settings.ts, beside the overrides' row mappers.
  getLearnedSetting(project: string, key: string) {
    return settingsSql.getLearnedSetting(this.db, project, key);
  }

  listLearnedSettings() {
    return settingsSql.listLearnedSettings(this.db);
  }

  setLearnedSetting(input: Parameters<FactoryStore["setLearnedSetting"]>[0]) {
    return settingsSql.setLearnedSetting(this.db, input, this.now());
  }

  resetLearnedSetting(input: ResetSettingInput) {
    return settingsSql.resetLearnedSetting(this.db, input, this.now());
  }

  listLearnedSettingChanges(limit: number) {
    return settingsSql.listLearnedSettingChanges(this.db, limit);
  }

  // Merge checks (design §5 Merge check, issue #248) and GitHub sync records (design §5, GitHub call budget): github-sync.ts
  recordMergeCheck(c: NewMergeCheck) { return sync.recordMergeCheck(this.db, this.time, c); }
  getMergeCheck(work_item_id: WorkItemId) { return sync.getMergeCheck(this.db, work_item_id); }
  clearMergeCheck(work_item_id: WorkItemId) { return sync.clearMergeCheck(this.db, work_item_id); }
  listMergeChecks(work_item_ids: readonly WorkItemId[]) { return sync.listMergeChecks(this.db, work_item_ids); }
  getPostedComment(source_id: string, marker: string, body: string) { return sync.getPostedComment(this.db, this.time, source_id, marker, body); }
  recordPostedComment(c: NewPostedComment) { return sync.recordPostedComment(this.db, this.time, c); }
  recordCommentFailure(source_id: string, marker: string, attempts: number, delay_ms: number) { return sync.recordCommentFailure(this.db, this.time, source_id, marker, attempts, delay_ms); }
  claimLabelWrite(source_id: string, target: LabelTarget, status: string, ttl_ms: number) { return sync.claimLabelWrite(this.db, this.time, source_id, target, status, ttl_ms); }
  recordLabelState(source_id: string, target: LabelTarget, status: string, token: string) { return sync.recordLabelState(this.db, this.time, source_id, target, status, token); }
  releaseLabelClaim(source_id: string, target: LabelTarget, token: string) { return sync.releaseLabelClaim(this.db, source_id, target, token); }
  listLabelStates(source_ids: readonly string[]) { return sync.listLabelStates(this.db, source_ids); }

  // Their reads for reactions (issue #524), and the row mapper, live in posted-comments.ts.
  listPostedCommentsById(comment_id: string): Promise<PostedComment[]> {
    return posted.listPostedCommentsById(this.db, comment_id);
  }

  /** Posted at or after the store clock's now minus `within_ms`. */
  listPostedComments(source_prefix: string, within_ms: number): Promise<PostedComment[]> {
    return posted.listPostedComments(this.db, source_prefix, this.after(-within_ms));
  }

  // Worker processes, host sleeps and restart history: worker-health.ts; alerts (design 05-alarms): alerts.ts
  reportWorkerProcess(r: WorkerProcessReport) { return health.reportWorkerProcess(this.db, this.time, r); }
  listWorkerProcesses(max_age_ms: number) { return health.listWorkerProcesses(this.db, this.time, max_age_ms); }
  removeWorkerProcess(process_id: string) { return health.removeWorkerProcess(this.db, process_id); }
  recordHostSleep(sleep: HostSleep) { return health.recordHostSleep(this.db, sleep); }
  listHostSleeps(opts: { limit: number; work_item_id?: WorkItemId }) { return health.listHostSleeps(this.db, opts); }
  recordAlert(input: NewAlert, dedupe_ms: number) { return alerts.recordAlert(this.db, this.now(), input, this.after(-dedupe_ms)); }
  listAlerts(opts: { limit: number }) { return alerts.listAlerts(this.db, opts.limit); }
  dismissAlert(alert_id: string, actor: UserId) { return alerts.dismissAlert(this.db, this.now(), alert_id, actor); }
  listAlertDismissals(since: Timestamp) { return alerts.listAlertDismissals(this.db, since); }
  recordChildRestart(restart: ChildRestart) { return health.recordChildRestart(this.db, restart); }
  listChildRestartsWithin(window_ms: number) { return health.listChildRestartsWithin(this.db, this.time, window_ms); }

  // Local work items (issue #198): the item thread, its outbox (issue #282) and the command inbox (issue #245) in local-items.ts
  recordRunIntent(intent: RunIntent) { return local.recordRunIntent(this.db, this.time, intent); }
  recordItemMessage(input: NewItemMessage) { return local.recordItemMessage(this.db, this.time, input); }
  listItemMessages(work_item_id: WorkItemId) { return local.listItemMessages(this.db, work_item_id); }
  listPendingDeliveries(source_types: readonly SourceType[], limit: number) { return local.listPendingDeliveries(this.db, this.time, source_types, limit); }
  listDeliveries(work_item_id: WorkItemId) { return local.listDeliveries(this.db, work_item_id); }
  claimDelivery(seq: number, lease_ms: number, fence?: SyncFence) { return local.claimDelivery(this.db, this.time, seq, lease_ms, fence); }
  getDelivery(seq: number) { return local.getDelivery(this.db, seq); }
  finishDelivery(seq: number, token: number, url: string | null) { return local.finishDelivery(this.db, this.time, seq, token, url); }
  linkDelivery(seq: number) { return local.linkDelivery(this.db, seq); }
  failDelivery(seq: number, token: number, error: string, retry_in_ms: number) { return local.failDelivery(this.db, this.time, seq, token, error, retry_in_ms); }
  async appendCliCommand(input: NewCliCommand) { return local.appendCliCommand(this.db, this.time, input, await readPermissionMode(this)); } // the mode read from the store at this write (design 08-permissions)
  listCliCommandsAfter(after_seq: number, limit: number) { return local.listCliCommandsAfter(this.db, after_seq, limit); }
  listUnmirroredCliCommands(limit: number) { return local.listUnmirroredCliCommands(this.db, limit); }
  markCliCommandMirrored(key: string) { return local.markCliCommandMirrored(this.db, this.time, key); }
  recordAppCommandRequest(input: NewAppCommandRequest) { return local.recordAppCommandRequest(this.db, this.time, input); }
  markAppCommandRequest(seq: number, refusal: string | null) { return local.markAppCommandRequest(this.db, this.time, seq, refusal); }
  getAppCommandRequest(ref: number | string) { return local.getAppCommandRequest(this.db, ref); }
  listAppCommandRequestsForItem(id: WorkItemId, limit: number) { return local.listAppCommandRequestsForItem(this.db, id, limit); }
  listItemCommands(id: WorkItemId, limit: number) { return local.listItemCommands(this.db, id, limit); }

  // The base push (design 05-sources, Local items; RFC 0015 M8): base-push.ts
  getBasePush(work_item_id: WorkItemId) { return basePush.getBasePush(this.db, work_item_id); }
  listBasePushBacklogs() { return basePush.listBasePushBacklogs(this.db); }
  // Raw table reads (design §9 Data page, issue #239). Names come only from the catalog (tables.ts). The Ask's query is the driver's (SQLite only).
  get readOnlyQuery(): FactoryStore["readOnlyQuery"] { return (this.db as Pick<FactoryStore, "readOnlyQuery">).readOnlyQuery?.bind(this.db); }
  listTables() { return tables.listTables(this.db); }
  listTableRows(input: TablePageInput) { return tables.listTableRows(this.db, input); }

  // Internals
  private async selectSyncLease(q: SqlExecutor, name: string): Promise<SyncLease | null> {
    const [row] = await q.all("SELECT * FROM inbound_sync_leases WHERE name = ?", [name]);
    return row ? { name: row.name as string, owner: row.owner as string, token: Number(row.token), expires_at: row.expires_at as Timestamp } : null;
  }

  private async selectListenerLease(q: SqlExecutor, source_type: SourceType): Promise<ListenerLease | null> {
    const [row] = await q.all("SELECT * FROM inbound_listener_leases WHERE source_type = ?", [source_type]);
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
  private insertOnce(tx: SqlExecutor, sql: string, params: SqlValue[]): Promise<boolean> {
    return insertOnce(this.db, tx, sql, params);
  }

  /** A patch's diff as assignments, with change_url when it sets change_ref (on the patched project). */
  private async patchSql(tx: SqlExecutor, current: WorkItem, patch: WorkItemPatch): Promise<ReturnType<typeof diffPatch>> {
    const diff = diffPatch(current, patch);
    const change = await changeAssignments(tx, patch.project ?? current.project, diff.changes, patch.change_url ?? null);
    return { changes: diff.changes, sets: [...diff.sets, ...change.sets], values: [...diff.values, ...change.values] };
  }

  private now(): Timestamp {
    return this.clock.now().toISOString() as Timestamp;
  }

  private after(ms: number): Timestamp {
    return new Date(this.clock.now().getTime() + ms).toISOString() as Timestamp;
  }

  private async selectItem(q: SqlExecutor, id: WorkItemId): Promise<WorkItem | null> {
    const [row] = await q.all(`SELECT * FROM controller_work_items WHERE id = ?`, [id]);
    return row ? rowToWorkItem(row) : null;
  }

  private async selectItemBySource(q: SqlExecutor, type: SourceType, sourceId: string): Promise<WorkItem | null> {
    const [row] = await q.all("SELECT * FROM controller_work_items WHERE source_type = ? AND source_id = ?", [type, sourceId]);
    return row ? rowToWorkItem(row) : null;
  }

  private async selectVerdictByComment(q: SqlExecutor, commentId: string): Promise<Verdict | null> {
    const [row] = await q.all("SELECT * FROM controller_verdicts WHERE comment_id = ?", [commentId]);
    return row ? rowToVerdict(row) : null;
  }

  private async selectCheckpoint(q: SqlExecutor, id: BudgetCheckpointId): Promise<BudgetCheckpoint | null> {
    const [row] = await q.all(`SELECT * FROM controller_budget_checkpoints WHERE id = ?`, [id]);
    return row ? rowToBudgetCheckpoint(row) : null;
  }

  private async selectRun(q: SqlExecutor, id: RunId): Promise<Run | null> {
    const [row] = await q.all(`SELECT * FROM worker_runs WHERE id = ?`, [id]);
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
    const rows = await tx.all(`SELECT id FROM worker_runs WHERE work_item_id = ? AND status = ?`, [
      workItemId, status,
    ]);
    const cancelled: RunId[] = [];
    for (const r of rows) if (await this.cancelRun(tx, r.id as RunId, status, now)) cancelled.push(r.id as RunId);
    return cancelled;
  }

  /** Cancels the run if still `status` (lease cleared, attempt closed `cancelled`), storing `outcome` if given (a takeover's). */
  private async cancelRun(tx: SqlExecutor, id: RunId, status: "queued" | "running", now: Timestamp, outcome: RunOutcome | null = null): Promise<boolean> {
    const n = await tx.run("UPDATE worker_runs SET status = 'cancelled', outcome = COALESCE(?, outcome), lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = ?",
      [outcome === null ? null : JSON.stringify(outcome), now, id, status]);
    if (n === 1) await this.closeAttempt(tx, id, status === "running" ? null : "paused", "cancelled", now);
    return n === 1;
  }

  /**
   * The attempt record of a claim that just committed in `tx` (design §6): numbered after the run's last record,
   * so a resume of a paused run gets its own; keyed to the claim's lease token for the close.
   */
  private async openAttempt(tx: SqlExecutor, run: Run, now: Timestamp): Promise<void> {
    const [last] = await tx.all("SELECT MAX(attempt) AS n FROM worker_run_attempts WHERE run_id = ?", [run.id]);
    await tx.run(
      `INSERT INTO worker_run_attempts (run_id, attempt, lease_token, worker_id, status, started_at, finished_at, error_code,
         failure_class, tokens) VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, 0)`,
      [run.id, Number(last?.n ?? 0) + 1, run.lease!.token, run.lease!.owner, now],
    );
  }

  /**
   * Closes the run's open attempt record: the one claim `token` opened (completeRun, pauseRun, the reaper); null: any
   * open one (a cancel); "paused": the latest if paused (a paused run's cancel). A failed outcome gives its error code,
   * failureClass() and outcomeTokens(); a reaped claim gives lease_expired and infra; anything else neither.
   */
  private async closeAttempt(
    tx: SqlExecutor, runId: RunId, token: number | null | "paused", status: Exclude<RunAttemptStatus, "running">, now: Timestamp,
    outcome: RunOutcome | null = null,
  ): Promise<void> {
    const failed = outcome?.status === "failed" ? outcome : null;
    const error_code = failed ? failed.error_code : status === "lease_expired" ? "lease_expired" : null;
    const failure_class = failed ? failureClass(failed) : status === "lease_expired" ? "infra" : null;
    const open = token === "paused" ? `status = 'paused' AND attempt = (SELECT MAX(b.attempt) FROM worker_run_attempts b WHERE b.run_id = ?)`
      : `status = 'running'${token === null ? "" : " AND lease_token = ?"}`;
    await tx.run(
      `UPDATE worker_run_attempts SET status = ?, finished_at = COALESCE(finished_at, ?), error_code = ?, failure_class = ?, tokens = ? WHERE run_id = ? AND ${open}`,
      [status, now, error_code, failure_class, outcomeTokens(outcome), runId, ...(token === null ? [] : [token === "paused" ? runId : token])],
    );
  }

  /** Returns the new run, or null if the idempotency key already existed. */
  private async insertRun(tx: SqlExecutor, input: NewRun): Promise<Run | null> {
    const id = newId("run") as RunId;
    const now = this.now();
    const inserted = await this.insertOnce(
      tx,
      `INSERT INTO worker_runs (id, work_item_id, kind, idempotency_key, status, attempt, lease_token, not_before, input, created_at, updated_at)
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
      id: newId("sc") as StateChangeId, work_item_id: workItemId, version, at: this.now(),
      actor, reason, changes, detail,
    };
    await tx.run(
      "INSERT INTO controller_state_changes (id, work_item_id, version, at, actor, reason, changes, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
/** The claim pause for a forge 401/403: no implement-type claim. A second row of the same table (migration 4, both backends), so no schema change. */
const FORGE_AUTH_PAUSE: ClaimPauseName = "forge_auth";
/**
 * The claim pause for a push_access or pr_api preflight check that failed other than with a 401/403 (issue #216):
 * no implement-type claim, as for forge_auth. Its own row of the same table, so no schema change.
 */
const PREFLIGHT_ACCESS_PAUSE: ClaimPauseName = "preflight_access";

/** A probe pause is in effect while its next probe time is after the last answered probe (none: always). */
function probeInEffect(probeAt: string | undefined, answeredAt: string | undefined): boolean {
  return probeAt !== undefined && probeAt > (answeredAt ?? "");
}

function rowToForgeBudget(row: Row): ForgeBudget {
  return {
    project: row.project_key as string,
    plugin: row.plugin as string,
    remaining: Number(row.remaining),
    limit: Number(row.limit),
    reset_at: row.reset_at as Timestamp,
    updated_at: row.updated_at as Timestamp,
  };
}

/** The WHERE clause (with leading space, or empty) for a WorkItemFilter. */
function whereOf(filter: Omit<WorkItemFilter, "limit">): { where: string; params: SqlValue[] } {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (filter.stage !== undefined) {
    where.push("stage = ?");
    params.push(filter.stage);
  } else if (filter.exclude_closed) where.push("stage <> 'CLOSED'");
  if (filter.exclude_system) where.push("(blocked_reason IS NULL OR blocked_reason <> 'system_item')");
  if (filter.blocked_on !== undefined) {
    where.push("blocked_on = ?");
    params.push(filter.blocked_on);
  }
  // `updated_since`: with stage CLOSED, the closes since then (owner notices, design 09-notifications).
  for (const [sql, v] of [["blocked_reason = ?", filter.blocked_reason], ["updated_at >= ?", filter.updated_since]] as const) {
    if (v !== undefined) { where.push(sql); params.push(v); }
  }
  return { where: where.length ? ` WHERE ${where.join(" AND ")}` : "", params };
}

/** The `worker_pauses` row that pauses every worker loop (`workers pause --all`). */
const ALL_WORKERS = "*" as const;
const PAUSE_INSERT = "INSERT INTO worker_pauses (worker_id, paused_by, paused_at) VALUES (?, ?, ?)";

function rowToWorkerPause(r: Row): WorkerPause {
  return { worker_id: r.worker_id as WorkerId | "*", paused_by: r.paused_by as string, paused_at: r.paused_at as Timestamp };
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

function rowToStandingProposal(row: Row): StandingProposal {
  return {
    id: row.id as StandingProposalId, gate: row.gate as StandingGate, tier: Number(row.tier) as Tier,
    run_length: Number(row.run_length), threshold: Number(row.threshold), created_at: row.created_at as Timestamp,
  };
}

