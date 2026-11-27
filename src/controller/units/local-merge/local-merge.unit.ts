// The local merge, base pushes, auto mode's merges, its stop conditions and red main; after a merge, the restart
// command (Restart app, `factory restart`) and the merge reply's run hint.
// Moved out of the legacy controller (RFC 0015 M5); the merge and the base push are outbound deliveries (M8), the
// conflict probe and the red-main check are still inline (unit-purity ratchet).

import { ALERT_DEDUPE_MS } from "../../../core/alarms.js";
import { modeOf } from "../../../core/settings.js";
import { AUTO_ACTOR, autoMergeRefusal, branchFor } from "../../../core/policy.js";
import {
  LOCAL_SOURCE, MERGE_COMMAND, RESTART_DONE, RESTART_REQUESTED, RUN_HINT_ENTRIES, canAppendLocal, canMergeLocal, canPullBase, canReadLocal, canSyncBase, droppedBack, reconcileOf,
  reconcileSourceId, restartRefusal, restartReply, restartRunKey, runHint, tierRule,
} from "../../../core/local-merge.js";
import { gatePathTouched } from "../../../core/improver.js";
import { lastPrNotes } from "../../../core/pr-body.js";
import { type Actor, RECURRING_FAILURE, type Run, type SourceRef, type StateChangeDetail, type UserId, type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { ExternalIdentity } from "../../../interfaces/auth-provider.js";
import { LOCAL_GIT_HOST, basePushOutcome, basePushTarget, gitTarget, type ActionRow } from "../../../outbound/index.js";
import { AUTO, CONFLICT_PENDING, SYSTEM, awaitingMerge } from "../support.js";
import type { ControllerReader, ControllerWrite } from "../kernel.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";
import { type RedMainOutput, redMainCheck } from "./red-main.js";

/** The reason of the state change that sends a branch fixed by hand to its fresh review. */
const HAND_FIXED = "conflict_fixed_by_hand";
/** Parked on its merge conflict for a person (REVIEW / human / merge_conflict_pending); checked here, not imported from
 * core, to keep this unit off another legacy import (dependency-direction ratchet). */
function conflictParked(it: Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason">): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "human" && it.blocked_reason === CONFLICT_PENDING;
}
/** Held for recurring_failure in REVIEW after its last failed run, a resolve run (core resolveHeld, copied here for the
 * same reason): its hand fix is accepted like a parked one (design §5 Merge conflict, 2026-11-21). */
function resolveHeld(it: Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason">, runs: readonly Run[]): boolean {
  if (it.stage !== "REVIEW" || it.blocked_on !== "human" || it.blocked_reason !== RECURRING_FAILURE) return false;
  const failed = runs.filter((r) => r.outcome?.status === "failed");
  const last = failed.reduce<Run | null>((a, r) => (a === null || (r.finished_at ?? r.updated_at) >= (a.finished_at ?? a.updated_at) ? r : a), null);
  return last?.kind === "resolve";
}
/** mergeLocal's `who` for auto mode's merge: no person, actor `system:auto`. */
const AUTO_MERGE = { auto: true } as const;

/** The status page's user (an app request): its factory user id. */
interface AppActor {
  readonly user_id: UserId;
}
/** Settings audit rows read to find the mode change an automatic action ran under. */
const MODE_HISTORY = 500;
/** Items waiting for a merge looked at per auto-merge step. */
const AUTO_MERGE_BATCH = 20;
/** Why auto mode went back to manual: the alert's error code (design 03-risk, stop conditions). */
type AutoStop = "red_main" | "failure_alert" | "budget_checkpoint";

/**
 * Why a branch that does not merge cleanly into the local base was not merged, with the conflicting files. `next`:
 * `resolving`, the automatic resolve started (design §5 Merge conflict); `parked`, the item waits on its conflict
 * for a person, who resolves it by hand or with `factory resolve`; `person`, the person resolves it.
 */
function conflictRefusal(id: WorkItemId, branch: string, base: string, conflicts: readonly string[], next: "resolving" | "parked" | "person"): string {
  const byHand = `\`${branch}\` is a local branch of this repository: merge \`${base}\` into it and commit the resolution there, then run \`factory merge ${id}\` again`;
  return [
    `\`${branch}\` does not merge cleanly into the local \`${base}\`, so nothing moved. Conflicting files:`,
    "",
    ...conflicts.map((f) => `- \`${f}\``),
    "",
    next === "resolving"
      ? `An automatic resolve run merges \`${base}\` into \`${branch}\`, resolves the conflicts and commits on the local branch; a fresh review follows, then run \`factory merge ${id}\` again`
      : next === "parked" ? `Run \`factory resolve ${id}\` to let an agent resolve it, or: ${byHand}` : byHand,
  ].join("\n");
}

/** The local merge, base pushes, auto mode's merges and its stop conditions. */
export class LocalMergeUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * The local merge (design 05-sources, Local items): the one merge path for an item with no PR, reached by
   * `factory merge <id>` through the command inbox and by the status page's Merge button (an app request,
   * applyAppRequest), never a second path. `who` is the CLI's local identity or the app request's factory user ID.
   * Authorized by the local auth plugin for `approve_merge`, the approver role. Refused, with a reply, for an item not waiting
   * for a merge, and at once for a branch that conflicts with the local base, which starts its automatic resolve. Otherwise the change enters the merge
   * queue (RFC 0015 M8, the merge-queue unit): a merge-check run checks its merged result, and only a green one
   * lands (`requestMerge`, an outbound delivery); the item waits at merge_queued while its entry is live; a red one is removed, the item goes back to merge_pending and the reply says why. A second merge of a queued change (`already`) changes nothing: no return, no post. A checkout of
   * the base is fast-forwarded when clean and left as it was otherwise (the close's detail and the reply say so).
   * `who` AUTO_MERGE is auto mode's merge (autoMergeStep, design 03-risk): no person to authorize, actor
   * `system:auto`, and the state change names the mode change it ran under. Safe to run twice: the same `key` is
   * the same queue entry; `key` keys the replies and `detail` goes on the state change. Returns the refusal, or
   * null when the change is in the queue.
   */
  async mergeLocal(id: WorkItemId, who: ExternalIdentity | AppActor | typeof AUTO_MERGE, key: string, detail: Record<string, unknown> = {}): Promise<string | null> {
    const item = await this.c.k.reader.getWorkItem(id);
    if (!item) return "the work item was not found";
    const { repo, branch_prefix } = this.c.k.cfg;
    const branch = branchFor(item, branch_prefix);
    const auto = who === AUTO_MERGE;
    const service = auto ? await this.c.unit("auth").automatic("approve_merge", item) : null;
    const principal = "user_id" in who
      ? await this.c.unit("auth").allowed({ user_id: who.user_id }, "approve_merge", item.id)
      : "auto" in who
        ? service === null ? { user_id: AUTO_ACTOR } : { refuse: service }
        : await this.c.unit("auth").authorize(who, "approve_merge", item.id);
    // The merge gate (core request-transition, through the commands unit): waiting for its merge, no PR, a sandbox that merges.
    const sandbox = this.c.k.d.sandbox;
    // Held after its resolve failed: parked. `again`: a failed merge check's max_loops (2026-11-23), back to merge_pending for one more check.
    const parked = conflictParked(item) || (item.blocked_reason === RECURRING_FAILURE && resolveHeld(item, await this.c.k.reader.listRuns(item.id)));
    const again = !auto && !parked && this.c.unit("commands").merge.stopped(item, await this.c.k.reader.listStateChanges(item.id));
    const gate = "refuse" in principal ? null : this.c.unit("commands").merge.localRefusal(item, canMergeLocal(sandbox), parked || again);
    let refusal: string;
    if ("refuse" in principal) refusal = principal.refuse;
    // The gate refuses when the sandbox cannot merge; its check again here only narrows the sandbox's type.
    else if (gate !== null || !canMergeLocal(sandbox)) refusal = gate as string;
    else {
      const conflicts = await sandbox.localConflicts({ repo: repo.path, base_ref: repo.base_branch, branch });
      if (conflicts === null) refusal = `the factory repo has no local branch \`${branch}\``;
      else if (conflicts.length > 0 && parked) refusal = conflictRefusal(item.id, branch, repo.base_branch, conflicts, "parked");
      else if (conflicts.length > 0) refusal = conflictRefusal(item.id, branch, repo.base_branch, conflicts, await this.resolveRefused(item) ? "resolving" : "person");
      else if (parked) {
        // Fixed by hand (design §5 Merge conflict, 2026-11-20; a resolve-held item too, 2026-11-21): the branch as it is gets a fresh review first.
        const r = await this.handFixed(item, principal.user_id, branch, detail);
        if (r === null) return null;
        refusal = r;
      } else {
        // Ready and approved: the change enters the merge queue, which checks its merged result before it lands.
        if (again) await this.c.unit("transitions").decide(item.id, async (it) => this.c.unit("commands").merge.again(it, await this.c.k.reader.listStateChanges(it.id), { kind: "user", id: principal.user_id as UserId }));
        const r = await this.c.unit("merge-queue").enter(item, auto ? AUTO_ACTOR : principal.user_id, key, detail);
        if (r === null || "already" in r) return null;
        refusal = r.refusal;
      }
    }
    await this.refused(item.id, auto ? AUTO_ACTOR : "", key, refusal);
    return refusal;
  }

  /**
   * A local item parked on its merge conflict, or held after its resolve failed (2026-11-21), whose branch now merges
   * cleanly into the local base (design §5 Merge conflict, 2026-11-20): the owner fixed it by hand; the hold is lifted. No resolve run: the item goes back to REVIEW with one fresh
   * review keyed on the branch's head, so a second `factory merge` on the same head queues nothing new; the review's
   * pass sets merge_pending, and `factory merge` then lands it. Returns the refusal, or null when the review is queued.
   */
  private async handFixed(item: WorkItem, by: string, branch: string, detail: Record<string, unknown>): Promise<string | null> {
    const sandbox = this.c.k.d.sandbox;
    const head = canReadLocal(sandbox) ? await sandbox.localBranch({ repo: this.c.k.cfg.repo.path, branch }) : null;
    if (head === null) return `the head of \`${branch}\` could not be read; run \`factory merge ${item.id}\` again`;
    const input = await this.c.unit("checks-gate").reviewInput(null, item.id);
    const actor: Actor = by === AUTO_ACTOR ? AUTO : { kind: "user", id: by as UserId };
    await this.c.unit("transitions").decide(item.id, async (it) => ((conflictParked(it) || resolveHeld(it, await this.c.k.reader.listRuns(it.id))) && it.change_ref === null
      ? {
          patch: { blocked_on: "none", blocked_reason: null },
          actor,
          reason: HAND_FIXED,
          detail: { ...detail, branch, head_sha: head },
          enqueue: { kind: "review", idempotency_key: `${item.id}:review:hand-fixed:${head}`, input },
        }
      : null));
    await this.c.unit("outbox").post(item, item.source,
      `\`${branch}\` (at \`${head.slice(0, 12)}\`) now merges cleanly into the local \`${this.c.k.cfg.repo.base_branch}\`. A fresh review of it runs next; once it passes, run \`factory merge ${item.id}\` again.`,
      `<!-- factory:hand-fixed:${item.id}:${head} -->`);
    return null;
  }

  /**
   * The merge itself (RFC 0015 M8), requested of outbound: the merge queue calls it for an entry whose merge-check
   * run passed on `base_sha` with the branch at `head_sha`. It stores one `merge` action keyed `action_key` (one per
   * check: recording it again stores nothing) to this host's base (`git:<host>:<base>`); outbound's `local` target
   * merges the item's local branch into the local base only while the base is still at `base_sha` and the branch
   * at `head_sha`, so the tree that lands is the tree that was checked, and its DeliveryCompleted comes back to the
   * merge queue (`merged` here). `entry` (the entry id and its check) goes on the action, so only that landing
   * applies it. Returns `requested`, `landed` for an item already closed by its merge, or the refusal.
   */
  async requestMerge(
    id: WorkItemId, by: string, action_key: string, entry: { entry_id: string; run_key: string | null }, base_sha: string | null, head_sha: string | null,
  ): Promise<"requested" | "landed" | string> {
    const item = await this.c.k.reader.getWorkItem(id);
    if (!item) return "the work item was not found";
    if (item.stage === "CLOSED" && item.close_reason === "completed" && item.merge_sha !== null) return "landed";
    if (!this.c.unit("commands").merge.waits(item) || item.change_ref !== null) return `${item.id} is no longer waiting for a merge`;
    if (!canMergeLocal(this.c.k.d.sandbox)) return "this controller has no sandbox that can merge locally";
    const { repo } = this.c.k.cfg;
    const branch = this.branchOf(item);
    await this.c.k.commit({ writes: [{ kind: "intent", action: {
      action: "merge", target: this.gitDestination(), work_item_id: item.id, key: action_key,
      args: {
        ...entry, base_ref: repo.base_branch, branch,
        // No base known (an entry ahead landed without telling it): any base is moved, and it is checked again.
        expected_base: base_sha ?? "", expected_head: head_sha,
        message: `Merge ${branch} into ${repo.base_branch}\n\nWork item ${item.id}, merged by ${by} ${by === AUTO_ACTOR ? "in auto mode" : by === SYSTEM.id ? "as a base reconcile" : "with `factory merge`"}.`,
      },
    } }] });
    return "requested";
  }

  /**
   * A delivered merge (RFC 0015 M8): the base holds the branch at `r.sha`. The item closes (completed, its merge
   * sha) with the approver, or `system:auto`, as its actor and releases the items waiting on it; with a remote to
   * push to, one `push_base` action (keyed by the item and the merge) is stored first, to the base push's own
   * destination (a failing push holds no later merge), so a crash between the two pushes it once. Safe to run again: the close is conditional, the post and the push
   * keyed. A close that did not apply throws, so the delivery result is applied again.
   */
  async merged(id: WorkItemId, by: string, key: string, r: { sha: string; already: boolean; not_updated: readonly string[] }, detail: Record<string, unknown>): Promise<"landed" | string> {
    const item = await this.c.k.reader.getWorkItem(id);
    if (!item) return "the work item was not found";
    const { repo } = this.c.k.cfg;
    const branch = this.branchOf(item);
    const auto = by === AUTO_ACTOR;
    const push = this.pushesBase();
    if (push) {
      await this.c.k.commit({ writes: [{ kind: "intent", action: {
        action: "push_base", target: basePushTarget(this.gitHost(), repo.base_branch), work_item_id: id, key: `push_base:${id}:${r.sha}`,
        args: { base_ref: repo.base_branch, merge_sha: r.sha, message: `Merge origin/${repo.base_branch} into ${repo.base_branch}\n\nBefore the base push of work item ${id}.` },
      } }] });
    }
    const actor: Actor = auto ? AUTO : by === SYSTEM.id ? SYSTEM : { kind: "user", id: by as UserId };
    const stale = r.not_updated.join(", ");
    const waits = this.c.unit("commands").merge.waits;
    await this.c.unit("transitions").decide(item.id, (it) => (waits(it) && it.change_ref === null
      ? {
          patch: { stage: "CLOSED", close_reason: "completed", merge_sha: r.sha, blocked_on: "none", blocked_reason: null },
          actor,
          reason: "local_merged",
          detail: {
            ...detail, branch, base_ref: repo.base_branch, ...(r.already ? { already_merged: true } : {}), ...(stale ? { checkout_not_updated: stale } : {}),
          },
        }
      : null));
    // decide returns null whether or not the close applied: only the item says. The base holds the change either
    // way, so a close that did not apply (version conflicts, a store error) is retried by applying the merge again.
    const closed = await this.c.k.reader.getWorkItem(item.id);
    if (closed?.stage !== "CLOSED" || closed.merge_sha !== r.sha) {
      if (closed && (!waits(closed) || closed.change_ref !== null)) return `${item.id} is no longer waiting for a merge`;
      throw new Error(`the close of ${item.id} after its local merge did not apply; applied again`);
    }
    await this.c.unit("pr-events").closeLinkedTasks(item.id);
    this.c.k.d.log.info("local merge", { work_item_id: item.id, merge_sha: r.sha, user_id: by, base_push: push });
    const how = auto ? " in auto mode" : "";
    const body = [
      `Merged \`${branch}\` into the local \`${repo.base_branch}\`${how} as \`${r.sha.slice(0, 12)}\` (${push ? "its push to origin is queued" : "no push"}). The item is closed.`,
      ...(stale ? [`\`${repo.base_branch}\` is checked out with uncommitted changes in ${stale}: that checkout was not updated (its HEAD is detached where it was); switch it back to \`${repo.base_branch}\` when ready.`] : []),
      // How to run the result (design 04-gate-commands, restart): the Restart app button, or where the repo says how.
      repo.restart_command !== undefined
        ? `To run the merged code, press Restart app on the item's page or run \`factory restart ${item.id}\`.`
        : runHint((await this.c.k.d.repo_entries?.(RUN_HINT_ENTRIES)) ?? []),
    ];
    await this.c.unit("outbox").post(item, item.source, body.join("\n\n"), `<!-- factory:local-merged:${key} -->`);
    await this.c.k.guard("dependents", () => this.c.unit("coordination").releaseDependents(item.source.id));
    return "landed";
  }

  /**
   * `restart` (design 04-gate-commands, restart): the app request of the item page's Restart app button and of
   * `factory restart <id>`, by the factory user `user_id`. The owner check (approve_spec, as every item command), then
   * restartRefusal: `repo.restart_command` set and the item merged into the base. Then one restart run is queued on
   * the item, keyed on the request, with `tag` (the request's seq) on its state change and no item field changed;
   * `restarted` posts its result. Safe to run twice: the run's key. Returns the refusal, or null.
   */
  async restart(item: WorkItem, user_id: UserId, key: string, tag: StateChangeDetail): Promise<string | null> {
    const principal = await this.c.unit("auth").allowed({ user_id }, "approve_spec", item.id);
    if ("refuse" in principal) return principal.refuse;
    const actor: Actor = { kind: "user", id: principal.user_id };
    return this.c.unit("transitions").decide(item.id, (it) => {
      const refuse = restartRefusal(it, this.c.k.cfg.repo.restart_command);
      if (refuse !== null) return { refuse };
      return { patch: {}, actor, reason: RESTART_REQUESTED, detail: tag, enqueue: { kind: "restart", idempotency_key: restartRunKey(key) } };
    });
  }

  /**
   * A finished restart run: its result (exit status and output tail, or why it did not run) posted once in the item's
   * thread, keyed on the run, then the run acknowledged with no item field changed: a failure is the owner's to read,
   * never a retry or a block.
   */
  async restarted(run: Run): Promise<void> {
    const item = await this.c.k.reader.getWorkItem(run.work_item_id);
    if (item) await this.c.unit("outbox").post(item, item.source, restartReply(run), `<!-- factory:restart:${run.id} -->`);
    await this.c.unit("transitions").decide(run.work_item_id, () => ({ patch: {}, actor: SYSTEM, reason: RESTART_DONE, ack_run: run.id }));
  }

  /** Whether this controller's sandbox can append to a file on the local base (design 07-design-learnings). */
  canAppend(): boolean {
    return canAppendLocal(this.c.k.d.sandbox);
  }

  /** Lines appended to `path` on the local base in one commit: one `append_lines` action keyed `key`, in order with its merges (design 07-design-learnings). */
  async appendToBase(key: string, a: { path: string; head: string; lines: readonly string[]; branch: string; message: string }): Promise<void> {
    const args = { base_ref: this.c.k.cfg.repo.base_branch, path: a.path, head: a.head, lines: JSON.stringify(a.lines), branch: a.branch, message: a.message };
    await this.c.k.commit({ writes: [{ kind: "intent", action: { action: "append_lines", target: this.gitDestination(), key, args } }] });
  }

  /**
   * Where this controller's merges go (RFC 0015 M8): its host's base branch, `git:<host id>:<base>`, so merges on
   * one base land in order and only an outbound that flushes this host makes them (design 10-event-driven, Git
   * destinations). Its base pushes have their own destination (`basePushTarget`).
   */
  private gitDestination(): SourceRef {
    return gitTarget(this.gitHost(), this.c.k.cfg.repo.base_branch);
  }

  /** This machine's host id; `local` with none (tests, one process). */
  private gitHost(): string {
    return this.c.k.d.git_host?.id ?? LOCAL_GIT_HOST;
  }

  /**
   * Whether auto mode may still land `id` now (design 03-risk): auto mode on for its project and the controller's
   * service passport allowing `approve_merge`. Checked again at the landing, since a person may have switched to
   * manual, a stop condition fired or the passport changed while the entry waited. Returns the refusal, or null.
   */
  async autoRefusal(id: WorkItemId): Promise<string | null> {
    const item = await this.c.k.reader.getWorkItem(id);
    if (!item) return "the work item was not found";
    if (!(await this.autoMode(item.project))) return "auto mode is off now; a person merges it: `factory merge` (approver role)";
    return this.c.unit("auth").automatic("approve_merge", item);
  }

  /**
   * A conflicting local branch at `factory merge` (design §5 Merge conflict): the automatic resolve starts, as from
   * the merge check, keyed on the local base's commit. With no forge (`local_only`) the sandbox's base read is the
   * local base; with a forge selected it is the remote's, so a local item reads the local base itself
   * (`localBranch`, no fetch). Returns whether the item moved to its resolve run.
   */
  private async resolveRefused(item: WorkItem): Promise<boolean> {
    const sandbox = this.c.k.d.sandbox;
    const { repo, local_only } = this.c.k.cfg;
    const base = local_only === true && sandbox
      ? await sandbox.updateBase({ repo: repo.path, base_ref: repo.base_branch })
      : item.source.type === LOCAL_SOURCE && canReadLocal(sandbox)
        ? await sandbox.localBranch({ repo: repo.path, branch: repo.base_branch })
        : null;
    if (base === null) return false;
    await this.startLocalResolve(item.id, base, "merge_refused");
    return (await this.c.k.reader.getWorkItem(item.id))?.stage === "RUNNING";
  }

  /**
   * A local item's branch conflicts with the local base at `baseSha` (design §5 Merge conflict, decision changed
   * 2026-11-12): the merge check or `factory merge` found it. No update run (the resolve run merges the base and runs
   * the gates itself): the automatic resolve starts at once, as after a PR's update run. Only an item still waiting
   * for a merge with no PR changes, so a second call changes nothing.
   */
  async startLocalResolve(id: WorkItemId, baseSha: string, cause: string): Promise<void> {
    await this.c.unit("transitions").decide(id, (it) =>
      this.c.unit("commands").merge.waits(it) && it.change_ref === null ? this.c.unit("run-results").autoResolve(it, baseSha, { cause }, null) : null);
  }

  /**
   * With a forge selected (design §5 Merge conflict): the local items of `items` (source `local`, no PR; an item of
   * another source with no PR has no branch in the factory repo) and a reader of the factory repo's local branches
   * (`localBranch`, no fetch), for the merge check. Null when this controller's sandbox cannot read them.
   */
  localReads(items: readonly WorkItem[]): { items: WorkItem[]; read: (branch: string) => Promise<string | null> } | null {
    const sandbox = this.c.k.d.sandbox;
    if (!canReadLocal(sandbox)) return null;
    const repo = this.c.k.cfg.repo.path;
    return {
      items: items.filter((it) => it.change_ref === null && it.source.type === LOCAL_SOURCE),
      read: (branch) => sandbox.localBranch({ repo, branch }),
    };
  }

  /**
   * Whether `it` is a local item waiting for a merge whose branch conflicts with the local base (design §5 Merge
   * conflict, `/resolve`): the local merge's own probe (`localConflicts`, objects only). False with no sandbox for it.
   */
  async conflicting(it: WorkItem): Promise<boolean> {
    const sandbox = this.c.k.d.sandbox;
    if (!awaitingMerge(it) || it.change_ref !== null || !canMergeLocal(sandbox)) return false;
    const { repo } = this.c.k.cfg;
    return ((await sandbox.localConflicts({ repo: repo.path, base_ref: repo.base_branch, branch: this.branchOf(it) }))?.length ?? 0) > 0;
  }

  /** The change a conflict comment names: the PR, or a local item's branch (`start`: at the start of a sentence). */
  changeName(it: WorkItem, start = false): string {
    return it.change_ref !== null ? `PR #${it.change_ref}` : `${start ? "The" : "the"} local branch \`${this.branchOf(it)}\``;
  }

  /** The item's local branch. */
  branchOf(item: WorkItem): string {
    return branchFor(item, this.c.k.cfg.branch_prefix);
  }

  /** The item, as the merge queue checks whether its entry still waits for a merge. */
  item(id: WorkItemId): Promise<WorkItem | null> {
    return this.c.k.reader.getWorkItem(id);
  }

  /**
   * A refusal posted on the item: why the merge did not apply, keyed by `key`. An item at merge_queued goes back to
   * merge_pending with it first (MergeQueueUnit.returned), so its row shows why at once.
   */
  async refused(id: WorkItemId, by: string, key: string, refusal: string): Promise<void> {
    await this.c.unit("merge-queue").returned(id, refusal);
    const item = await this.c.k.reader.getWorkItem(id);
    if (!item) return;
    this.c.k.d.log.info("command refused", { work_item_id: id, command: MERGE_COMMAND, reason: refusal.split("\n")[0]!.slice(0, 300) });
    const what = by === AUTO_ACTOR ? "The automatic merge" : "`factory merge`";
    await this.c.unit("outbox").post(item, item.source, `${what} was not applied: ${refusal}.`, `<!-- factory:refused:${key} -->`);
  }

  /** Whether a merge's base is pushed to a remote: a forge that pushes a base and a sandbox that syncs it first. */
  pushesBase(): boolean {
    return this.c.k.forge?.pushBase !== undefined && canSyncBase(this.c.k.d.sandbox);
  }

  /**
   * A merge made on the forge (a PR merged by `merge_pr` or on GitHub) moved the remote base (design 05-github-sync,
   * base pull): one `pull_base` action, keyed on the merge, to the base push's destination, so outbound fast-forwards the
   * local base to origin's. Without it the local base stays behind until a later local merge's push merges the two,
   * and a local merge checked meanwhile lands on the stale base and conflicts at its push. Only when this controller
   * pushes the base (a remote to read) and its sandbox can pull it; safe to call twice: the key.
   */
  async pullBase(merge_sha: string, work_item_id: WorkItemId | null): Promise<void> {
    if (!this.pushesBase() || !canPullBase(this.c.k.d.sandbox)) return;
    const base = this.c.k.cfg.repo.base_branch;
    await this.c.k.commit({ writes: [{ kind: "intent", action: {
      action: "pull_base", target: basePushTarget(this.gitHost(), base), work_item_id, key: `pull_base:${base}:${merge_sha}`, args: { base_ref: base, merge_sha },
    } }] });
  }

  /**
   * A delivered base push (design 05-sources, Local items; RFC 0015 M8): outbound's `local` target fetched the
   * remote base, merged it into the local base when it moved, and pushed, conditionally on the remote base it read.
   * A failure (an outage, a rate limit, a base that moved again) is a delivery failure outbound retries with its
   * batch's backoff. A remote base that does not merge cleanly is a delivered conflict: the item stays closed (the
   * merge happened, only its push waits), and with a forge that pushes the base one reconcile item is filed, keyed on
   * origin's sha (design 05-sources, Base reconcile; intake's fileReconcile). Never changes the pushed item.
   */
  async basePushDelivered(row: ActionRow): Promise<void> {
    const r = basePushOutcome(row);
    if (r === null || !row.work_item_id) return;
    const base = String(row.args.base_ref);
    if ("pushed" in r) return this.c.k.d.log.info("base pushed", { work_item_id: row.work_item_id, base_ref: base, sha: r.pushed });
    this.c.k.d.log.warn("base push conflict", { work_item_id: row.work_item_id, base_ref: base, conflicts: r.conflicts.length });
    if (r.remote !== undefined && this.pushesBase()) await this.c.unit("intake").fileReconcile(base, r.remote, r.conflicts, reconcileSourceId(base, r.remote));
  }

  /** The base and origin sha a reconcile item merges, or null for any other item (design 05-sources, Base reconcile). */
  reconcileOf(it: WorkItem): { base_ref: string; remote: string } | null {
    return reconcileOf(it);
  }

  /**
   * A reconcile item whose resolve run passed waits at merge_pending (run-results): it enters the merge queue with no
   * person (`system:controller`), keyed on that run, so local main moves only through its merge check and a red result
   * moves nothing. A replay finds the same entry; a removed one is not entered again, and Needs you asks the owner.
   */
  async reconciled(id: WorkItemId, run_id: string): Promise<void> {
    const it = await this.c.k.reader.getWorkItem(id);
    if (!it || reconcileOf(it) === null || !awaitingMerge(it) || it.change_ref !== null) return;
    await this.c.unit("merge-queue").enter(it, SYSTEM.id, `reconcile:${id}:${run_id}`, { reconcile_run: run_id });
  }

  /**
   * Auto mode's merge (design 03-risk): each local item waiting for a merge, in a project in auto mode, merges
   * through mergeLocal (actor `system:auto`, the mode change on its state change) when autoMergeRefusal allows it:
   * the change enters the merge queue, so a failing check or a conflict on its merged result moves nothing. One try per
   * passed review: a refusal is posted once under a key of that review run, and the item stays in merge_pending for a person.
   * A sync source's item waits as in manual mode, with no post (no forge merge to call). Merge records: one store read per step.
   */
  async autoMergeStep(): Promise<void> {
    const r = this.c.k.live.resolved();
    if (r.global.mode.value !== "auto" && !Object.values(r.projects).some((p) => p.mode?.value === "auto")) return;
    const waiting = await this.c.k.reader.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "human", limit: AUTO_MERGE_BATCH });
    let merges: Awaited<ReturnType<ControllerReader["listMergeEvaluations"]>> | null = null;
    for (const it of waiting) {
      if (!awaitingMerge(it) || it.source.type !== LOCAL_SOURCE || it.change_ref !== null) continue;
      const auto = await this.autoMode(it.project);
      if (!auto) continue;
      // Keyed by the review that passed, not the item version: the merge queue's own state changes bump the version.
      const review = await this.c.unit("run-results").latestReview(it.id);
      const key = `auto-merge:${it.id}:${review?.id ?? `v${it.version}`}`;
      if ((await this.c.k.reader.listItemMessages(it.id)).some((m) => m.marker.endsWith(`:${key} -->`))) continue;
      const missing = lastPrNotes(await this.c.k.reader.listRuns(it.id))?.missing ?? [];
      const tier = it.tier ?? 5;
      const record = (merges ??= await this.c.k.reader.listMergeEvaluations(null)).filter((m) => m.tier === tier);
      const refusal = autoMergeRefusal({
        tier, max_tier: this.c.k.live.values().auto_merge_max_tier, incomplete: missing.length > 0,
        gate_path: gatePathTouched([...it.allowed_paths, ...(it.pr_files ?? [])]), local: true,
        rule: tierRule(tier, record), dropped_back: droppedBack(record),
      });
      if (refusal === null) {
        await this.c.k.guard("auto merge", async () => void (await this.mergeLocal(it.id, AUTO_MERGE, key, { mode_change: auto.seq })));
        continue;
      }
      this.c.k.d.log.info("auto merge held", { work_item_id: it.id, reason: refusal });
      await this.c.unit("outbox").post(it, it.source,
        `Auto mode does not merge this change: ${refusal}. A person merges it: \`factory merge ${it.id}\` (approver role).`,
        `<!-- factory:auto-merge-held:${key} -->`);
    }
  }

  /** Whether `project` is in auto mode now (design 03-risk), with the mode change it runs under; null in manual mode. */
  async autoMode(project: string): Promise<{ seq: number | null } | null> {
    const m = modeOf(this.c.k.live.resolved(), project);
    return m.mode === "auto" ? { seq: await this.modeChangeSeq(m.level) } : null;
  }

  /** The audit seq of the newest `mode` change stored at `level` ("" global); null when none is found. */
  async modeChangeSeq(level: string | null): Promise<number | null> {
    if (level === null) return null;
    return (await this.c.k.reader.listSettingChanges(MODE_HISTORY)).find((c) => c.key === "mode" && c.project === level)?.seq ?? null;
  }

  /** Red main after an automatic merge (design 03-risk): the checks on the new base tip, and the revert (red-main.ts). */
  redMainCheck(it: WorkItem): Promise<void> {
    return redMainCheck(this.c, it);
  }

  /**
   * The base branch fails a check on its own at `base_sha` (design 03-risk): one `red_main` alert keyed on that sha, in
   * manual and auto mode; one fix item filed through outbound (`file_fix_item`, keyed on that sha) by the first source
   * in `plugins.source` order that can file; and in auto mode the stop (`stopAuto`). Safe to run again: the alert's
   * conditional insert and the action's key store each once. With no sha known, only the stop. With `output` (the
   * red-main check's), the alert's detail is JSON `{ text, failing_tests, output_tail }` (`redMainDetail` in
   * src/ui/alarms.ts reads it back); else the text alone. With `reverted` (the revert that made the base green again,
   * red-main.ts), the alert alone: no fix item and no stop.
   */
  async redMain(project: string, base_sha: string | null, detail: string, output?: RedMainOutput, reverted?: string): Promise<void> {
    if (base_sha !== null) {
      // G5: the alert reaches the status page, so its detail is scanned as UI text first, and the output tail as run
      // outcome text, as the merge check scans it: a flagged tail is stored as null, the test names are kept. The fix
      // item's text is scanned by outbound before it leaves.
      const scan = await this.c.k.reader.scan("ui", detail);
      const text = scan.clean ? detail : null;
      const tail = output && output.output_tail !== "" && (await this.c.k.reader.scan("run_outcome", output.output_tail)).clean ? output.output_tail : null;
      const stored = output ? JSON.stringify({ text, failing_tests: output.failing_tests, output_tail: tail }) : text;
      const writes: ControllerWrite[] = [{
        kind: "alert", dedupe_ms: ALERT_DEDUPE_MS,
        alert: { pattern: "red_main", pattern_key: `red_main:${base_sha}`, error_code: "red_main", count: 1, detail: stored },
      }];
      const filer = this.c.k.filer();
      const { base_branch } = this.c.k.cfg.repo;
      if (reverted !== undefined) this.c.k.d.log.info("red main: reverted, no fix item", { base_sha, revert_sha: reverted });
      else if (filer !== null) {
        writes.push({ kind: "intent", action: {
          action: "file_fix_item", target: { type: filer, id: `red-main:${base_sha}`, link: "" }, key: `file_fix_item:red_main:${base_sha}`,
          args: {
            project, requester_id: SYSTEM.id, base_sha, marker: `<!-- factory:red-main:${base_sha} -->`,
            title: `Fix \`${base_branch}\` at ${base_sha.slice(0, 12)}: it fails its checks on its own`,
            body: `\`${base_branch}\` at \`${base_sha}\` fails a check with no change merged onto it, so the merge queue holds the changes that touch it until \`${base_branch}\` moves.\n\n${detail}`,
          },
        } });
      } else this.c.k.d.log.warn("red main: no source can file its fix item", { base_sha });
      await this.c.k.commit({ writes });
    }
    if (reverted === undefined) await this.stopAuto(project, "red_main", detail);
  }

  /** The local base branch's tip, as the merge queue lands on it; null when this controller's sandbox cannot read it. */
  async baseTip(): Promise<string | null> {
    const sandbox = this.c.k.d.sandbox;
    const { repo } = this.c.k.cfg;
    return canReadLocal(sandbox) ? sandbox.localBranch({ repo: repo.path, branch: repo.base_branch }) : null;
  }

  /**
   * A stop condition (design 03-risk): red main, a failure-burst alert or a budget checkpoint sets `project`'s mode
   * back to manual, at the level its auto mode is stored at. One `auto_stopped` alert, keyed on the mode change it
   * ends, then one settings row by `system:auto`: the alert's conditional insert makes a second stop (a re-run,
   * another replica) write nothing. Nothing happens in manual mode.
   */
  async stopAuto(project: string, cause: AutoStop, detail: string): Promise<void> {
    const m = modeOf(this.c.k.live.resolved(), project);
    if (m.mode !== "auto" || m.level === null) return;
    const seq = await this.modeChangeSeq(m.level);
    // G5: the alert reaches the status page, so its detail is scanned as UI text first.
    const scan = await this.c.k.reader.scan("ui", detail);
    await this.c.k.commit({ writes: [{
      kind: "stop_auto",
      alert: { pattern: "auto_stopped", pattern_key: `auto_stopped:${m.level || "global"}:${seq ?? 0}`, error_code: cause, count: 1, detail: scan.clean ? detail : null },
      dedupe_ms: ALERT_DEDUPE_MS,
      project,
      level: m.level,
      actor: AUTO_ACTOR,
      mode_change: seq,
    }] });
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "local-merge": LocalMergeUnit;
  }
}

export default controllerUnit({
  name: "local-merge",
  create: (c: Ctx) => new LocalMergeUnit(c),
});
