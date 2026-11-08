// The merge queue (RFC 0015 §7 Merge queue, M8): one MergeQueue actor per project and base branch. A change enters
// only when it is ready (reviewed, its own checks green: merge_pending) and approved (`factory merge`, or auto mode
// where its tier allows), so a change waiting on a person is never in it. Each entry is checked as it will land
// (base + the entries ahead + this change) by a `merge-check` run on a worker; the first `merge_queue.depth` entries
// are checked at once (speculative depth; solo default 1). The head lands once its check passed, through the
// `before_merge` hooks; red removes the entry with the reason and rebuilds the entries behind it. A check that does
// not come back in time is ended by the delayed MergeCheckTimedOut message the unit emits when it starts it.

import { createHash } from "node:crypto";
import { type MergeQueueEntry, MergeQueueStore } from "../../actors/merge-queue/merge-queue.store.js";
import type { MergeQueueState } from "../../actors/merge-queue/merge-queue.actor.js";
import { MERGE_CHECK_TIMED_OUT } from "../../topics/controller-events.topic.js";
import { SYSTEM, awaitingMerge } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";
import type { UnitOperations } from "../../router/unit.js";

// The legacy types through the units that own them, so this unit imports no legacy module.
type WorkItem = NonNullable<Awaited<ReturnType<UnitOperations["local-merge"]["item"]>>>;
type WorkItemId = WorkItem["id"];
type Run = Parameters<UnitOperations["run-results"]["apply"]>[0];

/** The run kind that checks an entry's merged result (src/worker/runs/merge-check/). */
const MERGE_CHECK = "merge-check";
/** How long a timer message's key is kept: past any check's time limit. */
const TIMER_KEY_TTL_MS = 30 * 24 * 3_600_000;

/** The merge queue: entry, check, land or remove, rebuild. */
export class MergeQueueUnit {
  constructor(private readonly c: Ctx) {}

  private store(): MergeQueueStore {
    const db = this.c.k.db;
    if (!db) throw new Error("the merge queue needs a SQL store (sqlite or mysql)");
    return new MergeQueueStore(db, () => new Date(this.c.k.nowMs()).toISOString());
  }

  /** The queue of this controller's project and base branch. */
  private queueOf() {
    return this.store().queue(this.c.k.project(), this.c.k.cfg.repo.base_branch);
  }

  /**
   * How long a check may take before MergeCheckTimedOut ends it: every attempt the reaper may give its run, each up
   * to the run timeout plus a lease to notice a dead worker.
   */
  checkTimeoutMs(): number {
    const { run_timeout_ms, lease_ms } = this.c.k.cfg;
    return this.c.k.settings(this.c.k.project()).max_attempts * (run_timeout_ms + lease_ms);
  }

  /**
   * Puts a ready, approved change at the end of the queue and starts its check when it is within the speculative
   * depth. `by` is the approver's user id or `system:auto`; `key` keys the replies (one entry per key, so a replayed
   * command is the same entry). Returns the refusal (already in the queue), or null.
   */
  async enter(item: WorkItem, by: string, key: string, detail: Record<string, unknown>): Promise<string | null> {
    const q = await this.queueOf();
    const entry_id = `mqe_${createHash("sha256").update(`${item.id}\n${key}`).digest("hex").slice(0, 24)}`;
    const r = await this.store().enter({ entry_id, queue_id: q.queue_id, work_item_id: item.id, entered_by: by, merge_key: key, detail });
    if ("refused" in r) return `${item.id} is already in the merge queue (${r.refused.state})`;
    if (r.created) {
      const ahead = (await this.store().live(q.queue_id)).filter((e) => e.seq < r.entry.seq).length;
      await this.c.unit("outbox").post(item, item.source,
        `The change is in the merge queue${ahead > 0 ? ` behind ${ahead} other${ahead === 1 ? "" : "s"}` : ""}: it lands once its merged result passes the checks.`,
        `<!-- factory:merge-queued:${key} -->`);
    }
    await this.advance();
    return null;
  }

