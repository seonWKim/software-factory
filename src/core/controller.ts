import type { FactoryConfig } from "./config.js";
import { parseFixReferences, parseRevert } from "./links.js";
import type { Logger } from "./log.js";
import { parseReview, parseTriage } from "./outputs.js";
import { effectiveTier, floorTier, needsSpecApproval, runKey, workItemIdFromBranch } from "./policy.js";
import { renderSpec } from "./spec-comment.js";
import type { Actor, Run, RunKind, SourceRef, StateChangeDetail, WorkItem, WorkItemId } from "./types.js";
import type { AuthAction, AuthProvider, ExternalIdentity, Principal } from "../interfaces/auth-provider.js";
import type { Clock } from "../interfaces/clock.js";
import type { FactoryStore, TransitionInput } from "../interfaces/factory-store.js";
import type { SourceAdapter, SourceEvent } from "../interfaces/source-adapter.js";

export interface ControllerDeps {
  store: FactoryStore;
  source: SourceAdapter;
  auth: AuthProvider;
  clock: Clock;
  config: FactoryConfig;
  log: Logger;
}

type Decision = Omit<TransitionInput, "id" | "expected_version"> | null;
/** Why a human's command was not applied; posted back to them. Plain null stays a silent no-op. */
type Refusal = { refuse: string };
type CommandEvent = Extract<SourceEvent, { kind: "spec_approved" | "spec_rejected" | "retry_requested" }>;
type BaseCommitEvent = Extract<SourceEvent, { kind: "base_commit" }>;

const COMMAND: Record<CommandEvent["kind"], string> = {
  spec_approved: "/approve",
  spec_rejected: "/reject",
  retry_requested: "/retry",
};

