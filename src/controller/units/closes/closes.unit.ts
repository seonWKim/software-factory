// Closes: a source closed by a person, rejects and PR closes still pending, then phases after each poll.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { prNumber } from "../../../core/change-ref.js";
import { type Actor, type CloseReason, type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { SourceEvent } from "../../../interfaces/source-adapter.js";
import { SYSTEM, SOURCE_CLOSE_PENDING, quote } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

type SourceClosedEvent = Extract<SourceEvent, { kind: "source_closed" }>;
/** Closes an item whose source was closed by someone the factory cannot name (design §4). */
const INTAKE: Actor = { kind: "system", id: "system:intake" };
/**
 * An item closed from its source whose open PR still needs its comment and its close: `CLOSED` with
 * `blocked_on: upstream` and this reason until both are done (design §4, source closed).
 */
const PR_CLOSE_PENDING = "pr_close_pending";
/** Rejected items finished per intake tick. */
const CLOSE_BATCH = 50;
/** An item closed from its source whose PR comment or PR close may not have happened yet. */
function prClosePending(it: WorkItem): boolean {
  return it.stage === "CLOSED" && it.blocked_on === "upstream" && it.blocked_reason === PR_CLOSE_PENDING;
}
/** A rejected item whose reject comment or source close may not have happened yet. */
function closePending(it: WorkItem): boolean {
  return it.stage === "CLOSED" && it.blocked_on === "upstream" && it.blocked_reason === SOURCE_CLOSE_PENDING;
}

/** Closes: a source closed by a person, rejects and PR closes still pending, then phases after each poll. */
export class ClosesUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * After a poll, with a poll source or a forge configured: unfinished rejects and source closes, then phases. The
   * closes and phases write to the synced type's source too, so the sync holder finishes them.
   */
  async afterPoll(): Promise<void> {
    if (!this.c.k.forge && !this.c.k.sources.some((s) => s.intake === "poll")) return;
    if (this.c.unit("sync").syncedElsewhere()) return;
    await this.c.k.guard("source closes", () => this.tickSourceCloses());
    // Phases are sub-issues on their source, so their holds and parents move once per poll, after its closes are applied.
    await this.c.k.guard("phases", () => this.c.unit("phases").tickPhases());
  }

  /**
   * Finishes rejects whose comment or close did not happen (the factory stopped, or the source failed):
   * every rejected item still marked `source_close_pending` gets them now. Likewise every item closed from
   * its source still marked `pr_close_pending` gets its PR comment and PR close. Safe to repeat: comments
   * carry a marker and are posted once; closing a closed issue or PR changes nothing.
   */
  async tickSourceCloses(): Promise<void> {
    const pending = await this.c.k.d.store.listWorkItemsWhere({ stage: "CLOSED", blocked_on: "upstream", limit: CLOSE_BATCH });
    for (const it of pending) {
      if (closePending(it)) await this.c.k.guard("source close", () => this.finishReject(it.id));
      if (prClosePending(it)) await this.c.k.guard("pr close", () => this.finishPrClose(it.id));
    }
  }

  /**
   * The source issue was closed (design §4). The item closes as `completed` when the source says it was
   * closed as completed, else as `wont_do`; in the same transition its queued runs are cancelled and its
   * running runs are stopped (their next heartbeat, completion and tool calls get lease_lost, so nothing is
   * pushed and no outcome is stored). Store first: an item already CLOSED (by /reject, a merge, or an
   * earlier delivery of this close) is left alone, so a repeat or the factory's own close writes nothing. No
   * login is checked. An item with a PR is marked `pr_close_pending` in the same transition; the PR is then
   * closed with a comment (finishPrClose), retried on later ticks if that fails.
   */
  async closeFromSource(e: SourceClosedEvent): Promise<void> {
    const item = await this.c.k.d.store.getWorkItemBySource(e.source.type, e.source.id);
    if (!item) return;
    if (item.stage !== "CLOSED") {
      const closer = e.closer ? await this.c.k.d.auth.resolve(e.closer) : null;
      if (!closer) {
        this.c.k.d.log.warn("source closed by an unknown user; recorded as the system actor", { work_item_id: item.id, source_id: e.source.id });
      }
      const actor: Actor = closer ? { kind: "user", id: closer.user_id } : INTAKE;
      const close_reason: CloseReason = e.state_reason === "completed" ? "completed" : "wont_do";
      await this.c.unit("transitions").decide(item.id, (it) => {
        if (it.stage === "CLOSED") return null;
        const closesPr = it.change_ref !== null && this.c.k.forge !== null;
        return {
          patch: {
            stage: "CLOSED",
            close_reason,
            blocked_on: closesPr ? "upstream" : "none",
            blocked_reason: closesPr ? PR_CLOSE_PENDING : null,
          },
          actor,
          reason: "source_closed",
          cancel_queued_runs: true,
          cancel_running_runs: true,
        };
      });
    }
    await this.finishPrClose(item.id);
  }

  /**
   * The rest of a source close for an item with a PR (RFC 0015 M7): one `close_pr` intent, keyed on the item, which
   * outbound delivers as one comment on the PR naming who closed the issue, then the PR closed without a merge (a
   * PR already merged or closed is left alone). The pending mark is cleared when outbound reports it delivered
   * (`prClosed`); until then each tick records it again, which stores nothing.
   */
  async finishPrClose(id: WorkItemId): Promise<void> {
    const it = await this.c.k.d.store.getWorkItem(id);
    const pr = it ? prNumber(it) : null;
    if (!it || !prClosePending(it) || pr === null) return;
    const forge = this.c.k.forge;
    if (!forge) return;
    await this.c.k.recordAction({
      action: "close_pr",
      target: forge.prRef(pr),
      work_item_id: it.id,
      key: `close_pr:${it.id}`,
      args: {
        pr,
        closed: JSON.stringify(it.source),
        marker: `<!-- factory:pr-closed:${it.id} -->`,
        body: "Closed because the issue was closed.",
        body_by: "Closed because the issue was closed by {closer}.",
      },
    });
  }

  /** Outbound closed the item's PR: the pending mark is cleared. */
  async prClosed(id: WorkItemId): Promise<void> {
    await this.c.unit("transitions").decide(id, (cur) =>
      prClosePending(cur) ? { patch: { blocked_on: "none", blocked_reason: null }, actor: SYSTEM, reason: "pr_closed_for_source" } : null,
    );
  }

  /**
   * The rest of a reject: one comment quoting the reason, then the source issue closed as not planned,
   * then the pending mark cleared. Each step is idempotent, so a repeat after a stop does no harm.
   */
  async finishReject(id: WorkItemId): Promise<void> {
    const it = await this.c.k.d.store.getWorkItem(id);
    if (!it || !closePending(it)) return;
    // No adapter for the item's source: it stays pending (its state is kept) until one is configured.
    if (!this.c.k.adapterFor(it.source, "closeIssue")) return;
    const budget = (await this.c.k.d.store.listStateChanges(id)).filter((c) => c.reason === "spec_rejected" || c.reason === "budget_rejected").at(-1)
      ?.reason === "budget_rejected";
    const reason = budget ? "" : (it.spec_feedback?.trim() ?? "");
    const body = budget
      ? "Closed because the work was stopped at its token budget checkpoint (`/reject`). The factory closed this issue as not planned."
      : reason
        ? ["Closed because the spec was rejected. The factory closed this issue as not planned. The reason given:", "", quote(reason)].join("\n")
        : "Closed because the spec was rejected (no reason given). The factory closed this issue as not planned.";
    await this.c.unit("outbox").comment(it, `rejected:${it.id}`, body);
    await this.c.unit("outbox").close(it);
    await this.c.unit("transitions").decide(id, (cur) =>
      closePending(cur)
        ? { patch: { blocked_on: "none", blocked_reason: null }, actor: SYSTEM, reason: "source_closed" }
        : null,
    );
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "closes": ClosesUnit;
  }
}

export default controllerUnit({
  name: "closes",
  create: (c: Ctx) => new ClosesUnit(c),
  events: {
    source_closed: (u, e) => u.closeFromSource(e),
  },
  steps: [
    { name: "after poll", every: "poll", order: 30, run: (u) => u.afterPoll() },
  ],
});
