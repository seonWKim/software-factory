// Takes a requested item in: authorize, create, status, edges, links.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { PHASE_MARKER } from "../../../core/split.js";
import { type SourceEvent, taskOfferMarker } from "../../../interfaces/source-adapter.js";
import { scanClean } from "../commands/scan.js";
import { SYSTEM } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

type ItemRequested = Extract<SourceEvent, { kind: "item_requested" }>;
type NewItem = Parameters<Ctx["k"]["d"]["store"]["createWorkItem"]>[0];

/** The reply to an empty top-level mention: nothing to offer as a task. */
const EMPTY_TEXT = "I couldn't read that.";
/** The reply to a top-level mention the egress scan flags: quotes nothing from it, and offers nothing. */
const FLAGGED_TEXT = "I can't use that message: it looks like it holds a secret. Remove it and mention me again.";

/**
 * The reply to a top-level mention not read (no model, no `approve_spec`, too long, a `none` answer): the line, then
 * the offer's hidden marker, from which Slack draws the "Make this a task" button.
 */
const unreadOffer = (text: string) => `I couldn't read that. Make it a task?\n${taskOfferMarker(text)}`;

/** Takes a requested item in: authorize, create, status, edges, links. */
export class IntakeUnit {
  constructor(private readonly c: Ctx) {}

  /** A source asked for a work item: a phase of a split is the split's; anyone else is authorized, then taken in. */
  async itemRequested(e: ItemRequested): Promise<void> {
    // A phase of a split spec: the split that filed it takes it in (held or not), never intake.
    if (PHASE_MARKER.test(e.body)) return;
    const principal = await this.c.unit("auth").authorize(e.requester, "submit_work", e.source.id);
    if ("refuse" in principal) {
      // A source whose intake label is the gate refuses silently. A chat source has no label: the
      // person who asked gets one reply in the thread, keyed on it, so they know why (issue #109).
      if (!this.c.k.byType.get(e.source.type)?.silent_intake_refusal) {
        await this.c.unit("outbox").postWithoutItem(e.source, `This thread was not taken in as a work item: ${principal.refuse}.`, `<!-- factory:refused-intake:${e.source.id} -->`);
      }
      return;
    }
    // A top-level chat message: answered in its thread, unless the model read it as a work request, made here.
    const read = e.classify ? await this.answered(e) : "item";
    if (read === "answered") return;
    const { item, created } = await this.c.k.d.store.createWorkItem(
      {
        source: e.source,
        title: e.title,
        requester_id: principal.user_id,
        project: this.c.k.project(),
        problem: `${e.title}\n\n${e.body}`.trim(),
        resources: [e.source.link],
      },
      { kind: "user", id: principal.user_id },
      { enqueue: { kind: "triage", idempotency_key: `${e.source.type}:${e.source.id}:triage` } },
    );
    if (created) {
      this.c.k.d.log.info("intake", { work_item_id: item.id });
      // A press of "Make this a task" (design 04-gate-commands): one line before the item's status and spec.
      // A top-level message read as a work request (design 04-chat-commands): one line naming the item by ID and title.
      const line = e.offered ? `Task created: ${e.title}` : read === "request" ? `Task created: \`${item.id}\` ${e.title}` : null;
      if (line !== null) await this.c.unit("outbox").postWithoutItem(e.source, line, `<!-- factory:task-created:${e.source.id} -->`);
      await this.c.unit("outbox").setStatus(item.source, "triaging", null);
      // Edges first, so a claim holds the implement run even before the next coordination tick.
      await this.c.k.guard("dependencies", async () => void (await this.c.unit("coordination").refreshEdges(item, this.c.unit("coordination").issueTime(e.updated_at))));
    } else if (item.stage !== "CLOSED" && item.change_ref === null) {
      // An edited issue (issue #254): its links are read again only when it changed since they were read.
      await this.c.k.guard("dependencies", () => this.c.unit("coordination").relinkIfChanged(item, e.updated_at));
    }
    await this.c.unit("outbox").markSeen(e.source, null);
    // Every delivery re-checks the link, so a re-polled issue finishes a link a crash interrupted.
    await this.c.unit("verdicts").linkFixForward(item.id, `${e.title}\n${e.body}`);
  }

