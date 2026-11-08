// The thread outbox (until M7 moves it to outbound): replies, marks, status labels, and their delivery.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { prNumber } from "../../../core/change-ref.js";
import { retryDelayMs } from "../../../core/policy.js";
import { LOCAL_SOURCE } from "../../../core/local-merge.js";
import { isCliCommandKey } from "../../../core/local-cli.js";
import { type WorkStatus, statusOf } from "../../../core/status-label.js";
import { type SourceRef, type WorkItem } from "../../../core/types.js";
import type { ThreadDelivery, ThreadLinkField } from "../../../interfaces/factory-store.js";
import { labelTarget } from "../../../interfaces/factory-store.js";
import { GITHUB_SOURCE_TYPE } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** Items the start-up status catch-up reads (newest first). Past this, a warning; the rest stay as they are. */
const CATCH_UP_LIMIT = 1000;
/** Outbox rows delivered per tick at most (issue #282). */
const OUTBOX_BATCH = 50;

/** The thread outbox (until M7 moves it to outbound): replies, marks, status labels, and their delivery. */
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
   * hold it: the only posts that skip the outbox and go to the source directly.
   */
  async postWithoutItem(source: SourceRef, body: string, marker: string): Promise<void> {
    await this.c.k.adapterFor(source, "postComment")?.postComment(source, body, marker);
  }

  /**
   * A comment on the item's PR, through the forge whatever source the item came from (issue #273): a thread entry
   * whose outbox row targets the forge's PR ref, so the outbox step posts it with `postPrComment`. With no PR, or
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

  /** 👀 on the event. Best effort: a failure is a warning and never blocks the transition or the loop. */
  async markSeen(source: SourceRef, commentId: string | null): Promise<void> {
    // A CLI command has no comment on the source to react to: its mirror is the mirror step's.
    if (commentId !== null && isCliCommandKey(commentId)) return;
    try {
      await this.c.k.adapterFor(source, "markSeen")?.markSeen(source, commentId);
    } catch (err) {
      this.c.k.d.log.warn("mark seen failed", {
        source_id: source.id,
        comment_id: commentId,
        error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
      });
    }
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
   * Best effort, like markSeen: a failure is a warning and never changes a transition's outcome. The item
   * itself is labelled through its own source; a PR through the forge, where PRs live (issue #273). With no
   * forge (converted with prNumber), the PR call goes to the item's own source with its change_ref.
   */
  async setStatus(source: SourceRef, status: WorkStatus, change_ref: string | null): Promise<void> {
    try {
      const pr = change_ref === null ? null : prNumber({ change_ref });
      if (pr !== null && this.c.k.forge) await this.c.k.forge.setPrStatus(source, status, pr);
      else await this.c.k.adapterFor(source, "setStatus")?.setStatus(source, status, change_ref);
    } catch (err) {
      this.c.k.d.log.warn("set status failed", {
        source_id: source.id,
        status,
        pr_number: change_ref === null ? null : prNumber({ change_ref }),
        error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
      });
    }
  }

  /**
   * Writes one message to the item's thread, once per key (issue #282); the outbox step delivers it. Returns the
   * delivered comment's URL when an earlier write of the same key was already delivered, else null: `link` names
   * the item field the outbox fills with the URL once it delivers.
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
    const type = it.source.type;
    const delivery = type === LOCAL_SOURCE ? null : { source_type: type, target: target.type === type ? target : it.source, link_field: link };
    const { created, message } = await this.c.k.d.store.recordItemMessage({ work_item_id: it.id, marker, body, delivery });
    if (created || delivery === null) return null;
    const row = (await this.c.k.d.store.listDeliveries(it.id)).find((d) => d.thread_seq === message.seq);
    return row?.url ?? null;
  }

  /**
   * The outbox (issue #282): each pending thread entry of a source type this process has an adapter for, claimed
   * so one replica posts it, delivered through that adapter, then marked delivered; an entry whose target is one
   * of the forge's PR refs goes through the forge (issue #273). A failure is retried with backoff (retry_base_ms
   * doubling up to retry_max_ms); it never touches the item's state. Entries this process cannot deliver stay
   * pending for a process that can.
   */
  async outboxStep(): Promise<void> {
    await this.c.k.guard("sync", () => this.c.unit("sync").syncStep());
    const types = new Set(this.c.k.byType.keys());
    if (this.c.k.forge) types.add(this.c.k.forge.ref_type);
    // The synced type's rows are the sync holder's to deliver (design 05-coordination), whatever the budget.
    if (this.c.unit("sync").syncedElsewhere()) types.delete(GITHUB_SOURCE_TYPE);
    for (const row of await this.c.k.d.store.listPendingDeliveries([...types], OUTBOX_BATCH)) {
      await this.c.k.guard("outbox delivery", () => this.deliver(row));
    }
    await this.c.k.guard("base pushes", () => this.c.unit("local-merge").basePushStep());
  }

  /** How `row` is posted here: through the forge for one of its PR refs, else the adapter of its source type. */
  poster(row: ThreadDelivery): ((body: string, marker: string) => Promise<{ url: string | null }>) | null {
    const forge = this.c.k.forge;
    const pr = forge?.prNumberOf(row.target) ?? null;
    if (forge && pr !== null) return (body, marker) => forge.postPrComment(pr, body, marker);
    const adapter = this.c.k.byType.get(row.source_type);
    return adapter ? (body, marker) => adapter.postComment(row.target, body, marker) : null;
  }

  async deliver(row: ThreadDelivery): Promise<void> {
    const post = this.poster(row);
    if (!post) return;
    // Fenced: a replica whose sync lease was taken over claims nothing, so no comment goes out twice.
    if (row.source_type === GITHUB_SOURCE_TYPE && this.c.unit("sync").syncedElsewhere()) return;
    const fence = this.c.unit("sync").fenceFor(row.source_type);
    const token = await this.c.k.d.store.claimDelivery(row.seq, this.c.k.cfg.lease_ms, ...(fence ? [fence] : []));
    if (token === null) {
      if (fence) await this.c.unit("sync").fenceRefused(fence);
      return;
    }
    // A marker the store has a posted record of is delivered with its URL and no call; a changed body is not
    // edited, only logged.
    const stored = await this.c.k.d.store.getPostedComment(row.target.id, row.marker, row.body);
    if (stored?.comment_id) {
      if (!stored.same_body) this.c.k.d.log.warn("comment already posted with another body; not edited", { source_id: row.target.id, marker: row.marker });
      await this.c.k.d.store.finishDelivery(row.seq, token, stored.url);
      return;
    }
    let url: string | null;
    try {
      url = (await post(row.body, row.marker)).url;
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 300) : "unknown";
      const delay = retryDelayMs(row.attempts + 1, this.c.k.cfg.retry_base_ms, this.c.k.cfg.retry_max_ms);
      this.c.k.d.log.warn("outbox delivery failed; retried later", { work_item_id: row.work_item_id, outbox_seq: row.seq, attempts: row.attempts + 1, retry_in_ms: delay, error });
      await this.c.k.d.store.failDelivery(row.seq, token, error, delay);
      return;
    }
    await this.c.k.d.store.finishDelivery(row.seq, token, url);
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
