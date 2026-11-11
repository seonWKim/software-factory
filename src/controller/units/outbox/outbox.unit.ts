// What the controller asks outbound to write (RFC 0015 M7): thread entries, status labels, 👀 reactions, issue closes
// and posts on sources with no work item are stored as intents, and the outbox step announces them as
// DeliveryRequested; outbound batches and delivers them, and DeliveryCompleted comes back to `delivered`.
// It reads through the kernel's reader and writes through the kernel's commit (RFC 0015 M5): every reply of every
// unit is a `threadEntry` write, and the one builder of an entry is `threadEntry` in kernel.ts.

import { prNumber } from "../../../core/change-ref.js";
import { LOCAL_SOURCE, threadDelivery } from "../../../core/local-merge.js";
import { isCliCommandKey } from "../../../core/local-cli.js";
import { type WorkStatus, statusOf } from "../../../core/status-label.js";
import { type SourceRef, type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { ThreadLinkField } from "../../../interfaces/factory-store.js";
import { labelTarget } from "../../../interfaces/factory-store.js";
import { TACIT_LEDGER, THREAD_INTENT, type NewAction } from "../../../outbound/index.js";
import type { Ctx } from "../context.js";
import { type ControllerWrite, type ThreadEntry, deliveredUrl, threadEntry } from "../kernel.js";
import { controllerUnit } from "../context.js";

/** Items the start-up status catch-up reads (newest first). Past this, a warning; the rest stay as they are. */
const CATCH_UP_LIMIT = 1000;

/** What the controller asks outbound to write: thread entries, status labels, 👀 reactions, closes, posts. */
export class OutboxUnit {
  constructor(private readonly c: Ctx) {}

  /** True until the start-up status catch-up ran in full; a low request budget defers it (issue #254). */
  catchUpPending = true;

  /**
   * Re-applies the status of every open item, so items from before status labels existed, and any label
   * write that failed or landed out of order, are corrected on start. Each call is idempotent and guarded.
   */
  async catchUpStatus(): Promise<boolean> {
    // An optional read: with the request budget low it waits for the reset (issue #254); run() asks again each tick.
    await this.c.k.guard("sync", () => this.c.unit("sync").syncStep());
    if (this.c.unit("sync").lowBudget()) return false;
    const items = await this.c.k.reader.listWorkItems(CATCH_UP_LIMIT);
    if (items.length >= CATCH_UP_LIMIT) {
      this.c.k.d.log.warn("status catch-up hit its limit", { limit: CATCH_UP_LIMIT });
    }
    const open = items.filter((it) => it.stage !== "CLOSED");
    // One batched read of the stored label states: a target already showing its status costs no call at all.
    const stored = await this.c.k.reader.listLabelStates(open.map((it) => it.source.id));
    const shown = new Set(stored.map((l) => `${l.source_id} ${l.target} ${l.status}`));
    for (const it of open) {
      if (this.c.unit("sync").lowBudget()) return false;
      await this.showStatus(it, (pr) => shown.has(`${it.source.id} ${labelTarget(pr)} ${statusOf(it)}`));
    }
    this.catchUpPending = false;
    return true;
  }

  /**
   * A reply on a source that is no work item (a `/link` on a plain issue, a refused chat intake) has no thread to
   * hold it: the only posts with no thread entry, an action intent of their own.
   */
  async postWithoutItem(source: SourceRef, body: string, marker: string): Promise<void> {
    await this.request({ action: "post", target: source, args: { body, marker } });
  }

  /** Closes the item's source issue (a reject, a finished split) through outbound, which retries it until it lands. */
  async close(it: WorkItem, reason: string | null = null): Promise<void> {
    await this.request({ action: "close", target: it.source, work_item_id: it.id, args: { reason } });
  }

  /**
   * A comment on the item's PR, through the forge whatever source the item came from (issue #273): a thread entry
   * whose outbox row targets the forge's PR ref, so outbound posts it with `postPrComment`. With no PR, or
   * no forge, it goes to the item's own source.
   */
  async prComment(it: WorkItem, key: string, body: string): Promise<void> {
    const pr_number = prNumber(it);
    const pr = pr_number === null ? null : this.c.k.prRef(pr_number);
    if (pr === null) {
      await this.comment(it, key, body);
      return;
    }
    const marker = `<!-- factory:${key} -->`;
    await this.write({ work_item_id: it.id, marker, body, delivery: { source_type: pr.type, target: pr, link_field: null } });
  }

  /**
   * A pushback (a `/revise`, a `/reject`, a `changes` verdict) captured in the owner's ledger (issue #570), after its
   * command applied: one intent keyed by the item and the command's comment ID, so the same command delivered again
   * stores nothing more. The proposal is the item's latest finished run's summary. Outbound scans the text (G5) and
   * runs the ledger's CLI, retrying with backoff; the command never waits on it. No ledger: no intent. A failure to
   * record it is logged: the command it follows has applied.
   */
  async captureTacit(it: WorkItem, comment_id: string, pushback: string): Promise<void> {
    if (!this.c.k.d.tacit?.enabled) return;
    await this.c.k.guard("tacit", async () => {
      // Runs are listed oldest first.
      const last = (await this.c.k.reader.listRuns(it.id)).filter((r) => r.outcome?.status === "succeeded").at(-1)?.outcome;
      const proposal = last?.status === "succeeded" ? last.summary : "";
      await this.request({
        action: "tacit_capture", target: TACIT_LEDGER, work_item_id: it.id, args: { session: it.id, proposal, pushback }, key: `tacit:${it.id}:${comment_id}`,
      });
    });
  }

  /** 👀 on the event, through outbound. Best effort there: a failure is a warning and never blocks anything. */
  async markSeen(source: SourceRef, commentId: string | null): Promise<void> {
    // A CLI command has no comment on the source to react to: its mirror is the mirror step's.
    if (commentId !== null && isCliCommandKey(commentId)) return;
    await this.request({ action: "seen", target: source, args: { comment_id: commentId } });
  }

  /**
   * The item's status on its issue and, once it has one, on its PR. Best effort, each write on its own. An
   * adopted item's source is its PR, so it is labelled once. `current` says a target already shows the status.
   * Called after its transition commits, so the transition's comments (the spec) are stored first; one announce lists
   * thread entries before actions and outbound sends a destination's batches one at a time in intent order, so a
   * status is never posted before the spec of its transition is delivered (issue #586).
   */
  async showStatus(it: WorkItem, current: (pr_number: number | null) => boolean = () => false): Promise<void> {
    const status = statusOf(it);
    if (!current(null)) await this.setStatus(it.source, status, null);
    const pr = prNumber(it);
    if (pr !== null && it.origin !== "adopted" && !current(pr)) await this.setStatus(it.source, status, it.change_ref);
  }

  /**
   * Best effort in outbound, like markSeen. The item itself is labelled through its own source; a PR through the
   * forge, where PRs live (issue #273). With no forge, the PR call goes to the item's own source with its change_ref.
   */
  async setStatus(source: SourceRef, status: WorkStatus, change_ref: string | null): Promise<void> {
    const pr = change_ref === null ? null : prNumber({ change_ref });
    const ref = pr === null ? null : this.c.k.prRef(pr);
    if (ref !== null) {
      await this.request({ action: "status", target: ref, args: { status, change_ref, pr, item_source: JSON.stringify(source) } });
      return;
    }
    await this.request({ action: "status", target: source, args: { status, change_ref } });
  }

  /**
   * Writes one message to the item's thread, once per key (issue #282); outbound delivers it. Returns the
   * delivered comment's URL when an earlier write of the same key was already delivered, else null: `link` names
   * the item field the controller fills with the URL once outbound delivered it.
   */
  async comment(it: WorkItem, key: string, body: string, link: ThreadLinkField | null = null): Promise<string | null> {
    return this.post(it, it.source, body, `<!-- factory:${key} -->`, link);
  }

  /**
   * The thread write behind every factory message: a `threadEntry` write, committed by the kernel. Returns the URL
   * of an earlier write of the same marker that outbound already delivered (read first), else null.
   */
  async post(it: WorkItem, target: SourceRef, body: string, marker: string, link: ThreadLinkField | null = null): Promise<string | null> {
    const url = it.source.type === LOCAL_SOURCE ? null : deliveredUrl(await this.c.k.reader.listDeliveries(it.id), marker);
    await this.write(threadEntry(it, target, body, marker, link));
    return url;
  }

  /**
   * The outbox step (issue #282, RFC 0015 M7): every intent not announced yet becomes a DeliveryRequested, one per
   * destination, in one transaction with marking it requested. Outbound delivers it: claimed so one replica writes
   * it, retried with backoff, never touching the item's state.
   */
  async outboxStep(): Promise<void> {
    await this.c.k.guard("sync", () => this.c.unit("sync").syncStep());
    await this.c.k.announce();
  }

  /**
   * DeliveryCompleted: each delivered thread entry's URL is recorded on its item (its link field); a closed PR
   * clears its item's pending mark; a delivered PR goes on its item, which goes to review; a delivered update or
   * resolve push queues the review its run waited for; a delivered merge goes to the merge queue (RFC 0015 M8), a delivered PR merge to the pr-events unit, a
   * delivered base push to the local merge, a filed split phase to the phases unit, which records the next. A PR or
   * push outbound gave up (refused for good) stops its item's wait for a person's (`delivery_failed`).
   */
  async delivered(intent_ids: readonly string[]): Promise<void> {
    const writes: ControllerWrite[] = intent_ids.filter((id) => id.startsWith(THREAD_INTENT)).map((id) => ({ kind: "link_delivery", seq: Number(id.slice(THREAD_INTENT.length)) }));
    await this.c.k.commit({ writes });
    for (const a of await this.c.k.deliveredActions(intent_ids)) {
      if ((a.action === "pr" || a.action === "push") && a.outcome === "failed") {
        if (a.work_item_id) await this.c.unit("run-results").deliveryGaveUp(a.work_item_id as WorkItemId, a);
        continue;
      }
      if (a.action === "merge_pr") await this.c.unit("pr-events").prMergeDelivered(a);
      if (a.action === "close_pr" && a.work_item_id) await this.c.unit("closes").prClosed(a.work_item_id as WorkItemId);
      if (a.action === "push" && a.work_item_id && typeof a.args.run_id === "string") {
        await this.c.unit("run-results").pushDelivered(a.work_item_id as WorkItemId, a.args.run_id);
      }
      if (a.action === "pr" && a.work_item_id && a.delivered_ref) {
        await this.c.unit("run-results").prDelivered(a.work_item_id as WorkItemId, a.delivered_ref, a.delivered_url);
      }
      if (a.action === "merge") await this.c.unit("merge-queue").mergeDelivered(a);
      if (a.action === "push_base") await this.c.unit("local-merge").basePushDelivered(a);
      if (a.action === "file_sub_issue" && a.work_item_id) await this.c.unit("phases").advanceSplit(a.work_item_id as WorkItemId);
    }
  }

  private async write(entry: ThreadEntry): Promise<void> {
    await this.c.k.commit({ writes: [{ kind: "thread_entry", entry }] });
  }

  /** Stores one action intent; the outbox step announces it. A local item's surface is the store: nothing to write. */
  private async request(a: NewAction): Promise<void> {
    if (a.target.type === LOCAL_SOURCE) return;
    await this.c.k.commit({ writes: [{ kind: "intent", action: a }] });
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "outbox": OutboxUnit;
  }
}

export default controllerUnit({
  name: "outbox",
  create: (c: Ctx) => new OutboxUnit(c),
  steps: [
    { name: "status catch-up", every: "tick", order: 20, run: async (u) => { if (u.catchUpPending) await u.catchUpStatus(); } },
    { name: "outbox", every: "tick", order: 130, run: (u) => u.outboxStep() },
  ],
});
