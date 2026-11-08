// What the controller asks outbound to write (RFC 0015 M7): thread entries, status labels, 👀 reactions, issue closes
// and posts on sources with no work item are stored as intents, and the outbox step announces them as
// DeliveryRequested; outbound batches and delivers them, and DeliveryCompleted comes back to `delivered`.
// Moved out of the legacy controller (RFC 0015 M5); its store reads are still inline (unit-purity ratchet).

import { prNumber } from "../../../core/change-ref.js";
import { LOCAL_SOURCE, threadDelivery } from "../../../core/local-merge.js";
import { isCliCommandKey } from "../../../core/local-cli.js";
import { type WorkStatus, statusOf } from "../../../core/status-label.js";
import { type SourceRef, type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { ThreadLinkField } from "../../../interfaces/factory-store.js";
import { labelTarget } from "../../../interfaces/factory-store.js";
import { THREAD_INTENT, type NewAction } from "../../../outbound/index.js";
import type { Ctx } from "../context.js";
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
    const items = await this.c.k.d.store.listWorkItems(CATCH_UP_LIMIT);
    if (items.length >= CATCH_UP_LIMIT) {
      this.c.k.d.log.warn("status catch-up hit its limit", { limit: CATCH_UP_LIMIT });
    }
    const open = items.filter((it) => it.stage !== "CLOSED");
    // One batched read of the stored label states: a target already showing its status costs no call at all.
    const stored = await this.c.k.d.store.listLabelStates(open.map((it) => it.source.id));
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
    if (pr_number === null || !this.c.k.forge) {
      await this.comment(it, key, body);
      return;
    }
    const pr = this.c.k.forge.prRef(pr_number);
    const marker = `<!-- factory:${key} -->`;
    await this.c.k.d.store.recordItemMessage({ work_item_id: it.id, marker, body, delivery: { source_type: pr.type, target: pr, link_field: null } });
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
    const forge = this.c.k.forge;
    if (pr !== null && forge) {
      await this.request({ action: "status", target: forge.prRef(pr), args: { status, change_ref, pr, item_source: JSON.stringify(source) } });
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
   * The thread write behind every factory message: the entry, and in the same transaction its outbox row unless
   * the thread is the item's own surface (a local item). An entry goes only to its item's own source: `target`
   * (e.g. the item's PR) is used when it is of that source's type, else the item's source.
   */
  async post(it: WorkItem, target: SourceRef, body: string, marker: string, link: ThreadLinkField | null = null): Promise<string | null> {
    const delivery = threadDelivery(it, target, link);
    const { created, message } = await this.c.k.d.store.recordItemMessage({ work_item_id: it.id, marker, body, delivery });
    if (created || delivery === null) return null;
    const row = (await this.c.k.d.store.listDeliveries(it.id)).find((d) => d.thread_seq === message.seq);
    return row?.url ?? null;
  }

  /**
   * The outbox step (issue #282, RFC 0015 M7): every intent not announced yet becomes a DeliveryRequested, one per
   * destination, in one transaction with marking it requested. Outbound delivers it: claimed so one replica writes
   * it, retried with backoff, never touching the item's state. Then the base pushes (until outbound's `local`
   * handler takes them, M7's second half).
   */
  async outboxStep(): Promise<void> {
    await this.c.k.guard("sync", () => this.c.unit("sync").syncStep());
    await this.c.k.announce();
    await this.c.k.guard("base pushes", () => this.c.unit("local-merge").basePushStep());
  }

  /**
   * DeliveryCompleted: each delivered thread entry's URL is recorded on its item (its link field); a closed PR
   * clears its item's pending mark.
   */
  async delivered(intent_ids: readonly string[]): Promise<void> {
    for (const id of intent_ids) {
      if (id.startsWith(THREAD_INTENT)) await this.c.k.d.store.linkDelivery(Number(id.slice(THREAD_INTENT.length)));
    }
    for (const a of await this.c.k.deliveredActions(intent_ids)) {
      if (a.action === "close_pr" && a.work_item_id) await this.c.unit("closes").prClosed(a.work_item_id as WorkItemId);
    }
  }

  /** Stores one action intent; the outbox step announces it. A local item's surface is the store: nothing to write. */
  private async request(a: NewAction): Promise<void> {
    if (a.target.type === LOCAL_SOURCE) return;
    await this.c.k.recordAction(a);
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
