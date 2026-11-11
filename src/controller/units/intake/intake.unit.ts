// Takes a requested item in: authorize, create, status, edges, links.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { INTERPRET_MAX_CHARS, INTERPRET_MAX_ITEMS, interpret, interpretReply, interpretTexts, openItems } from "../../../core/interpret.js";
import { PHASE_MARKER } from "../../../core/split.js";
import type { SourceEvent } from "../../../interfaces/source-adapter.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** Takes a requested item in: authorize, create, status, edges, links. */
export class IntakeUnit {
  constructor(private readonly c: Ctx) {}

  /** A source asked for a work item: a phase of a split is the split's; anyone else is authorized, then taken in. */
  async itemRequested(e: Extract<SourceEvent, { kind: "item_requested" }>): Promise<void> {
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
   * A top-level chat message read before intake (design 05-sources, 04-gate-commands): true when it got a reply in
   * its own thread instead of an item (a chat answer, an offer to make it a task, or proposals for open items), false
   * when it is to be taken in as today. Taken in: a message already an item (a press, a redelivery), a requester
   * without `approve_spec` (no model call), an empty or long message, one the egress scan flags, no model, and a
   * `request`, failed or malformed answer, so no request is dropped silently. An answer the scan flags posts nothing
   * and stores nothing. The reply is keyed on the message's source id, so a redelivery posts no second one.
   */
  private async answered(e: Extract<SourceEvent, { kind: "item_requested" }>): Promise<boolean> {
    const llm = this.c.k.reader.llm;
    if (!llm || (await this.c.k.reader.getWorkItemBySource(e.source.type, e.source.id))) return false;
    if ("refuse" in (await this.c.unit("auth").authorize(e.requester, "approve_spec", e.source.id))) return false;
    const text = e.body.trim();
    const where = { source_id: e.source.id };
    const commands = this.c.unit("commands");
    if (text === "" || text.length > INTERPRET_MAX_CHARS || !(await commands.scanClean(where, "message", [text]))) return false;
    const items = openItems(await this.c.k.reader.listWorkItemsWhere({ exclude_closed: true, limit: INTERPRET_MAX_ITEMS }));
    const result = await interpret(text, items, llm, "top_level");
    const body = interpretReply(result);
    if (body === null) return false;
    if (!(await commands.scanClean(where, "answer", interpretTexts(result)))) return true;
    this.c.k.d.log.info("chat message answered", { ...where, kind: result.kind });
    await this.c.unit("outbox").postWithoutItem(e.source, body, `<!-- factory:chat-answer:${e.source.id} -->`);
    return true;
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