  /**
   * A base push that conflicts with origin's `base_ref` at `remote` (design 05-sources, Base reconcile): one local
   * reconcile item, keyed on that sha by its source id, so a second conflict on it files nothing. It skips triage and
   * spec approval: it starts at its resolve run, keyed on the item and the sha. Safe to run twice: the source id makes
   * one item, and only an item still at NEW with no hold moves, so a crash between the two finishes on the replay.
   */
  async fileReconcile(base_ref: string, remote: string, conflicts: readonly string[], source_id: string): Promise<void> {
    const short = remote.slice(0, 12);
    const { item, created } = await this.c.k.d.store.createWorkItem({
      source: { type: "local", id: source_id, link: "" },
      title: `Reconcile local ${base_ref} with origin/${base_ref} at ${short}`,
      requester_id: SYSTEM.id as NewItem["requester_id"],
      project: this.c.k.project(),
      problem: [
        `The push of local \`${base_ref}\` to origin conflicts with origin/\`${base_ref}\` at \`${remote}\`${conflicts.length > 0 ? ` in ${conflicts.map((f) => `\`${f}\``).join(", ")}` : ""}.`,
        `A resolve run merges origin/${base_ref} as fetched into this item's branch, made from local \`${base_ref}\`, resolves the conflicts and runs the checks; a green result lands through the merge queue, and the base push follows.`,
      ].join("\n\n"),
      resources: [],
    }, SYSTEM);
    if (created) this.c.k.d.log.info("base reconcile filed", { work_item_id: item.id, base_ref, remote });
    await this.c.unit("transitions").decide(item.id, (it) => (it.stage === "NEW" && it.blocked_on === "none"
      ? {
          patch: { stage: "RUNNING" }, actor: SYSTEM, reason: "auto_resolve_started", detail: { cause: "base_reconcile", base_ref, remote },
          enqueue: { kind: "resolve", idempotency_key: `${item.id}:reconcile:${remote}`, input: { notes: "" } },
        }
      : null));
  }

  /**
   * A top-level chat message (design 05-sources, 04-chat-commands): answered in its own thread, or, when the model
   * reads it as one work request, made an item at once (`request`) with the same create a press of the offer
   * (`offered`) makes. `item` when it is already an item (a redelivery), which intake handles as before, so a
   * redelivery makes no model call, no second item and no second reply. An empty message gets one line; a message the
   * egress scan flags gets one fixed line that quotes nothing and offers nothing, before any model call, so the offer's
   * marker, which carries the message, never holds a flagged text. A requester without `approve_spec`, no model, a long
   * message or no usable answer (`none`) get the unread line and the offer, with no model call where there is no model
   * or no right. A chat or unsure answer is posted as it reads. A model answer the scan flags posts nothing. Every
   * reply is keyed on the message's source id, so a redelivery posts no second one.
   */
  private async answered(e: ItemRequested): Promise<"answered" | "request" | "item"> {
    if (await this.c.k.reader.getWorkItemBySource(e.source.type, e.source.id)) return "item";
    const body = await this.answer(e);
    if (body === "request") return "request";
    if (body !== null) await this.c.unit("outbox").postWithoutItem(e.source, body, `<!-- factory:chat-answer:${e.source.id} -->`);
    return "answered";
  }

  /** The reply to a top-level chat message, `request` for a work request, or null when the model's answer failed the egress scan. */
  private async answer(e: ItemRequested): Promise<string | "request" | null> {
    const where = { source_id: e.source.id };
    const text = e.body.trim();
    if (text === "") return EMPTY_TEXT;
    if (!(await scanClean(this.c, where, "message", [text]))) return FLAGGED_TEXT;
    if ("refuse" in (await this.c.unit("auth").authorize(e.requester, "approve_spec", e.source.id))) return unreadOffer(text);
    // No model or a message too long: `unread`, with no model call. A `none` answer: no reply of its own.
    const read = await this.c.unit("commands").readMessage(text, where, null);
    if (read === "blocked") return null;
    if (read === "unread" || read.body === null) return unreadOffer(text);
    this.c.k.d.log.info("chat message answered", { ...where, kind: read.kind });
    return read.kind === "request" ? "request" : read.body;
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "intake": IntakeUnit;
  }
}

export default controllerUnit({
  name: "intake",
  create: (c: Ctx) => new IntakeUnit(c),
  events: {
    item_requested: (u, e) => u.itemRequested(e),
  },
});
