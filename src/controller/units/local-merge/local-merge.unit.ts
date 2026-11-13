// The local merge, base pushes, auto mode's merges and its stop conditions.
// Moved out of the legacy controller (RFC 0015 M5); the merge and the base push are outbound deliveries (M8), the
// conflict probe and the red-main check are still inline (unit-purity ratchet).

import { checkCommands } from "../../../core/checks.js";
import { ALERT_DEDUPE_MS } from "../../../core/alarms.js";
import { modeOf } from "../../../core/settings.js";
import { AUTO_ACTOR, autoMergeRefusal, branchFor } from "../../../core/policy.js";
import { LOCAL_SOURCE, MERGE_COMMAND, canMergeLocal, canReadLocal, canSyncBase } from "../../../core/local-merge.js";
import { gatePathTouched } from "../../../core/improver.js";
import { lastPrNotes } from "../../../core/pr-body.js";
import { type Actor, type SourceRef, type UserId, type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { ExternalIdentity } from "../../../interfaces/auth-provider.js";
import { LOCAL_GIT_HOST, basePushOutcome, basePushTarget, gitTarget, type ActionRow } from "../../../outbound/index.js";
import { AUTO, awaitingMerge } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

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
 * Why a branch that does not merge cleanly into the local base was not merged, with the conflicting files. `resolving`:
 * the automatic resolve started (design §5 Merge conflict); otherwise the person resolves it.
 */
function conflictRefusal(id: WorkItemId, branch: string, base: string, conflicts: readonly string[], resolving: boolean): string {
  return [
    `\`${branch}\` does not merge cleanly into the local \`${base}\`, so nothing moved. Conflicting files:`,
    "",
    ...conflicts.map((f) => `- \`${f}\``),
    "",
    resolving
      ? `An automatic resolve run merges \`${base}\` into \`${branch}\`, resolves the conflicts and commits on the local branch; a fresh review follows, then run \`factory merge ${id}\` again`
      : `\`${branch}\` is a local branch of this repository: merge \`${base}\` into it and commit the resolution there, then run \`factory merge ${id}\` again`,
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
   * lands (`requestMerge`, an outbound delivery); a red one is removed and the reply says why, and the item stays in merge_pending. A checkout of
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
      ? await this.c.unit("auth").allowed({ user_id: who.user_id, attributes: {} }, "approve_merge", item.id)
      : "auto" in who
        ? service === null ? { user_id: AUTO_ACTOR } : { refuse: service }
        : await this.c.unit("auth").authorize(who, "approve_merge", item.id);
    let refusal: string;
    if ("refuse" in principal) refusal = principal.refuse;
    else if (!awaitingMerge(item) || item.change_ref !== null) {
      const at = [item.stage, item.blocked_reason].filter(Boolean).join(", ");
      refusal = item.change_ref !== null
        ? `${item.id} has PR #${item.change_ref}: merge the PR instead`
        : `${item.id} is not waiting for a merge (${at}); \`factory merge\` applies once its review passed (merge_pending)`;
    } else if (!canMergeLocal(this.c.k.d.sandbox)) refusal = "this controller has no sandbox that can merge locally";
    else {
      const conflicts = await this.c.k.d.sandbox.localConflicts({ repo: repo.path, base_ref: repo.base_branch, branch });
      if (conflicts === null) refusal = `the factory repo has no local branch \`${branch}\``;
      else if (conflicts.length > 0) refusal = conflictRefusal(item.id, branch, repo.base_branch, conflicts, await this.resolveRefused(item));
      else {
        // Ready and approved: the change enters the merge queue, which checks its merged result before it lands.
        const r = await this.c.unit("merge-queue").enter(item, auto ? AUTO_ACTOR : principal.user_id, key, detail);
        if (r === null) return null;
        refusal = r;
      }
    }
    await this.refused(item.id, auto ? AUTO_ACTOR : "", key, refusal);
    return refusal;
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
    if (!awaitingMerge(item) || item.change_ref !== null) return `${item.id} is no longer waiting for a merge`;
    if (!canMergeLocal(this.c.k.d.sandbox)) return "this controller has no sandbox that can merge locally";
    const { repo } = this.c.k.cfg;
    const branch = this.branchOf(item);
    await this.c.k.commit({ writes: [{ kind: "intent", action: {
      action: "merge", target: this.gitDestination(), work_item_id: item.id, key: action_key,
      args: {
        ...entry, base_ref: repo.base_branch, branch,
        // No base known (an entry ahead landed without telling it): any base is moved, and it is checked again.
        expected_base: base_sha ?? "", expected_head: head_sha,
        message: `Merge ${branch} into ${repo.base_branch}\n\nWork item ${item.id}, merged by ${by} ${by === AUTO_ACTOR ? "in auto mode" : "with `factory merge`"}.`,
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
    const actor: Actor = auto ? AUTO : { kind: "user", id: by as UserId };
    const stale = r.not_updated.join(", ");
    await this.c.unit("transitions").decide(item.id, (it) => (awaitingMerge(it) && it.change_ref === null
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
      if (closed && (!awaitingMerge(closed) || closed.change_ref !== null)) return `${item.id} is no longer waiting for a merge`;
      throw new Error(`the close of ${item.id} after its local merge did not apply; applied again`);
    }
    await this.c.unit("pr-events").closeLinkedTasks(item.id);
    this.c.k.d.log.info("local merge", { work_item_id: item.id, merge_sha: r.sha, user_id: by, base_push: push });
    const how = auto ? " in auto mode" : "";
    const body = [
      `Merged \`${branch}\` into the local \`${repo.base_branch}\`${how} as \`${r.sha.slice(0, 12)}\` (${push ? "its push to origin is queued" : "no push"}). The item is closed.`,
      ...(stale ? [`\`${repo.base_branch}\` is checked out with uncommitted changes in ${stale}: that checkout was not updated (its HEAD is detached where it was); switch it back to \`${repo.base_branch}\` when ready.`] : []),
    ];
    await this.c.unit("outbox").post(item, item.source, body.join("\n\n"), `<!-- factory:local-merged:${key} -->`);
    await this.c.k.guard("dependents", () => this.c.unit("coordination").releaseDependents(item.source.id));
    return "landed";
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
      awaitingMerge(it) && it.change_ref === null ? this.c.unit("run-results").autoResolve(it, baseSha, { cause }, null) : null);
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

  /** A refusal posted on the item: why the merge did not apply, keyed by `key`. */
  async refused(id: WorkItemId, by: string, key: string, refusal: string): Promise<void> {
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
   * A delivered base push (design 05-sources, Local items; RFC 0015 M8): outbound's `local` target fetched the
   * remote base, merged it into the local base when it moved, and pushed, conditionally on the remote base it read.
   * A failure (an outage, a rate limit, a base that moved again) is a delivery failure outbound retries with its
   * batch's backoff. A remote base that does not merge cleanly posts one message on the item, which stays closed:
   * the merge happened, only its push waits for a person. Never changes an item.
   */
  async basePushDelivered(row: ActionRow): Promise<void> {
    const r = basePushOutcome(row);
    if (r === null || !row.work_item_id) return;
    const base = String(row.args.base_ref);
    if ("pushed" in r) {
      this.c.k.d.log.info("base pushed", { work_item_id: row.work_item_id, base_ref: base, sha: r.pushed });
      return;
    }
    const item = await this.c.k.reader.getWorkItem(row.work_item_id as WorkItemId);
    if (!item) return;
    const body = [
      `The local \`${base}\` (with this item's merge \`${String(row.args.merge_sha).slice(0, 12)}\`) was not pushed: \`origin/${base}\` moved and does not merge cleanly into it. Conflicting files:`,
      "",
      ...r.conflicts.map((f) => `- \`${f}\``),
      "",
      `The item stays closed. In the factory repo, merge \`origin/${base}\` into \`${base}\`, commit the resolution and push \`${base}\` by hand.`,
    ].join("\n");
    await this.c.unit("outbox").post(item, item.source, body, `<!-- factory:base-push-conflict:${row.seq} -->`);
  }

  /**
   * Auto mode's merge (design 03-risk): each local item waiting for a merge, in a project in auto mode, merges
   * through mergeLocal (actor `system:auto`, the mode change on its state change) when autoMergeRefusal allows it:
   * the change enters the merge queue, so a failing check or a conflict on its merged result moves nothing. One try per
   * passed review: a refusal is posted once under a key of that review run, and the item stays in merge_pending for a person.
   * A sync source's item is never merged here (no forge merge to call); it waits as in manual mode, with no post.
   */
  async autoMergeStep(): Promise<void> {
    const r = this.c.k.live.resolved();
    if (r.global.mode.value !== "auto" && !Object.values(r.projects).some((p) => p.mode?.value === "auto")) return;
    const waiting = await this.c.k.reader.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "human", limit: AUTO_MERGE_BATCH });
    for (const it of waiting) {
      if (!awaitingMerge(it) || it.source.type !== LOCAL_SOURCE || it.change_ref !== null) continue;
      const auto = await this.autoMode(it.project);
      if (!auto) continue;
      // Keyed by the review that passed, not the item version: the merge queue's own state changes bump the version.
      const review = await this.c.unit("run-results").latestReview(it.id);
      const key = `auto-merge:${it.id}:${review?.id ?? `v${it.version}`}`;
      if ((await this.c.k.reader.listItemMessages(it.id)).some((m) => m.marker.endsWith(`:${key} -->`))) continue;
      const missing = lastPrNotes(await this.c.k.reader.listRuns(it.id))?.missing ?? [];
      const refusal = autoMergeRefusal({
        tier: it.tier ?? 5,
        max_tier: this.c.k.live.values().auto_merge_max_tier,
        incomplete: missing.length > 0,
        gate_path: gatePathTouched([...it.allowed_paths, ...(it.pr_files ?? [])]),
        local: true,
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

  /**
   * Red main (design 03-risk): after an automatic merge, the install command and the checks run again on the new
   * base tip in a fresh detached checkout. A failure, or a check that could not run, sets the mode back to manual.
   */
  async redMainCheck(it: WorkItem): Promise<void> {
    const sandbox = this.c.k.d.sandbox;
    if (!sandbox) return;
    const { repo } = this.c.k.cfg;
    let failed: string | null = null;
    try {
      const h = await sandbox.create({ repo: repo.path, branch: null, base_ref: repo.base_branch });
      try {
        for (const cmd of [repo.install_command, ...checkCommands(repo)]) {
          const r = await sandbox.exec(h, cmd, { env: this.c.k.d.check_env ?? {}, timeout_ms: this.c.k.cfg.run_timeout_ms });
          if (r.exit_code === 0) continue;
          failed = `\`${cmd.join(" ")}\` ${r.timed_out ? "timed out" : `exited ${r.exit_code}`} on the new tip of \`${repo.base_branch}\``;
          break;
        }
      } finally {
        await sandbox.destroy(h);
      }
    } catch (err) {
      failed = `the checks could not run on the new tip of \`${repo.base_branch}\`: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`;
    }
    if (failed !== null) await this.stopAuto(it.project, "red_main", failed);
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
