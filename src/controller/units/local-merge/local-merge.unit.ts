// The local merge, base pushes, auto mode's merges and its stop conditions.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { checkCommands } from "../../../core/checks.js";
import { ALERT_DEDUPE_MS } from "../../../core/alarms.js";
import { modeOf } from "../../../core/settings.js";
import { AUTO_ACTOR, autoMergeRefusal, retryDelayMs, branchFor } from "../../../core/policy.js";
import { type BaseSyncSandbox, LOCAL_SOURCE, MERGE_COMMAND, canMergeLocal, canSyncBase } from "../../../core/local-merge.js";
import { gatePathTouched } from "../../../core/improver.js";
import { lastPrNotes } from "../../../core/pr-body.js";
import { type Actor, type UserId, type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { ExternalIdentity } from "../../../interfaces/auth-provider.js";
import type { BasePush } from "../../../interfaces/factory-store.js";
import type { Forge } from "../../../interfaces/forge.js";
import { AUTO, awaitingMerge } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** mergeLocal's `who` for auto mode's merge: no person, actor `system:auto`. */
const AUTO_MERGE = { auto: true } as const;
/** Settings audit rows read to find the mode change an automatic action ran under. */
const MODE_HISTORY = 500;
/** Items waiting for a merge looked at per auto-merge step. */
const AUTO_MERGE_BATCH = 20;
/** Why auto mode went back to manual: the alert's error code (design 03-risk, stop conditions). */
type AutoStop = "red_main" | "failure_alert" | "budget_checkpoint";
/** Base pushes one outbox step tries at most: each fetches the remote base, so a few at a time. */
const BASE_PUSH_BATCH = 5;

/** Why a branch that does not merge cleanly into the local base was not merged, with the conflicting files. */
function conflictRefusal(id: WorkItemId, branch: string, base: string, conflicts: readonly string[]): string {
  return [
    `\`${branch}\` does not merge cleanly into the local \`${base}\`, so nothing moved and the item still waits for a merge. Conflicting files:`,
    "",
    ...conflicts.map((f) => `- \`${f}\``),
    "",
    `\`${branch}\` is a local branch of this repository: merge \`${base}\` into it and commit the resolution there, then run \`factory merge ${id}\` again`,
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
   * for a merge, and at once for a branch that conflicts with the local base. Otherwise the change enters the merge
   * queue (RFC 0015 M8, the merge-queue unit): a merge-check run checks its merged result, and only a green one
   * lands (`land`); a red one is removed and the reply says why, and the item stays in merge_pending. A checkout of
   * the base is fast-forwarded when clean and left as it was otherwise (the close's detail and the reply say so).
   * `who` AUTO_MERGE is auto mode's merge (autoMergeStep, design 03-risk): no person to authorize, actor
   * `system:auto`, and the state change names the mode change it ran under. Safe to run twice: the same `key` is
   * the same queue entry; `key` keys the replies and `detail` goes on the state change. Returns the refusal, or
   * null when the change is in the queue.
   */
  async mergeLocal(id: WorkItemId, who: ExternalIdentity | UserId | typeof AUTO_MERGE, key: string, detail: Record<string, unknown> = {}): Promise<string | null> {
    const item = await this.c.k.d.store.getWorkItem(id);
    if (!item) return "the work item was not found";
    const { repo, branch_prefix } = this.c.k.cfg;
    const branch = branchFor(item, branch_prefix);
    const auto = who === AUTO_MERGE;
    const principal = typeof who === "string"
      ? await this.c.unit("auth").allowed({ user_id: who, attributes: {} }, "approve_merge", item.id, true)
      : "auto" in who
        ? { user_id: AUTO_ACTOR }
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
      else if (conflicts.length > 0) refusal = conflictRefusal(item.id, branch, repo.base_branch, conflicts);
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
   * The merge itself (RFC 0015 M8): the merge queue calls it for an entry whose merge-check run passed on `base_sha`.
   * The sandbox merges the item's local branch into the local base only while the base is still at `base_sha`, so
   * the tree that lands is the tree that was checked (no check runs again); a base that moved returns `moved`, and
   * the queue checks the entry again. A merge closes the item (completed, its merge sha) with the approver, or
   * `system:auto`, as its actor and releases the items waiting on it; with a forge that can push a base, the same
   * transition queues one base push. This is the function the outbound `local` merge delivery takes over (M7).
   */
  async land(id: WorkItemId, by: string, key: string, base_sha: string, detail: Record<string, unknown>): Promise<"landed" | "moved" | string> {
    const item = await this.c.k.d.store.getWorkItem(id);
    if (!item) return "the work item was not found";
    if (!awaitingMerge(item) || item.change_ref !== null) return `${item.id} is no longer waiting for a merge`;
    if (!canMergeLocal(this.c.k.d.sandbox)) return "this controller has no sandbox that can merge locally";
    const { repo, branch_prefix } = this.c.k.cfg;
    const branch = branchFor(item, branch_prefix);
    const auto = by === AUTO_ACTOR;
    const r = await this.c.k.d.sandbox.mergeLocal({
      repo: repo.path, base_ref: repo.base_branch, branch, identity: this.c.k.cfg.agent_git_identity,
      checks: [], timeout_ms: this.c.k.cfg.run_timeout_ms, expected_base: base_sha,
      message: `Merge ${branch} into ${repo.base_branch}\n\nWork item ${item.id}, merged by ${by} ${auto ? "in auto mode" : "with `factory merge`"}.`,
    });
    if (!r.merged) {
      if ("base_moved" in r) return "moved";
      return "conflicts" in r ? conflictRefusal(item.id, branch, repo.base_branch, r.conflicts) : r.refused;
    }
    const actor: Actor = auto ? AUTO : { kind: "user", id: by as UserId };
    const push = this.basePusher() !== null;
    const stale = r.not_updated.join(", ");
    const lost = await this.c.unit("transitions").decide(item.id, (it) => (awaitingMerge(it) && it.change_ref === null
      ? {
          patch: { stage: "CLOSED", close_reason: "completed", merge_sha: r.sha, blocked_on: "none", blocked_reason: null },
          actor,
          reason: "local_merged",
          detail: {
            ...detail, branch, base_ref: repo.base_branch, ...(r.already ? { already_merged: true } : {}), ...(stale ? { checkout_not_updated: stale } : {}),
          },
          ...(push ? { base_push: { base_ref: repo.base_branch, merge_sha: r.sha } } : {}),
        }
      : null));
    if (lost !== null) return lost;
    this.c.k.d.log.info("local merge", { work_item_id: item.id, merge_sha: r.sha, user_id: by, base_push: push });
    const how = auto ? " in auto mode" : "";
    const body = [
      `Merged \`${branch}\` into the local \`${repo.base_branch}\`${how} as \`${r.sha.slice(0, 12)}\` (${push ? "its push to origin is queued" : "no push"}). The item is closed.`,
      ...(stale ? [`\`${repo.base_branch}\` is checked out with uncommitted changes in ${stale}: that checkout was not updated (its HEAD is detached where it was); switch it back to \`${repo.base_branch}\` when ready.`] : []),
    ];
    await this.c.unit("outbox").post(item, item.source, body.join("\n\n"), `<!-- factory:local-merged:${key} -->`);
    await this.c.k.guard("dependents", () => this.c.unit("coordination").releaseDependents(item.source.id));
    // Red main (design 03-risk): the checks run again on the new base tip; a failure stops auto mode.
    if (auto && !r.already) await this.c.k.guard("red main", () => this.redMainCheck(item));
    return "landed";
  }

  /** The item's local branch. */
  branchOf(item: WorkItem): string {
    return branchFor(item, this.c.k.cfg.branch_prefix);
  }

  /** The item, as the merge queue checks whether its entry still waits for a merge. */
  item(id: WorkItemId): Promise<WorkItem | null> {
    return this.c.k.d.store.getWorkItem(id);
  }

  /** A refusal posted on the item: why the merge did not apply, keyed by `key`. */
  async refused(id: WorkItemId, by: string, key: string, refusal: string): Promise<void> {
    const item = await this.c.k.d.store.getWorkItem(id);
    if (!item) return;
    this.c.k.d.log.info("command refused", { work_item_id: id, command: MERGE_COMMAND, reason: refusal.split("\n")[0]!.slice(0, 300) });
    const what = by === AUTO_ACTOR ? "The automatic merge" : "`factory merge`";
    await this.c.unit("outbox").post(item, item.source, `${what} was not applied: ${refusal}.`, `<!-- factory:refused:${key} -->`);
  }

  /** The forge's base push and the sandbox that syncs the base before it, or null when either cannot (no push is queued). */
  basePusher(): { push: NonNullable<Forge["pushBase"]>; sandbox: BaseSyncSandbox } | null {
    const forge = this.c.k.forge;
    const sandbox = this.c.k.d.sandbox;
    if (!forge?.pushBase || !canSyncBase(sandbox)) return null;
    return { push: (input) => forge.pushBase!(input), sandbox };
  }

  /**
   * The base push step (design 05-sources, Local items): each pending base push is claimed by a conditional update,
   * so one replica makes it. The sandbox fetches the remote base and merges it into the local base when it moved;
   * the forge then pushes, conditionally on the remote base the sandbox read. A failure (an outage, a rate limit, a
   * base that moved again) counts an attempt and is retried with backoff (retry_base_ms doubling up to
   * retry_max_ms). A remote base that does not merge cleanly finishes the row as `conflict` and posts one message
   * on the item, which stays closed: the merge happened, only its push waits for a person. Never changes an item.
   */
  async basePushStep(): Promise<void> {
    const pusher = this.basePusher();
    if (!pusher) return;
    for (const row of await this.c.k.d.store.listPendingBasePushes(BASE_PUSH_BATCH)) {
      await this.c.k.guard("base push", () => this.pushBase(row, pusher));
    }
  }

  async pushBase(row: BasePush, pusher: NonNullable<ReturnType<LocalMergeUnit["basePusher"]>>): Promise<void> {
    const token = await this.c.k.d.store.claimBasePush(row.seq, this.c.k.cfg.lease_ms);
    if (token === null) return;
    const { path } = this.c.k.cfg.repo;
    try {
      const s = await pusher.sandbox.syncBase({
        repo: path, base_ref: row.base_ref, merge_sha: row.merge_sha, identity: this.c.k.cfg.agent_git_identity,
        message: `Merge origin/${row.base_ref} into ${row.base_ref}\n\nBefore the base push of work item ${row.work_item_id}.`,
      });
      if (!s.synced) {
        await this.c.k.d.store.finishBasePush(row.seq, token, { outcome: "conflict", pushed_sha: null, error: `conflicts: ${s.conflicts.join(", ")}` });
        await this.basePushConflict(row, s.conflicts);
        return;
      }
      if (!s.contains) await pusher.push({ repo: path, base_ref: row.base_ref, sha: s.local, expected_sha: s.remote });
      await this.c.k.d.store.finishBasePush(row.seq, token, { outcome: "pushed", pushed_sha: s.contains ? s.remote : s.local });
      this.c.k.d.log.info("base pushed", { work_item_id: row.work_item_id, base_ref: row.base_ref, sha: s.contains ? s.remote : s.local });
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 300) : "unknown";
      const delay = retryDelayMs(row.attempts + 1, this.c.k.cfg.retry_base_ms, this.c.k.cfg.retry_max_ms);
      this.c.k.d.log.warn("base push failed; retried later", { work_item_id: row.work_item_id, attempts: row.attempts + 1, retry_in_ms: delay, error });
      await this.c.k.d.store.failBasePush(row.seq, token, error, delay);
    }
  }

  /** One message on the closed item: its merge stays local until a person merges the remote base by hand and pushes. */
  async basePushConflict(row: BasePush, conflicts: readonly string[]): Promise<void> {
    const item = await this.c.k.d.store.getWorkItem(row.work_item_id);
    if (!item) return;
    const base = row.base_ref;
    const body = [
      `The local \`${base}\` (with this item's merge \`${row.merge_sha.slice(0, 12)}\`) was not pushed: \`origin/${base}\` moved and does not merge cleanly into it. Conflicting files:`,
      "",
      ...conflicts.map((f) => `- \`${f}\``),
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
    const waiting = await this.c.k.d.store.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "human", limit: AUTO_MERGE_BATCH });
    for (const it of waiting) {
      if (!awaitingMerge(it) || it.source.type !== LOCAL_SOURCE || it.change_ref !== null) continue;
      const auto = await this.autoMode(it.project);
      if (!auto) continue;
      // Keyed by the review that passed, not the item version: the merge queue's own state changes bump the version.
      const review = await this.c.unit("run-results").latestReview(it.id);
      const key = `auto-merge:${it.id}:${review?.id ?? `v${it.version}`}`;
      if ((await this.c.k.d.store.listItemMessages(it.id)).some((m) => m.marker.endsWith(`:${key} -->`))) continue;
      const missing = lastPrNotes(await this.c.k.d.store.listRuns(it.id))?.missing ?? [];
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
    return (await this.c.k.d.store.listSettingChanges(MODE_HISTORY)).find((c) => c.key === "mode" && c.project === level)?.seq ?? null;
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
    const scan = await this.c.k.d.scanner.scan("ui", detail);
    const r = await this.c.k.d.store.recordAlert(
      { pattern: "auto_stopped", pattern_key: `auto_stopped:${m.level || "global"}:${seq ?? 0}`, error_code: cause, count: 1, detail: scan.clean ? detail : null },
      ALERT_DEDUPE_MS,
    );
    if (!r.created) return;
    await this.c.k.d.store.setSettingOverride({ key: "mode", project: m.level, value: JSON.stringify("manual"), actor: AUTO_ACTOR });
    await this.c.k.live.refresh();
    this.c.k.d.log.warn("auto mode stopped; the mode is manual again", { cause, alert_id: r.alert.id, mode_change: seq });
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
