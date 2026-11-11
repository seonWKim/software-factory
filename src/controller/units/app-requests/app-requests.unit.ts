// Applies the status page's requests (the gate commands approve, reject, revise, retry and resolve, verdict, merge,
// a sentence for the plain-words reader, and a stored proposal's Confirm all and Cancel; anything else is refused). Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { CANCEL_APP_COMMAND, SENTENCE_APP_COMMAND } from "../../../core/command-table.js";
import { COMMANDS, commandFooter, refusalText } from "../../../core/commands.js";
import { CONFIRM_COMMAND, INTERPRET_MAX_CHARS } from "../../../core/interpret.js";
import { localIdentity } from "../../../core/local-cli.js";
import { LOCAL_SOURCE, MERGE_COMMAND } from "../../../core/local-merge.js";
import { type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { AppCommandRequest } from "../../../interfaces/factory-store.js";
import { type CommandEvent, COMMAND, QUOTABLE_COMMAND } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";
import { cancelProposal } from "../commands/proposals.js";

/** The state change detail key that names the app request a transition applied, so a second apply finds it. */
const APP_REQUEST = "app_request";
/** The app's gate commands, as the comment command each one is (design §4, app requests). */
const GATE: ReadonlyMap<string, Exclude<CommandEvent["kind"], "budget_continue">> = new Map([
  ["approve", "spec_approved"], ["reject", "spec_rejected"], ["revise", "revise_requested"], ["retry", "retry_requested"], ["resolve", "resolve_requested"],
]);
/** The commands applied from an app request, as a refusal names them. */
const APPLIED = "only `approve`, `merge`, `reject`, `resolve`, `retry`, `revise` and `verdict` are applied from an app request";

/** The page's edge passport, checked for expiry at the time the request was recorded (absent: none). */
function appPassport(r: AppCommandRequest) {
  return r.passport_id === undefined ? undefined : { id: r.passport_id, at: r.created_at };
}

/**
 * The comment command event of an app gate command on `item`, keyed `key`: the note is the approve's or retry's
 * note, the resolve's notes, the reject's reason or the revise's feedback. Never on a PR: a revise here is the
 * issue's `/revise`, and no `+paths` is read.
 */
function gateEvent(kind: Exclude<CommandEvent["kind"], "budget_continue">, item: WorkItem, key: string, r: AppCommandRequest, note: string): CommandEvent {
  const who = { provider: "local" as const, subject: r.actor };
  const at = { source: item.source, comment_id: key };
  switch (kind) {
    case "spec_approved": return { kind, ...at, approver: who, note };
    case "spec_rejected": return { kind, ...at, approver: who, reason: note };
    case "revise_requested": return { kind, ...at, requester: who, feedback: note, pr: null };
    case "retry_requested": return { kind, ...at, requester: who, note };
    case "resolve_requested": return { kind, ...at, requester: who, notes: note, pr: null };
  }
}

/** Applies the status page's requests (gate commands, verdict, merge, a sentence, a proposal's confirm or cancel; anything else is refused). */
export class AppRequestsUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * One app command request (design §4, app requests): `approve`, `reject`, `revise`, `retry` and `resolve` go through
   * the comment command path (CommandsUnit.gateCommand) with the request's user and edge passport: the same
   * `approve_spec` check, note scan, transition, standing-rule follow-up and reject close as the comment. `verdict` gets
   * the `/verdict` check, parser and store, keyed `app-<seq>`; `merge` on a local item with no PR goes to mergeLocal,
   * the same local merge as `factory merge`, and on any item with a PR to the PR merge (design §9, the Merge button).
   * Each puts the request's seq on the state change (a verdict on its key). A sentence (`sentence`, the command box)
   * goes through the plain-words reader as a plain reply on the item would (`sentence`); a stored proposal's Confirm all
   * (`proposal_confirm`) through the confirm path a `factory confirm` takes, as the request's user; its Cancel
   * (`proposal_cancel`) marks the pending rows cancelled. Any other command is refused. A refusal
   * is posted once on the item's source, keyed on the request, then stored on the row by the conditional mark. A
   * failed post leaves the request pending for the next tick. Safe to run twice: a request whose transition is
   * already stored (an earlier try, another replica) is marked applied.
   */
  async applyAppRequest(r: AppCommandRequest): Promise<void> {
    const known = COMMANDS.some((c) => c.name === r.command);
    const gate = GATE.get(r.command);
    const name = gate ? COMMAND[gate] : r.command === "verdict" ? "/verdict" : QUOTABLE_COMMAND.test(r.command) ? r.command : null;
    const say = (reason: string) => (name ? refusalText(name, reason) : `The command was not applied: ${reason}.`);
    const raw = r.args.work_item_id;
    const id = typeof raw === "string" && raw !== "" ? (raw as WorkItemId) : null;
    const item = id ? await this.c.k.reader.getWorkItem(id) : null;
    if (!item) return this.finishAppRequest(r, null, say(id ? "the work item was not found" : "the request names no work item"));
    const key = `app-${r.seq}`;
    const applied = async () =>
      (await this.c.k.reader.listStateChanges(item.id)).some((c) => c.detail?.[APP_REQUEST] === r.seq) ||
      (r.command === "verdict" && (await this.c.k.reader.listVerdicts(item.id)).some((v) => v.comment_id === key));
    if (await applied()) return this.finishAppRequest(r, item, null);

    const note = typeof r.args.note === "string" ? r.args.note : undefined;
    let refusal: string | null;
    if (r.command === MERGE_COMMAND) {
      // A local item with no PR takes the local merge; an item with a PR (a local item from the PR era too) its
      // PR's merge on the forge (design 05-sources). mergeLocal posts its own refusal under the same marker as
      // finishAppRequest's, so the thread gets it once; a PR merge's later refusal comes back under it too.
      const who = { user_id: r.actor, passport: appPassport(r) };
      refusal = item.source.type === LOCAL_SOURCE && item.change_ref === null
        ? await this.c.unit("local-merge").mergeLocal(item.id, who, key, { [APP_REQUEST]: r.seq })
        : await this.c.unit("pr-events").requestPrMerge(item.id, who, key, { [APP_REQUEST]: r.seq });
    } else if (r.command === "verdict") {
      const principal = await this.c.unit("auth").allowed({ user_id: r.actor, attributes: {} }, "record_verdict", item.id, true, appPassport(r));
      refusal = "refuse" in principal ? principal.refuse : await this.c.unit("verdicts").verdictFrom(item.id, { comment_id: key, target: "issue" }, principal, note ?? "");
    } else if (r.command === SENTENCE_APP_COMMAND) {
      refusal = await this.sentence(r, item, key, note ?? "");
    } else if (r.command === CONFIRM_COMMAND || r.command === CANCEL_APP_COMMAND) {
      refusal = await this.proposalRequest(r, item, key);
    } else if (gate) {
      refusal = await this.gateRequest(r, item, gate, key, note);
    } else {
      refusal = APPLIED + (known ? `; reply \`/${r.command}\` on the issue instead` : "");
    }
    // Refused here, but applied by a concurrent try of the same request: that one stands.
    if (refusal !== null && (await applied())) refusal = null;
    await this.finishAppRequest(r, item, refusal === null ? null : say(refusal));
  }

  /**
   * An app gate command through the comment's handler, tagged with the request's seq. A reject's reason and a revise's
   * feedback are new text the factory would publish (the reject's close quotes it), so they pass the egress scan
   * first, as an approve's, retry's or resolve's note does in the handler; a comment's own text is already on its source.
   */
  private async gateRequest(
    r: AppCommandRequest, item: WorkItem, kind: Exclude<CommandEvent["kind"], "budget_continue">, key: string, raw: string | undefined,
  ): Promise<string | null> {
    let note = raw ?? "";
    if (kind === "spec_rejected" || kind === "revise_requested") {
      const scanned = await this.c.unit("commands").approvalNote(item.id, raw, COMMAND[kind]);
      if ("refuse" in scanned) return scanned.refuse;
      note = scanned.note ?? "";
    }
    const app = { user_id: r.actor, passport: appPassport(r) };
    return this.c.unit("commands").gateCommand(item, gateEvent(kind, item, key, r, note), app, { [APP_REQUEST]: r.seq });
  }

  /**
   * The command box's sentence (design 09-dashboard-app): the request's user must hold approve_spec (with its edge
   * passport), as a plain reply's author must; then the commands unit's reader, as a plain reply on the item keyed
   * `key`, so its proposals are stored once under that key; one reply in the item's thread, keyed on the request.
   * Changes no item state. The UI process made no model call: this is the only one.
   */
  private async sentence(r: AppCommandRequest, item: WorkItem, key: string, text: string): Promise<string | null> {
    const principal = await this.c.unit("auth").allowed({ user_id: r.actor, attributes: {} }, "approve_spec", item.id, true, appPassport(r));
    if ("refuse" in principal) return principal.refuse;
    const e = { kind: "plain_comment" as const, source: item.source, comment_id: key, author: localIdentity(r.actor), body: text };
    const read = await this.c.unit("commands").readMessage(text, { work_item_id: item.id }, { item, e });
    if (read === "unread") return `the words were not read: they must be 1 to ${INTERPRET_MAX_CHARS} characters, pass the egress scan, and a model must be configured`;
    if (read === "blocked") return "the model's answer did not pass the egress scan, so it is not shown";
    const body = read.body ?? ["The factory did not find a command in your words, so nothing changed.", "", commandFooter(await this.c.unit("commands").stateOf(item))].join("\n");
    await this.c.unit("outbox").post(item, item.source, body, `<!-- factory:suggest:${key} -->`);
    return null;
  }

  /**
   * A stored proposal's Confirm all or Cancel from the item page, naming the proposal by its ID (`args.proposal`).
   * Confirm goes through the commands unit's confirm path as the request's user and passport, which checks each
   * command as the typed command is checked and answers on this item's thread. Cancel needs approve_spec.
   */
  private async proposalRequest(r: AppCommandRequest, item: WorkItem, key: string): Promise<string | null> {
    const proposal = typeof r.args.proposal === "string" ? r.args.proposal : "";
    if (proposal === "") return "the request names no proposal";
    if (r.command === CONFIRM_COMMAND) {
      await this.c.unit("commands").confirm({ key, actor: r.actor, args: { proposal }, created_at: r.created_at, ...(r.passport_id === undefined ? {} : { passport_id: r.passport_id }) }, item);
      return null;
    }
    const principal = await this.c.unit("auth").allowed({ user_id: r.actor, attributes: {} }, "approve_spec", item.id, true, appPassport(r));
    if ("refuse" in principal) return principal.refuse;
    await cancelProposal(this.c, proposal, r.actor, item, key);
    return null;
  }

  /** Posts `text` (a refusal) once on the item's source, keyed on the request, then marks the request handled. */
  async finishAppRequest(r: AppCommandRequest, item: WorkItem | null, text: string | null): Promise<void> {
    if (text !== null) {
      this.c.k.d.log.info("app command refused", { request_seq: r.seq, work_item_id: item?.id ?? null, command: r.command.slice(0, 64) });
      if (item) await this.c.unit("outbox").post(item, item.source, text, `<!-- factory:refused:app-${r.seq} -->`);
    }
    await this.c.k.commit({ writes: [{ kind: "app_request_handled", seq: r.seq, refusal: text }] });
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "app-requests": AppRequestsUnit;
  }
}

export default controllerUnit({
  name: "app-requests",
  create: (c: Ctx) => new AppRequestsUnit(c),
});