const SYSTEM: Actor = { kind: "system", id: "system:controller" };
/** Records reverts and fix-forwards (design §6). */
const LINKS: Actor = { kind: "system", id: "system:links" };
const MAX_CONFLICT_RETRIES = 5;

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
    let lastPoll = -Infinity;
    while (!signal.aborted) {
      const now = this.d.clock.now().getTime();
      if (now - lastPoll >= this.d.config.poll_interval_ms) {
        lastPoll = now;
        await this.guard("intake", () => this.tickIntake());
      }
      await this.guard("runs", () => this.tickRuns());
      await this.guard("reaper", () => this.tickReaper());
      await this.d.clock.sleep(this.d.config.tick_ms, signal).catch(() => undefined);
    }
  }

  async tickIntake(): Promise<void> {
    const name = `intake:${this.d.source.type}`;
    const cursor = await this.d.store.getCursor(name);
    const { events, next_cursor } = await this.d.source.poll(cursor);
    for (const e of events) await this.guard(`event:${e.kind}`, () => this.handleEvent(e));
    await this.d.store.advanceCursor(name, cursor, next_cursor);
  }

  async tickRuns(): Promise<void> {
    for (const run of await this.d.store.listUnacknowledgedRuns(20)) {
      await this.guard(`run:${run.kind}`, () => this.applyRun(run));
    }
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
    const ids = await this.d.store.expireLeases(this.d.config.max_attempts);
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
        if (created) this.d.log.info("intake", { work_item_id: item.id });
        await this.markSeen(e.source, null);
        // Every delivery re-checks the link, so a re-polled issue finishes a link a crash interrupted.
        await this.linkFixForward(item.id, `${e.title}\n${e.body}`);
        return;
      }
      case "base_commit":
        return this.recordReverts(e);
      case "spec_approved":
      case "spec_rejected":
      case "retry_requested":
        return this.handleCommand(e);
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
    const item = await this.d.store.getWorkItemBySource(e.source.type, e.source.id);
    if (!item) return;
    const principal = await this.authorize(e.kind === "retry_requested" ? e.requester : e.approver, "approve_spec", item.id);
    const refusal = "refuse" in principal
      ? principal.refuse
      : await this.decide(item.id, (it) => command(e, it, { kind: "user", id: principal.user_id }));
    await this.markSeen(e.source, e.comment_id);
    if (refusal === null) return;
    this.d.log.info("command refused", { work_item_id: item.id, command: e.kind, reason: refusal });
    await this.d.source.postComment(
      item.source,
      `\`${COMMAND[e.kind]}\` was not applied: ${refusal}.`,
      `<!-- factory:refused:${e.comment_id} -->`,
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
        await this.comment(it, `run-failed:${run.id}`,
          `The ${run.kind} run failed (\`${code}\`). Comment \`/retry\` to run it again.`);
        return {
          patch: { blocked_on: "human", blocked_reason: `run_failed:${run.kind}:${code}` },
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
          if (!parsed.ok) {
            return {
              patch: { blocked_on: "human", blocked_reason: `run_failed:triage:invalid_output` },
              actor: SYSTEM,
              reason: "run_failed",
              ack_run: run.id,
            };
          }
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
          await this.comment(it, `spec:${run.id}`, renderSpec(spec, tier, { floor, previous: it.tier }));
          return {
            patch: { ...fields, stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" },
            actor: SYSTEM,
            reason: "triaged",
            ack_run: run.id,
          };
        }
        case "implement": {
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
          if (!parsed.ok) {
            return {
              patch: { blocked_on: "human", blocked_reason: "run_failed:review:invalid_output" },
              actor: SYSTEM,
              reason: "run_failed",
              ack_run: run.id,
            };
          }
          const tier = effectiveTier(parsed.value.tier, floorTier(it.allowed_paths, this.d.config.floors), it.tier);
          if (parsed.value.verdict === "bug") {
            if (it.loop_count + 1 >= this.d.config.max_loops) {
              await this.comment(it, `max-loops:${run.id}`,
                `Review found bugs ${it.loop_count + 1} times (limit ${this.d.config.max_loops}). A human needs to decide.`);
              return {
                patch: { tier, token_cost: tokens, blocked_on: "human", blocked_reason: "max_loops" },
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
          await this.comment(it, `merge:${run.id}`,
            `PR #${it.pr_number} passed review (tier ${tier}). A human merge is required.`);
          return {
            patch: { tier, token_cost: tokens, blocked_on: "human", blocked_reason: "merge_pending" },
            actor: SYSTEM,
            reason: "review_passed",
            ack_run: run.id,
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
            case "tests_failed":
              return {
                patch: { blocked_reason: "merge_conflict_pending" },
                actor: SYSTEM,
                reason: data.result === "conflict" ? "update_conflict" : "update_tests_failed",
                ack_run: run.id,
              };
            default:
              return {
                patch: { blocked_reason: "run_failed:update:invalid_output" },
                actor: SYSTEM,
                reason: "run_failed",
                ack_run: run.id,
              };
          }
        }
      }
    });
  }

  // Internals

  /** Whether the item is in the state a finished run of this kind should advance. */
  private expects(it: WorkItem, kind: RunKind): boolean {
    // An update runs while the PR waits for a human merge, so the item stays blocked on that human throughout.
    if (kind === "update") return awaitingMerge(it);
    if (it.stage === "CLOSED" || it.blocked_on !== "none") return false;
    if (kind === "triage") return it.stage === "NEW";
    if (kind === "implement") return it.stage === "RUNNING";
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
      const decision = await fn(item);
      if (!decision) return null;
      if ("refuse" in decision) return decision.refuse;
      const r = await this.d.store.transition({ ...decision, id, expected_version: item.version });
      if (r.ok) {
        this.d.log.info("transition", { work_item_id: id, reason: decision.reason, version: r.item.version });
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

  private comment(it: WorkItem, key: string, body: string): Promise<void> {
    return this.d.source.postComment(it.source, body, `<!-- factory:${key} -->`);
  }

  private async guard(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.d.log.error("loop step failed", { step: what, error: err instanceof Error ? err.message.slice(0, 300) : "unknown" });
    }
  }
}

/** The transition a command asks for, or why the item's current state cannot take it. */
function command(e: CommandEvent, it: WorkItem, actor: Actor): Decision | Refusal {
  if (it.stage === "CLOSED") return { refuse: "the work item is closed" };
  if (e.kind === "retry_requested") {
    const kind = it.blocked_reason?.match(/^run_failed:(triage|implement|review|update):/)?.[1] as RunKind | undefined;
    if (it.blocked_on !== "human" || !kind) return { refuse: "there is no failed run to retry" };
    const next = { ...it, restart_count: it.restart_count + 1 };
    // A retried update goes back to waiting for the merge, which is the state an update run expects.
    const unblocked = kind === "update"
      ? { blocked_on: "human" as const, blocked_reason: "merge_pending" }
      : { blocked_on: "none" as const, blocked_reason: null };
    return {
      patch: { ...unblocked, restart_count: next.restart_count },
      actor,
      reason: "retry_requested",
      enqueue: { kind, idempotency_key: runKey(next, kind) },
    };
  }
  if (it.stage !== "READY" || it.blocked_reason !== "spec_pending") {
    return { refuse: `the spec is not waiting for approval (stage \`${it.stage}\`)` };
  }
  if (e.kind === "spec_rejected") {
    return {
      patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null },
      actor,
      reason: "spec_rejected",
    };
  }
  return {
    patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null },
    actor,
    reason: "spec_approved",
    enqueue: { kind: "implement", idempotency_key: runKey(it, "implement") },
  };
}

/** A PR that passed review and waits for a human merge: the only state an update run may change. */
function awaitingMerge(it: WorkItem): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "human" && it.blocked_reason === "merge_pending";
}
