// `/note <text>` and `factory task note <id> <text>` (design 04-gate-commands, 2026-11-23): the owner adds a note for
// the item's reviewer and implementer at any open stage. The commands unit hands a `note` row over here, as it has no
// comment event; the note is one state change that changes no stage, which the worker's "Notes from the approver"
// section reads (src/worker/runner.ts approverNotes, by this reason).

import type { UnitOperations } from "../../router/unit.js";
import type { Actor, WorkItem } from "../support.js";
import type { Ctx } from "../context.js";

/** The state change reason of an owner's `/note`; its detail holds `comment_id` and `note`. */
export const OWNER_NOTE = "owner_note";

/** The refusal of a `/note` with no text. */
export const NOTE_TEXT_REQUIRED = "`/note` needs text after it: `/note <text>`";

type Who = Parameters<UnitOperations["auth"]["authorize"]>[0];
/** The commands unit's refusal wording (core): a refused command as every surface says it, and the closed-item reason. */
export interface NoteSay { say: (command: string, reason: string) => string; closed: string }

/** A source comment's `/note`: on the work item of the issue it was written on; on any other issue, nothing. */
export async function noteOnSource(c: Ctx, source: WorkItem["source"], who: Who, comment_id: string, text: string, s: NoteSay): Promise<void> {
  const item = await c.k.reader.getWorkItemBySource(source.type, source.id);
  if (item) await noteCommand(c, item, who, comment_id, text, s);
}

/**
 * `/note` from the command inbox, keyed `comment_id`: 👀, the owner check, the egress scan and cap of the note (as an
 * `/approve` note's), then one `owner_note` state change with the owner as actor and an empty patch, so no stage,
 * block or run changes. Refused on a closed item, with no text, a flagged note or a non-owner: nothing is stored and
 * one reply, keyed on the comment, says why. A row read again stores nothing more.
 */
export async function noteCommand(c: Ctx, item: WorkItem, who: Who, comment_id: string, raw: string, s: NoteSay): Promise<void> {
  const principal = await c.unit("auth").authorize(who, "approve_spec", item.id);
  const refusal = "refuse" in principal ? principal.refuse : await storeNote(c, item, { kind: "user", id: principal.user_id }, comment_id, raw, s.closed);
  await c.unit("outbox").markSeen(item.source, comment_id);
  if (refusal === null) return;
  c.k.d.log.info("command refused", { work_item_id: item.id, command: "note", reason: refusal });
  await c.unit("outbox").post(item, item.source, s.say("/note", refusal), `<!-- factory:refused:${comment_id} -->`);
}

async function storeNote(c: Ctx, item: WorkItem, actor: Extract<Actor, { kind: "user" }>, comment_id: string, raw: string, closed: string): Promise<string | null> {
  if (item.stage === "CLOSED") return closed;
  const scanned = await c.unit("commands").approvalNote(item.id, raw, "/note");
  if ("refuse" in scanned) return scanned.refuse;
  const note = scanned.note;
  if (note === null) return NOTE_TEXT_REQUIRED;
  return c.unit("transitions").decide(item.id, async (it) => {
    if (it.stage === "CLOSED") return { refuse: closed };
    const done = (await c.k.reader.listStateChanges(it.id)).some((x) => x.reason === OWNER_NOTE && x.detail?.comment_id === comment_id);
    return done ? null : { patch: {}, actor, reason: OWNER_NOTE, detail: { comment_id, note } };
  });
}
