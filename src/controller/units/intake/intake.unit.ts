// Takes a requested item in: authorize, create, status, edges, links.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { PHASE_MARKER } from "../../../core/split.js";
import type { SourceEvent } from "../../../interfaces/source-adapter.js";
import { scanClean } from "../commands/scan.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

type ItemRequested = Extract<SourceEvent, { kind: "item_requested" }>;

/** The reply to an empty top-level mention: nothing to offer as a task. */
const EMPTY_TEXT = "I couldn't read that.";
/** The reply to a top-level mention the egress scan flags: quotes nothing from it, and offers nothing. */
const FLAGGED_TEXT = "I can't use that message: it looks like it holds a secret. Remove it and mention me again.";

/**
 * The reply to a top-level mention not read (no model, no `approve_spec`, too long, a `none` answer): the line, then
 * the offer's hidden marker, from which Slack draws the "Make this a task" button. The marker is written as
 * `taskOfferMarker` in core/interpret.ts writes it; a unit may not import core (tests/architecture), and
 * tests/chat-intake.test.ts reads the button's value back from it.
 */
const unreadOffer = (text: string) => `I couldn't read that. Make it a task?\n<!-- factory:make-task:${Buffer.from(text, "utf8").toString("base64url")} -->`;

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
    if (e.classify && (await this.answered(e))) return;
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
      if (e.offered) await this.c.unit("outbox").postWithoutItem(e.source, `Task created: ${e.title}`, `<!-- factory:task-created:${e.source.id} -->`);
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
   * A top-level chat message (design 05-sources, 04-gate-commands): answered in its own thread, never taken in by
   * itself; only a press of the offer (`offered`) makes it an item. True when it was answered; false only when it is
   * already an item (a redelivery after a press), which intake handles as before. An empty message gets one line; a
   * message the egress scan flags gets one fixed line that quotes nothing and offers nothing, before any model call,
   * so the offer's marker, which carries the message, never holds a flagged text. A requester without `approve_spec`,
   * no model, a long message or no usable answer (`none`) get the unread line and the offer, with no model call where
   * there is no model or no right. A model answer the scan flags posts nothing. Every reply is keyed on the message's
   * source id, so a redelivery posts no second one.
   */
  private async answered(e: ItemRequested): Promise<boolean> {
    if (await this.c.k.reader.getWorkItemBySource(e.source.type, e.source.id)) return false;
    const body = await this.answer(e);
    if (body !== null) await this.c.unit("outbox").postWithoutItem(e.source, body, `<!-- factory:chat-answer:${e.source.id} -->`);
    return true;
  }

  /** The reply to a top-level chat message, or null when the model's answer failed the egress scan. */
  private async answer(e: ItemRequested): Promise<string | null> {
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
    return read.body;
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