  /**
   * Moves the queue on: an entry whose item no longer waits for a merge (closed, sent back) leaves; a head whose
   * check passed lands; each queued entry within the depth gets its check, on the base plus every entry ahead of
   * it. Safe to run twice: every move is conditional, and a check's run is keyed by the entry's version.
   */
  async advance(): Promise<void> {
    const s = this.store();
    const q = await this.queueOf();
    if (q.state === "paused" || q.state === "merging") return;
    const items = new Map<string, WorkItem>();
    for (const e of await s.live(q.queue_id)) {
      const item = await this.c.unit("local-merge").item(e.work_item_id as WorkItemId);
      if (item && awaitingMerge(item) && item.change_ref === null) items.set(e.entry_id, item);
      else await this.leave(e, "the item no longer waits for a merge", false);
    }
    const live = await s.live(q.queue_id);
    if (live[0]?.state === "passed") return this.land(q.queue_id, q.state, live[0]);
    const window = live.slice(0, this.c.k.cfg.merge_queue_depth);
    for (const [i, e] of window.entries()) {
      const upTo = window.slice(0, i + 1).map((x) => items.get(x.entry_id));
      if (e.state === "queued" && upTo.every((it) => it !== undefined)) await this.check(e, upTo as WorkItem[]);
    }
    await this.settle(q.queue_id);
  }

  /** Starts the check of `e` on the base plus `items` (the entries ahead, then its own), with its timeout timer. */
  private async check(e: MergeQueueEntry, items: readonly WorkItem[]): Promise<void> {
    const run_key = `${e.entry_id}:check:v${e.version}`;
    if (!(await this.store().move(e.entry_id, "queued", "checking", { run_key, base_sha: null }))) return;
    const branches = items.map((it) => this.c.unit("local-merge").branchOf(it));
    const item = items.at(-1)!;
    await this.c.unit("transitions").decide(item.id, (it) => (awaitingMerge(it)
      ? {
          patch: {}, actor: SYSTEM, reason: "merge_check_queued", detail: { entry_id: e.entry_id },
          enqueue: { kind: MERGE_CHECK, idempotency_key: run_key, input: { merge_check: { base_ref: this.c.k.cfg.repo.base_branch, branches } } },
        }
      : null));
    await this.c.k.emit({
      type: MERGE_CHECK_TIMED_OUT, subject: e.queue_id, idempotency_key: `${run_key}:timeout`, idempotency_key_ttl_ms: TIMER_KEY_TTL_MS,
      not_before: new Date(this.c.k.nowMs() + this.checkTimeoutMs()).toISOString(), payload: { entry_id: e.entry_id, run_key },
    });
  }

  /** The queue's state from its entries, unless it is paused or landing: checking while a check is out, else idle. */
  private async settle(queue_id: string): Promise<void> {
    const s = this.store();
    const q = await this.queueOf();
    if (q.state === "paused" || q.state === "merging") return;
    const out = (await s.live(queue_id)).some((e) => e.state === "checking");
    await s.setQueue(queue_id, q.state, out ? "checking" : "idle");
  }

  /**
   * A finished merge-check run (from run-results): green passes the entry (it lands once at the head), red removes
   * it. A run of an entry that left or was rebuilt meanwhile changes nothing. The run is acked either way.
   */
  async checked(run: Run): Promise<void> {
    await this.c.k.guard("merge check result", () => this.decideCheck(run));
    await this.c.unit("transitions").decide(run.work_item_id, () => ({ patch: {}, actor: SYSTEM, reason: "merge_check_done", ack_run: run.id }));
  }

