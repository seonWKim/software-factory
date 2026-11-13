// Applies the status page's requests (the gate commands approve, reject, revise, retry and resolve, verdict, merge,
// and through the commands unit a sentence and a proposal's Confirm all and Cancel; anything else is refused).
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { COMMANDS, refusalText } from "../../../core/commands.js";
import { LOCAL_SOURCE, MERGE_COMMAND } from "../../../core/local-merge.js";
import { type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { AppCommandRequest } from "../../../interfaces/factory-store.js";
import { type CommandEvent, COMMAND, QUOTABLE_COMMAND } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The state change detail key that names the app request a transition applied, so a second apply finds it. */
const APP_REQUEST = "app_request";
/** The app's gate commands, as the comment command each one is (design §4, app requests). */
const GATE: ReadonlyMap<string, Exclude<CommandEvent["kind"], "budget_continue">> = new Map([
  ["approve", "spec_approved"], ["reject", "spec_rejected"], ["revise", "revise_requested"], ["retry", "retry_requested"], ["resolve", "resolve_requested"],
]);
/** The commands applied from an app request, as a refusal names them. */
const APPLIED = "only `approve`, `merge`, `reject`, `resolve`, `retry`, `revise` and `verdict` are applied from an app request";

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

/** Applies the status page's requests (approve, reject, revise, retry, resolve, verdict, merge; anything else is refused). */
export class AppRequestsUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * One app command request (design §4, app requests): `approve`, `reject`, `revise`, `retry` and `resolve` go through
   * the comment command path (CommandsUnit.gateCommand) with the request's user and edge passport: the same
   * `approve_spec` check, note scan, transition, standing-rule follow-up and reject close as the comment. `verdict` gets
   * the `/verdict` check, parser and store, keyed `app-<seq>`; `merge` on a local item with no PR goes to mergeLocal,
   * the same local merge as `factory merge`, and on any item with a PR to the PR merge (design §9, the Merge button).
   * Each puts the request's seq on the state change (a verdict on its key). The command box's sentence and a stored
   * proposal's Confirm all and Cancel go to the commands unit (`appProposal`). Any other command is refused. A refusal
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
      const who = { user_id: r.actor };
      refusal = item.source.type === LOCAL_SOURCE && item.change_ref === null
        ? await this.c.unit("local-merge").mergeLocal(item.id, who, key, { [APP_REQUEST]: r.seq })
        : await this.c.unit("pr-events").requestPrMerge(item.id, who, key, { [APP_REQUEST]: r.seq });
    } else if (r.command === "verdict") {
      const principal = await this.c.unit("auth").allowed({ user_id: r.actor, attributes: {} }, "record_verdict", item.id);
      refusal = "refuse" in principal ? principal.refuse : await this.c.unit("verdicts").verdictFrom(item.id, { comment_id: key, target: "issue" }, principal, note ?? "");
    } else if (gate) {
      refusal = await this.gateRequest(r, item, gate, key, note);
    } else {
      const proposal = this.c.unit("commands").appProposal(r, item, key);
      refusal = proposal ? await proposal : APPLIED + (known ? `; reply \`/${r.command}\` on the issue instead` : "");
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
    const app = { user_id: r.actor };
    return this.c.unit("commands").gateCommand(item, gateEvent(kind, item, key, r, note), app, { [APP_REQUEST]: r.seq });
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
