import type { FactoryConfig } from "./config.js";
import type { Logger } from "./log.js";
import { type TriageOutput, parseReview, parseTriage } from "./outputs.js";
import { effectiveTier, floorTier, needsSpecApproval, runKey, workItemIdFromBranch } from "./policy.js";
import type { Actor, Run, RunKind, WorkItem, WorkItemId } from "./types.js";
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

const SYSTEM: Actor = { kind: "system", id: "system:controller" };
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
        const principal = await this.principal(e.requester, "submit_work", e.source.id);
        if (!principal) return;
        const { item, created } = await this.d.store.createWorkItem(
          {
            source: e.source,
            requester_id: principal.user_id,
            project: `${this.d.config.repo.owner}/${this.d.config.repo.name}`,
            problem: `${e.title}\n\n${e.body}`.trim(),
            resources: [e.source.link],
          },
          { kind: "user", id: principal.user_id },
          { enqueue: { kind: "triage", idempotency_key: `${e.source.type}:${e.source.id}:triage` } },
        );
        if (created) this.d.log.info("intake", { work_item_id: item.id });
        return;
      }
      case "spec_approved":
      case "spec_rejected": {
        const item = await this.d.store.getWorkItemBySource(e.source.type, e.source.id);
        if (!item) return;
        const principal = await this.principal(e.approver, "approve_spec", item.id);
        if (!principal) return;
        const actor: Actor = { kind: "user", id: principal.user_id };
        return this.decide(item.id, (it) => {
          if (it.stage !== "READY" || it.blocked_reason !== "spec_pending") return null;
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
        });
      }
      case "retry_requested": {
        const item = await this.d.store.getWorkItemBySource(e.source.type, e.source.id);
        if (!item) return;
        const principal = await this.principal(e.requester, "approve_spec", item.id);
        if (!principal) return;
        return this.decide(item.id, (it) => {
          const kind = it.blocked_reason?.match(/^run_failed:(triage|implement|review):/)?.[1] as RunKind | undefined;
          if (it.blocked_on !== "human" || !kind) return null;
          const next = { ...it, restart_count: it.restart_count + 1 };
          return {
            patch: { blocked_on: "none", blocked_reason: null, restart_count: next.restart_count },
            actor: { kind: "user", id: principal.user_id },
            reason: "retry_requested",
            enqueue: { kind, idempotency_key: runKey(next, kind) },
          };
        });
      }
      case "pr_merged":
      case "pr_closed": {
        const id = workItemIdFromBranch(e.head_branch, this.d.config.branch_prefix);
        if (!id) return;
        // The human who merged is the approver of record (design §8). GitHub already enforced their permission.
        const merger = e.kind === "pr_merged" && e.merger ? await this.d.auth.resolve(e.merger) : null;
        const actor: Actor = merger ? { kind: "user", id: merger.user_id } : { kind: "system", id: "system:post-merge" };
        return this.decide(id as WorkItemId, (it) => {
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
    }
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
          const tier = effectiveTier(spec.tier, floorTier(spec.allowed_paths, this.d.config.floors), it.tier);
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
          await this.comment(it, `spec:${run.id}`, renderSpec(spec, tier));
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
      }
    });
  }

  // Internals

  /** Whether the item is in the state a finished run of this kind should advance. */
  private expects(it: WorkItem, kind: RunKind): boolean {
    if (it.stage === "CLOSED" || it.blocked_on !== "none") return false;
    if (kind === "triage") return it.stage === "NEW";
    if (kind === "implement") return it.stage === "RUNNING";
    return it.stage === "REVIEW";
  }

  /** Re-read → decide → conditional transition, retrying on version conflicts. */
  private async decide(id: WorkItemId, fn: (item: WorkItem) => Decision | Promise<Decision>): Promise<void> {
    for (let i = 0; i < MAX_CONFLICT_RETRIES; i++) {
      const item = await this.d.store.getWorkItem(id);
      if (!item) return;
      const decision = await fn(item);
      if (!decision) return;
      const r = await this.d.store.transition({ ...decision, id, expected_version: item.version });
      if (r.ok) {
        this.d.log.info("transition", { work_item_id: id, reason: decision.reason, version: r.item.version });
        return;
      }
      if (r.reason !== "version_conflict") {
        this.d.log.warn("transition refused", { work_item_id: id, reason: r.reason });
        return;
      }
    }
    this.d.log.warn("transition gave up after conflicts", { work_item_id: id });
  }

  private async principal(identity: ExternalIdentity, action: AuthAction, resource: string): Promise<Principal | null> {
    const principal = await this.d.auth.resolve(identity);
    if (!principal) return null;
    const decision = await this.d.auth.authorize(principal, action, { kind: "work_item", id: resource });
    if (!decision.allow) {
      this.d.log.warn("unauthorized", { user_id: principal.user_id, action, reason: decision.reason });
      return null;
    }
    return principal;
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

function renderSpec(spec: TriageOutput, tier: number): string {
  return [
    "## Factory spec",
    "",
    `**Problem**\n${spec.problem}`,
    "",
    "**Done when**",
    ...spec.done_criteria.map((c) => `- ${c}`),
    "",
    `**Desired output**: ${spec.desired_output}`,
    `**Scope**: ${spec.scope}`,
    `**Allowed paths**: ${spec.allowed_paths.map((p) => `\`${p}\``).join(", ")}`,
    `**Files to change**: ${spec.files_to_change.map((p) => `\`${p}\``).join(", ")}`,
    `**Tier**: ${tier} (${spec.tier_reason})`,
    "",
    "Reply `/approve` to start implementation, or `/reject <reason>` to close.",
  ].join("\n");
}