  private async decideCheck(run: Run): Promise<void> {
    const s = this.store();
    const e = await s.byRun(run.idempotency_key);
    if (!e || e.state !== "checking" || e.run_key !== run.idempotency_key) return;
    if (run.outcome?.status !== "succeeded") {
      const code = run.outcome?.status === "failed" ? run.outcome.error_code : run.status;
      return this.red(e, `its merge check could not run (\`${code}\`); run \`factory merge\` again`);
    }
    const d = run.outcome.data;
    if (d.result !== "green") {
      const base = this.c.k.cfg.repo.base_branch;
      const why = d.why === "conflict"
        ? `the merged commit conflicts in ${(Array.isArray(d.conflicts) ? d.conflicts : []).map((f) => `\`${String(f)}\``).join(", ")}`
        : `\`${String(d.command)}\` ${String(d.how)} on the merged commit`;
      return this.red(e, `${why}, so \`${base}\` did not move and the change left the merge queue; fix it on the branch and run the merge again`);
    }
    // The base the landing must find: the checked base when no entry was ahead of it; else the commit the last
    // entry ahead landed as, which that landing sets (see land). Not known yet while an entry ahead is still live.
    const head = (await s.live(e.queue_id))[0]?.entry_id === e.entry_id;
    const base_sha = e.base_sha ?? (head ? String(d.base_sha) : null);
    if (!(await s.move(e.entry_id, "checking", "passed", { base_sha }))) return;
    await this.advance();
  }

  /**
   * Lands the head entry, whose check passed: the `before_merge` hooks first (a veto removes it), then
   * `LocalMergeUnit.land`, which moves the base only while it is still at the checked commit (`base_sha`). Each entry
   * behind it that was checked with it ahead learns the commit it landed as; a moved base sends it and them back.
   */
  private async land(queue_id: string, from: MergeQueueState, e: MergeQueueEntry): Promise<void> {
    const s = this.store();
    if (!(await s.setQueue(queue_id, from, "merging"))) return;
    if (await s.move(e.entry_id, "passed", "merging")) await this.landHead({ ...e, state: "merging" });
    await s.setQueue(queue_id, "merging", "idle");
    await this.advance();
  }

  private async landHead(e: MergeQueueEntry): Promise<void> {
    const s = this.store();
    const at = new Date(this.c.k.nowMs()).toISOString();
    const hooks = await this.c.k.hooks.beforeMerge(e.work_item_id, null, at);
    if (!hooks.allowed) {
      await this.leave(e, `${hooks.reason}, so \`${this.c.k.cfg.repo.base_branch}\` did not move and the change left the merge queue`, true);
      return;
    }
    const landed = await this.c.unit("local-merge").land(e.work_item_id as WorkItemId, e.entered_by, e.merge_key, e.base_sha!, e.detail);
    if (landed === "landed") {
      await s.move(e.entry_id, "merging", "merged");
      const merge_sha = (await this.c.unit("local-merge").item(e.work_item_id as WorkItemId))?.merge_sha ?? null;
      for (const behind of await this.behind(e)) await s.move(behind.entry_id, behind.state, behind.state, { base_sha: merge_sha });
      return;
    }
    // The base moved between the check and the landing (a merge outside the queue): checked again on the new base,
    // and so is every entry checked with it ahead.
    if (landed === "moved") {
      if (await s.move(e.entry_id, "merging", "queued", { run_key: null, base_sha: null })) await this.rebuild(e);
      return;
    }
    await this.leave(e, landed, true);
  }

  /** The entries behind `e` whose check ran with `e` ahead: checking, or passed and waiting for it to land. */
  private async behind(e: MergeQueueEntry): Promise<MergeQueueEntry[]> {
    return (await this.store().live(e.queue_id)).filter((x) => x.seq > e.seq && (x.state === "checking" || x.state === "passed"));
  }

  /** Every entry checked with `e` ahead goes back to be checked again (its old run's result then changes nothing). */
  private async rebuild(e: MergeQueueEntry): Promise<void> {
    for (const x of await this.behind(e)) await this.store().move(x.entry_id, x.state, "queued", { run_key: null, base_sha: null });
  }

  /** A red check: the entry leaves with the reason, the entries behind it are rebuilt, and the queue moves on. */
  private async red(e: MergeQueueEntry, reason: string): Promise<void> {
    if (!(await this.leave(e, reason, true))) return;
    await this.advance();
  }

  /**
   * A stuck check (MergeCheckTimedOut, emitted when the check started): an entry still checking under `run_key`
   * leaves, and the queue moves on. A late result of that run then changes nothing.
   */
  async timedOut(entry_id: string, run_key: string): Promise<void> {
    const e = await this.store().entry(entry_id);
    if (!e || e.state !== "checking" || e.run_key !== run_key) return;
    await this.red(e, "its merge check did not finish in time; run `factory merge` again");
  }

  /** The entry leaves (removed, with the reason posted when `reply`) and every entry checked with it ahead is rebuilt. */
  private async leave(e: MergeQueueEntry, reason: string, reply: boolean): Promise<boolean> {
    if (!(await this.store().move(e.entry_id, e.state, "removed", { reason: reason.slice(0, 1000) }))) return false;
    this.c.k.d.log.info("merge queue entry removed", { work_item_id: e.work_item_id, entry_id: e.entry_id });
    await this.rebuild(e);
    if (reply) await this.c.unit("local-merge").refused(e.work_item_id as WorkItemId, e.entered_by, e.merge_key, reason);
    return true;
  }

  /** On the controller's tick: the queue moves on after a restart or a removal another replica made. */
  async queueStep(): Promise<void> {
    await this.advance();
  }

  /** Every entry of the item, oldest first (tests and the status page). */
  entries(id: WorkItemId): Promise<MergeQueueEntry[]> {
    return this.store().ofItem(id);
  }
}


declare module "../../router/unit.js" {
  interface UnitOperations {
    "merge-queue": MergeQueueUnit;
  }
}

export default controllerUnit({
  name: "merge-queue",
  create: (c: Ctx) => new MergeQueueUnit(c),
  steps: [
    { name: "merge queue", every: "tick", order: 95, run: (u) => u.queueStep() },
  ],
  messages: {
    [MERGE_CHECK_TIMED_OUT]: (u, m) => u.timedOut(String(m.payload.entry_id), String(m.payload.run_key)),
  },
});
