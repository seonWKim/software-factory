// The forge's PR events: merged or closed, opened (adopt, record a pushed head), unmergeable (an update run).
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { prNumber } from "../../../core/change-ref.js";
import { SKIP_LABEL, floorTier, workItemIdFromBranch } from "../../../core/policy.js";
import { type Actor, type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { ForgeEvent } from "../../../interfaces/forge.js";
import { SYSTEM, updateKey, awaitingMerge } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

type PrOpenEvent = Extract<ForgeEvent, { kind: "change_open" }>;
type PrFinishedEvent = Extract<ForgeEvent, { kind: "change_merged" | "change_closed" }>;
/** The actor of a person's push whose commit author does not resolve to a user (design 2026-11-01). */
const PR_SYNC: Actor = { kind: "system", id: "system:pr-sync" };

/** The forge's PR events: merged or closed, opened (adopt, record a pushed head), unmergeable (an update run). */
export class PrEventsUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * One update run per (item, PR, head sha, base sha), from the forge's unmergeable flag or the local merge check
   * (design §5): both use this key, so either path finding the same conflict first enqueues the only run. None
   * while another update of this item is still in flight; the event repeats on every poll, so a skipped one
   * comes back.
   */
  async startUpdate(id: WorkItemId, change_ref: string, head_sha: string, base_sha: string): Promise<void> {
    const key = updateKey(id, change_ref, head_sha, base_sha);
    await this.c.unit("transitions").decide(id, async (it) => {
      if (!awaitingMerge(it) || it.change_ref !== change_ref) return null;
      const updates = (await this.c.k.d.store.listRuns(it.id)).filter((r) => r.kind === "update");
      if (updates.some((r) => r.idempotency_key === key || r.acknowledged_at === null)) return null;
      return { patch: {}, actor: SYSTEM, reason: "update_started", enqueue: { kind: "update", idempotency_key: key } };
    });
  }

  /**
   * A merged or closed PR (design 2026-11-01). A factory branch maps to its item, any other PR to its adopted
   * item by number; either closes the same way (a merge: CLOSED / completed, the merger as approver of record).
   * A merge with no item (skipped, never adopted, a fork, merged before a poll) writes one unreviewed merge.
   */
  async prFinished(e: PrFinishedEvent): Promise<void> {
    const item = await this.itemOfFinishedPr(e);
    if (!item) {
      if (e.kind === "change_merged") await this.recordUnreviewedMerge(e);
      return;
    }
    // The human who merged is the approver of record (design §8). The forge already enforced their permission.
    const merger = e.kind === "change_merged" && e.merger ? await this.c.k.d.auth.resolve(e.merger) : null;
    const actor: Actor = merger ? { kind: "user", id: merger.user_id } : { kind: "system", id: "system:post-merge" };
    if (e.kind === "change_merged") await this.mergeVerdict(item, e, merger ? actor : null);
    await this.c.unit("transitions").decide(item.id, (it) => {
      if (it.stage === "CLOSED" || it.change_ref !== e.change_ref) return null;
      return e.kind === "change_merged"
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
    await this.c.k.guard("dependents", () => this.c.unit("coordination").releaseDependents(item.source.id));
  }

  /**
   * The implicit verdict of a merged factory PR (design §4): one `accept`, severity `none`, for the merged head,
   * when no person pushed to it. Stored before the merge closes the item, so a crash between the two leaves the
   * item open and the next delivery merges it; a delivery after the merge records nothing more. None when the
   * merger does not resolve to a user.
   */
  async mergeVerdict(it: WorkItem, e: Extract<PrFinishedEvent, { kind: "change_merged" }>, merger: Actor | null): Promise<void> {
    if (it.origin !== "factory" || it.stage === "CLOSED" || it.change_ref !== e.change_ref) return;
    const id = it.id;
    const log = { work_item_id: id, pr_number: prNumber(e) };
    if (!merger) {
      this.c.k.d.log.warn("no implicit verdict: the merger does not resolve to a user", log);
      return;
    }
    if ((await this.c.k.d.store.listRuns(id)).some((r) => r.kind === "manual")) {
      this.c.k.d.log.info("no implicit accept: a person pushed to the PR", log);
      return;
    }
    await this.c.unit("verdicts").recordImplicitVerdict(id, {
      verdict: "accept", severity: "none", reason: "merged with no commits by people", key: `implicit:merged:${id}:${e.merge_sha}`,
      actor: merger, pr_head: it.last_head_sha,
    });
  }

  /** A factory branch's item (the decide checks its PR number), else the adopted item with this PR number. Forks have none. */
  async itemOfFinishedPr(e: PrFinishedEvent): Promise<WorkItem | null> {
    if (e.fork) return null;
    const id = workItemIdFromBranch(e.head_branch, this.c.k.cfg.branch_prefix);
    if (id) return this.c.k.d.store.getWorkItem(id as WorkItemId);
    const it = await this.c.k.d.store.getWorkItemByPr(this.c.k.project(), e.change_ref);
    return it?.origin === "adopted" ? it : null;
  }

  /** One row per merged PR with no item; the merger by user ID, null when the forge names none or it does not resolve. */
  async recordUnreviewedMerge(e: Extract<PrFinishedEvent, { kind: "change_merged" }>): Promise<void> {
    const merger = e.merger ? await this.c.k.d.auth.resolve(e.merger) : null;
    const { created } = await this.c.k.d.store.recordUnreviewedMerge({
      project: this.c.k.project(),
      change_ref: e.change_ref,
      merge_sha: e.merge_sha,
      merger_id: merger?.user_id ?? null,
    });
    if (created) {
      this.c.k.d.log.warn("unreviewed merge", { pr_number: prNumber(e), merge_sha: e.merge_sha, user_id: merger?.user_id ?? null, fork: e.fork ?? false });
    }
  }

  /**
   * An open PR (design 2026-11-01). A factory PR or an adopted one: its head is compared with the recorded
   * head. Any other PR is adopted, unless a user with write permission put `factory: skip` on it.
   */
  async prOpen(e: PrOpenEvent): Promise<void> {
    const id = workItemIdFromBranch(e.head_branch, this.c.k.cfg.branch_prefix);
    if (id) {
      const it = await this.c.k.d.store.getWorkItem(id as WorkItemId);
      if (it && it.change_ref === e.change_ref) await this.recordHead(it, e);
      return;
    }
    const known = await this.c.k.d.store.getWorkItemBySource(e.source.type, e.source.id);
    if (known) return this.recordHead(known, e);
    await this.adopt(e);
  }

  /**
   * Adoption: one item at REVIEW whose source is the PR, requested by its author, with the PR's files as
   * allowed_paths (so the floor tiers apply) and one review run, in one store transaction. The skip label is
   * checked here only; once adopted, a label changes nothing. The files are read only for a PR the store does
   * not know yet.
   */
  async adopt(e: PrOpenEvent): Promise<void> {
    const pr = prNumber(e);
    const log = { pr_number: pr };
    const author = e.author ? await this.c.k.d.auth.resolve(e.author) : null;
    if (!author) {
      this.c.k.d.log.warn("PR not adopted: its author does not resolve to a user", log);
      return;
    }
    const forge = this.c.k.forge;
    if (e.labels.includes(SKIP_LABEL)) {
      const adder = forge && pr !== null ? await forge.labelAddedBy(pr, SKIP_LABEL) : null;
      const who = adder ? await this.c.unit("auth").authorize(adder, "approve_spec", e.source.id) : null;
      if (who && !("refuse" in who)) {
        this.c.k.d.log.info("PR skipped: factory: skip label", { ...log, user_id: who.user_id });
        return;
      }
      this.c.k.d.log.warn("factory: skip label ignored: not added by a user with write permission; PR adopted", log);
    }
    const files = forge && pr !== null ? await forge.prFiles(pr) : [];
    const { item, created } = await this.c.k.d.store.createWorkItem(
      {
        source: e.source,
        title: e.title,
        requester_id: author.user_id,
        project: this.c.k.project(),
        problem: `${e.title}\n\n${e.body}`.trim(),
        resources: [e.source.link],
        adopted: {
          change_ref: e.change_ref,
          head_branch: e.head_branch,
          head_sha: e.head_sha,
          allowed_paths: files,
          tier: floorTier(files, this.c.k.settings(this.c.k.project()).floors),
        },
      },
      { kind: "user", id: author.user_id },
      { enqueue: { kind: "review", idempotency_key: `${e.source.type}:${e.source.id}:adopt:review`, input: await this.c.unit("checks-gate").reviewInput(pr, null) } },
    );
    if (!created) return;
    this.c.k.d.log.info("PR adopted", { ...log, work_item_id: item.id });
    await this.c.unit("outbox").showStatus(item);
  }

  /**
   * A head the factory did not record, on an open factory or adopted PR: one `manual` run with the pusher and
   * the range, changing no stage or blocked field (design 2026-11-01). Nothing is re-queued. While a run of the
   * item is running it may be pushing, and it records its own head; the PR is looked at again on a later poll.
   * An item with no recorded head (from before this) only takes the current head as its baseline.
   */
  async recordHead(it: WorkItem, e: PrOpenEvent): Promise<void> {
    if (it.stage === "CLOSED" || it.last_head_sha === e.head_sha) return;
    if ((await this.c.k.d.store.listRuns(it.id)).some((r) => r.status === "running")) return;
    if (it.last_head_sha === null) {
      await this.c.k.d.store.recordPrHead({ id: it.id, expected_head: null, head_sha: e.head_sha, manual: null });
      return;
    }
    const actor = await this.pusher(it.id, e.head_sha);
    const r = await this.c.k.d.store.recordPrHead({
      id: it.id,
      expected_head: it.last_head_sha,
      head_sha: e.head_sha,
      manual: { actor, change_ref: e.change_ref },
    });
    if (r.ok && r.run) {
      this.c.k.d.log.info("manual push recorded", { work_item_id: it.id, run_id: r.run.id, pr_number: prNumber(e), actor: actor.id });
      if (it.origin === "factory") await this.pushVerdict(it.id, it.last_head_sha, e.head_sha, actor);
    }
  }

  /** A person's push to a factory PR (design §4): one implicit `changes` for the new head, naming its commit count. */
  async pushVerdict(id: WorkItemId, from_sha: string, to_sha: string, actor: Actor): Promise<void> {
    let count: number | null = null;
    try {
      count = this.c.k.forge ? await this.c.k.forge.commitsBetween(from_sha, to_sha) : null;
    } catch (err) {
      this.c.k.d.log.warn("commit count not read; the verdict says it is unknown", { work_item_id: id, error: err instanceof Error ? err.message.slice(0, 300) : "unknown" });
    }
    const reason =
      count === null
        ? "a person pushed to the PR; the commit count is unknown"
        : `a person pushed ${count} commit${count === 1 ? "" : "s"} to the PR`;
    await this.c.unit("verdicts").recordImplicitVerdict(id, {
      verdict: "changes", severity: "minor", reason, key: `implicit:pushed:${id}:${to_sha}`, actor, pr_head: to_sha,
    });
  }

  /** The pushed head commit's author as a user: the forge does not name who pushed. Else system:pr-sync. */
  async pusher(id: WorkItemId, sha: string): Promise<Actor> {
    const author = this.c.k.forge ? await this.c.k.forge.commitAuthor(sha) : null;
    const principal = author ? await this.c.k.d.auth.resolve(author) : null;
    if (principal) return { kind: "user", id: principal.user_id };
    this.c.k.d.log.warn("pusher did not resolve to a user; recorded as system:pr-sync", { work_item_id: id, head_sha: sha });
    return PR_SYNC;
  }

  /** The forge found a factory PR that no longer merges: its update run (startUpdate). */
  async unmergeable(e: Extract<ForgeEvent, { kind: "change_unmergeable" }>): Promise<void> {
    const id = workItemIdFromBranch(e.head_branch, this.c.k.cfg.branch_prefix);
    if (!id) return;
    await this.startUpdate(id as WorkItemId, e.change_ref, e.head_sha, e.base_sha);
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "pr-events": PrEventsUnit;
  }
}

export default controllerUnit({
  name: "pr-events",
  create: (c: Ctx) => new PrEventsUnit(c),
  events: {
    change_merged: (u, e) => u.prFinished(e),
    change_closed: (u, e) => u.prFinished(e),
    change_open: (u, e) => u.prOpen(e),
    change_unmergeable: (u, e) => u.unmergeable(e),
  },
});
