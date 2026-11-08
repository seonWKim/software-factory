// The merge queue (RFC 0015 §7 Merge queue, M8): one MergeQueue actor per project and base branch. A change enters
// only when it is ready (reviewed, its own checks green: merge_pending) and approved (`factory merge`, or auto mode
// where its tier allows), so a change waiting on a person is never in it. Each entry is checked as it will land
// (base + the entries ahead + this change) by a `merge-check` run on a worker; the first `merge_queue.depth` entries
// are checked at once (speculative depth; solo default 1). The head lands once its check passed, through the
// `before_merge` hooks; red removes the entry with the reason and rebuilds the entries behind it. A check that does
// not come back in time is ended by the delayed MergeCheckTimedOut message the unit emits when it starts it.
//
// Crash safety: every write is keyed or conditional, so each step may run again. A checking entry whose run is
// missing (the process died before it was queued) gets it again. The landing is an outbound delivery keyed by the
// entry's check (RFC 0015 M8): the queue stays `merging` until its DeliveryCompleted, a landing whose process died
// is taken over after a lease and finds its keyed request (applied once delivered, never requested twice), and a
// landing that threw leaves its entry `merging` for the next step. A result or timer of a check that was replaced
// moves nothing: every such move names the run.

import { createHash } from "node:crypto";
import type { EntryFields, MergeQueue, MergeQueueEntry } from "../../actors/merge-queue/merge-queue.store.js";
import { MergeQueueStore } from "../../actors/merge-queue/merge-queue.store.js";
import { mergeOutcome, type ActionRow } from "../../../outbound/index.js";
import { MERGE_CHECK_TIMED_OUT } from "../../topics/controller-events.topic.js";
import { AUTO, SYSTEM, awaitingMerge } from "../support.js";
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
   * to the run timeout plus a lease to notice a dead worker plus the longest retry backoff before it is claimed again.
   */
  checkTimeoutMs(): number {
    const { run_timeout_ms, lease_ms, retry_max_ms } = this.c.k.cfg;
    return this.c.k.settings(this.c.k.project()).max_attempts * (run_timeout_ms + lease_ms + retry_max_ms);
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
   * check passed lands, and so does a head left landing (a throw) or a landing whose process died (past a lease);
   * each queued entry within the depth gets its check, on the base plus every entry ahead of it, and a checking one
   * whose run is missing gets its run again. Safe to run twice: every move is conditional, and a check's run and
   * timer are keyed by the entry's version.
   */
  async advance(): Promise<void> {
    const s = this.store();
    const q = await this.queueOf();
    if (q.state === "merging" && this.c.k.nowMs() - Date.parse(q.updated_at) < this.c.k.cfg.lease_ms) return;
    const items = new Map<string, WorkItem>();
    for (const e of await s.live(q.queue_id)) {
      // A landing entry's item closes as it lands: only the landing decides on it.
      if (e.state === "merging") continue;
      const item = await this.c.unit("local-merge").item(e.work_item_id as WorkItemId);
      if (item && awaitingMerge(item) && item.change_ref === null) items.set(e.entry_id, item);
      else await this.leave(e, "the item no longer waits for a merge", false);
    }
    const live = await s.live(q.queue_id);
    const head = live[0];
    if (q.state === "merging" || head?.state === "passed" || head?.state === "merging") return this.land(q, head);
    const window = live.slice(0, this.c.k.cfg.merge_queue_depth);
    for (const [i, e] of window.entries()) {
      const upTo = window.slice(0, i + 1).map((x) => items.get(x.entry_id));
      if (!upTo.every((it) => it !== undefined)) continue;
      if (e.state === "queued") await this.check(e, upTo as WorkItem[]);
      else if (e.state === "checking" && e.run_key !== null) await this.ensureRun(e.entry_id, e.run_key, upTo as WorkItem[]);
    }
    await this.settle(q.queue_id);
  }

  /**
   * Starts the check of `e` on the base plus `items` (the entries ahead, then its own). The timer first, then the
   * move, then the run: a crash after the timer leaves a queued entry (checked again, the same keys), one after the
   * move a checking entry with its timer (its run is queued again by `advance`).
   */
  private async check(e: MergeQueueEntry, items: readonly WorkItem[]): Promise<void> {
    const run_key = `${e.entry_id}:check:v${e.version}`;
    await this.c.k.emit({
      type: MERGE_CHECK_TIMED_OUT, subject: e.queue_id, idempotency_key: `${run_key}:timeout`, idempotency_key_ttl_ms: TIMER_KEY_TTL_MS,
      not_before: new Date(this.c.k.nowMs() + this.checkTimeoutMs()).toISOString(), payload: { entry_id: e.entry_id, run_key },
    });
    if (!(await this.store().move(e.entry_id, "queued", "checking", { run_key, base_sha: null }))) return;
    await this.queueRun(e.entry_id, run_key, items);
  }

  /** A checking entry's run, queued again when it is missing (the process died before it, or the transition gave up). */
  private async ensureRun(entry_id: string, run_key: string, items: readonly WorkItem[]): Promise<void> {
    const item = items.at(-1)!;
    if ((await this.c.k.reader.listRuns(item.id)).some((r) => r.idempotency_key === run_key)) return;
    await this.queueRun(entry_id, run_key, items);
  }

  private async queueRun(entry_id: string, run_key: string, items: readonly WorkItem[]): Promise<void> {
    const branches = items.map((it) => this.c.unit("local-merge").branchOf(it));
    await this.c.unit("transitions").decide(items.at(-1)!.id, (it) => (awaitingMerge(it)
      ? {
          patch: {}, actor: SYSTEM, reason: "merge_check_queued", detail: { entry_id },
          enqueue: { kind: MERGE_CHECK, idempotency_key: run_key, input: { merge_check: { base_ref: this.c.k.cfg.repo.base_branch, branches } } },
        }
      : null));
  }

  /** The queue's state from its entries, unless it is landing: checking while a check is out, else idle. */
  private async settle(queue_id: string): Promise<void> {
    const s = this.store();
    const q = await this.queueOf();
    if (q.state === "merging") return;
    const out = (await s.live(queue_id)).some((e) => e.state === "checking");
    await s.setQueue(queue_id, q.state, out ? "checking" : "idle");
  }

  /**
   * A finished merge-check run (from run-results): green passes the entry (it lands once at the head), red removes
   * it. A run of an entry that left or was rebuilt meanwhile changes nothing. The run is acked once decided; a
   * decision that threw (a store error) leaves it unacked, so the next runs step decides on it again.
   */
  async checked(run: Run): Promise<void> {
    let decided = false;
    await this.c.k.guard("merge check result", async () => {
      await this.decideCheck(run);
      decided = true;
    });
    if (!decided) return;
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
    // entry ahead landed as, which that landing writes (see landHead), so it is left as it is here.
    const branches = (run.input?.merge_check as { branches?: unknown[] } | undefined)?.branches ?? [];
    const heads = d.heads !== null && typeof d.heads === "object" ? (d.heads as Record<string, string>) : {};
    const set: EntryFields = branches.length === 1 ? { heads, base_sha: String(d.base_sha) } : { heads };
    if (!(await s.move(e.entry_id, "checking", "passed", set, e.run_key))) return;
    await this.advance();
  }

  /**
   * Lands the head entry, whose check passed (or which was left landing): the queue is taken (conditional on the
   * version read, so a stale `merging` is taken over once). It stays `merging` while the merge delivery is out
   * (RFC 0015 M8: outbound makes the merge, `mergeDelivered` applies it and gives the queue back); a landing that
   * requested nothing gives it back here, to its version only.
   */
  private async land(q: MergeQueue, head: MergeQueueEntry | undefined): Promise<void> {
    const s = this.store();
    if (!(await s.setQueue(q.queue_id, q.state, "merging", q.version))) return;
    let out = false;
    try {
      if (head && (head.state === "merging" || (head.state === "passed" && (await s.move(head.entry_id, "passed", "merging"))))) {
        out = await this.landHead({ ...head, state: "merging" });
      }
    } finally {
      if (!out) await s.setQueue(q.queue_id, "merging", "idle", q.version + 1);
    }
    if (!out) await this.advance();
  }

  /** The key of an entry's merge delivery: one per check, so an entry checked again after `moved` lands anew. */
  private mergeKey(e: MergeQueueEntry): string {
    return `merge:${e.entry_id}:${e.run_key ?? "unchecked"}`;
  }

  /**
   * The landing: an automatic entry only while auto mode still may merge it, then the `before_merge` hooks (a veto
   * removes it), then the merge as an outbound delivery (`LocalMergeUnit.requestMerge`, keyed by the entry's check),
   * which moves the base only while it is at the checked commit (`base_sha`) and the branch at the head that was
   * checked. A landing taken over or repeated while its merge is out decides nothing again: the keyed request is
   * found, and applied once delivered. Returns whether the landing holds the queue (a merge out, or settled here).
   */
  private async landHead(e: MergeQueueEntry): Promise<boolean> {
    const lm = this.c.unit("local-merge");
    const key = this.mergeKey(e);
    const sent = await this.c.k.actionByKey(key);
    if (sent !== null) {
      if (sent.delivered_at !== null) await this.mergeDelivered(sent);
      return true;
    }
    const id = e.work_item_id as WorkItemId;
    const base = this.c.k.cfg.repo.base_branch;
    const off = e.entered_by === AUTO.id ? await lm.autoRefusal(id) : null;
    if (off !== null) {
      await this.leave(e, `${off}, so \`${base}\` did not move and the change left the merge queue`, true);
      return false;
    }
    const hooks = await this.c.k.hooks.beforeMerge(e.work_item_id, null, new Date(this.c.k.nowMs()).toISOString());
    if (!hooks.allowed) {
      await this.leave(e, `${hooks.reason}, so \`${base}\` did not move and the change left the merge queue`, true);
      return false;
    }
    const item = await lm.item(id);
    const head = item ? (e.heads[lm.branchOf(item)] ?? null) : null;
    const r = await lm.requestMerge(id, e.entered_by, key, { entry_id: e.entry_id, run_key: e.run_key }, e.base_sha, head);
    if (r === "requested") return true;
    if (r === "landed") return this.landed(e, (await lm.item(id))?.merge_sha ?? null);
    await this.leave(e, r, true);
    return false;
  }

  /**
   * DeliveryCompleted of a merge (from the outbox unit), or a landing that found its merge delivered: a merge closes
   * the item (`LocalMergeUnit.merged`) and the entry is merged; a moved base or branch sends it and every entry
   * checked with it ahead back to be checked; a refusal removes it. Then the queue is given back and moves on. Only
   * the entry still landing under that check changes, so a redelivered or late result changes nothing. A close that
   * did not apply throws: the delivery result is handled again, or the landing's takeover applies it.
   */
  async mergeDelivered(row: ActionRow): Promise<void> {
    const e = await this.store().entry(String(row.args.entry_id));
    const r = mergeOutcome(row);
    if (!e || e.state !== "merging" || e.run_key !== (row.args.run_key ?? null) || r === null) return;
    if (r.merged) {
      const landed = await this.c.unit("local-merge").merged(e.work_item_id as WorkItemId, e.entered_by, e.merge_key, r, e.detail);
      if (landed === "landed") await this.landed(e, r.sha);
      else if (await this.leave(e, landed, true)) await this.release(e, false);
      return;
    }
    // The base or the branch moved between the check and the landing (a merge outside the queue, a commit on the
    // branch): checked again on the new base, and so is every entry checked with it ahead.
    if ("moved" in r) {
      if (!(await this.store().move(e.entry_id, "merging", "queued", { run_key: null, base_sha: null }))) return;
      await this.rebuild(e);
      return this.release(e, false);
    }
    if (await this.leave(e, r.refused, true)) await this.release(e, false);
  }

  /** The entry landed as `merge_sha`: each entry behind it checked with it ahead learns that base. */
  private async landed(e: MergeQueueEntry, merge_sha: string | null): Promise<boolean> {
    const s = this.store();
    if (!(await s.move(e.entry_id, "merging", "merged"))) return true;
    // Checking or passed: a result that comes back meanwhile keeps this base (it writes none of its own).
    for (const behind of await this.behind(e)) await s.move(behind.entry_id, ["checking", "passed"], behind.state, { base_sha: merge_sha });
    await this.release(e, e.entered_by === AUTO.id);
    return true;
  }

  /**
   * The landing is over: the queue is given back and moves on. Red main (design 03-risk) after an automatic merge,
   * once the queue is given back: the checks run again on the new base tip, and a failure stops auto mode before
   * the next automatic landing.
   */
  private async release(e: MergeQueueEntry, auto: boolean): Promise<void> {
    await this.store().setQueue(e.queue_id, "merging", "idle");
    if (auto) {
      const item = await this.c.unit("local-merge").item(e.work_item_id as WorkItemId);
      if (item) await this.c.k.guard("red main", () => this.c.unit("local-merge").redMainCheck(item));
    }
    await this.advance();
  }

  /** The entries behind `e` whose check ran with `e` ahead: checking, or passed and waiting for it to land. */
  private async behind(e: MergeQueueEntry): Promise<MergeQueueEntry[]> {
    return (await this.store().live(e.queue_id)).filter((x) => x.seq > e.seq && (x.state === "checking" || x.state === "passed"));
  }

  /** Every entry checked with `e` ahead goes back to be checked again (its old run's result then changes nothing). */
  private async rebuild(e: MergeQueueEntry): Promise<void> {
    for (const x of await this.behind(e)) await this.store().move(x.entry_id, x.state, "queued", { run_key: null, base_sha: null });
  }

  /** A red check of the entry's current run: it leaves with the reason, the entries behind it are rebuilt, the queue moves on. */
  private async red(e: MergeQueueEntry, reason: string): Promise<void> {
    if (!(await this.leave(e, reason, true, e.run_key ?? undefined))) return;
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

  /**
   * The entry leaves (removed, with the reason posted when `reply`) and every entry checked with it ahead is
   * rebuilt. With `run_key`, only while that check is still the entry's.
   */
  private async leave(e: MergeQueueEntry, reason: string, reply: boolean, run_key?: string): Promise<boolean> {
    if (!(await this.store().move(e.entry_id, e.state, "removed", { reason: reason.slice(0, 1000) }, run_key))) return false;
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
