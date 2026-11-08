// The merge queue (RFC 0015 §7 Merge queue, M8): one MergeQueue actor per project and base branch. A change enters
// only when it is ready (reviewed, its own checks green: merge_pending) and approved (`factory merge`, or auto mode
// where its tier allows), so a change waiting on a person is never in it. Each entry is checked as it will land
// (base + the entries ahead + this change) by a `merge-check` run on a worker; green lands it, red removes it with
// the reason and rebuilds the entries behind it. Solo default and today's only path: depth 1, no batching.

import { createHash } from "node:crypto";
import { type MergeQueueEntry, MergeQueueStore } from "../../actors/merge-queue/merge-queue.store.js";
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
   * Puts a ready, approved change at the end of the queue and starts its check when it is at the head. `by` is the
   * approver's user id or `system:auto`; `key` keys the replies (one entry per key, so a replayed command is the
   * same entry). Returns the refusal (already in the queue), or null.
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
   * Starts the check of the head entry when the queue is idle (depth 1). An entry whose item no longer waits for a
   * merge (closed, sent back) leaves first. Safe to run twice: every move is conditional, and the run is keyed by
   * the entry's version.
   */
  async advance(): Promise<void> {
    const s = this.store();
    const q = await this.queueOf();
    if (q.state !== "idle") return;
    for (const e of await s.live(q.queue_id)) {
      const item = await this.c.unit("local-merge").item(e.work_item_id as WorkItemId);
      if (!item || !awaitingMerge(item) || item.change_ref !== null) {
        await this.remove(e, "the item no longer waits for a merge", false);
        continue;
      }
      if (e.state !== "queued") return;
      const run_key = `${e.entry_id}:check:v${e.version}`;
      if (!(await s.setQueue(q.queue_id, "idle", "checking"))) return;
      if (!(await s.move(e.entry_id, "queued", "checking", { run_key }))) {
        await s.setQueue(q.queue_id, "checking", "idle");
        return;
      }
      const branch = this.c.unit("local-merge").branchOf(item);
      await this.c.unit("transitions").decide(item.id, (it) => (awaitingMerge(it)
        ? {
            patch: {}, actor: SYSTEM, reason: "merge_check_queued", detail: { entry_id: e.entry_id },
            enqueue: { kind: MERGE_CHECK, idempotency_key: run_key, input: { merge_check: { base_ref: this.c.k.cfg.repo.base_branch, branches: [branch] } } },
          }
        : null));
      return;
    }
  }

  /**
   * A finished merge-check run (from run-results): green lands the entry, red removes it with the reason. A run of
   * an entry that left meanwhile (timed out, removed) changes nothing. The run is acked either way.
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
    const base_sha = String(d.base_sha);
    if (!(await s.move(e.entry_id, "checking", "merging", { base_sha }))) return;
    await s.setQueue(e.queue_id, "checking", "merging");
    const landed = await this.c.unit("local-merge").land(e.work_item_id as WorkItemId, e.entered_by, e.merge_key, base_sha, e.detail);
    if (landed === "landed") await s.move(e.entry_id, "merging", "merged");
    // The base moved between the check and the landing (a merge outside the queue): checked again on the new base.
    else if (landed === "moved") await s.move(e.entry_id, "merging", "queued", { run_key: null });
    else await this.remove({ ...e, state: "merging" }, landed, true);
    await s.setQueue(e.queue_id, "merging", "idle");
    await this.advance();
  }

  /** A red check: the entry leaves with the reason, the entries behind it are rebuilt, and the next one is checked. */
  private async red(e: MergeQueueEntry, reason: string): Promise<void> {
    const s = this.store();
    if (!(await this.remove(e, reason, true))) return;
    // Rebuild (depth 1: none is checking behind it yet): an entry checked with this one ahead of it is checked again.
    for (const behind of (await s.live(e.queue_id)).filter((x) => x.seq > e.seq && x.state === "checking")) {
      await s.move(behind.entry_id, "checking", "queued", { run_key: null });
    }
    await s.setQueue(e.queue_id, "checking", "idle");
    await this.advance();
  }

  /**
   * A guard for a stuck check (MergeCheckTimedOut): an entry still checking under `run_key` leaves, and the queue
   * moves on. A late result of that run then changes nothing.
   */
  async timedOut(entry_id: string, run_key: string): Promise<void> {
    const e = await this.store().entry(entry_id);
    if (!e || e.state !== "checking" || e.run_key !== run_key) return;
    await this.red(e, "its merge check did not finish in time; run `factory merge` again");
  }

  private async remove(e: MergeQueueEntry, reason: string, reply: boolean): Promise<boolean> {
    if (!(await this.store().move(e.entry_id, e.state, "removed", { reason: reason.slice(0, 1000) }))) return false;
    this.c.k.d.log.info("merge queue entry removed", { work_item_id: e.work_item_id, entry_id: e.entry_id });
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
});
