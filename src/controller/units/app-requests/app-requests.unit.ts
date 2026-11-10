// Applies the status page's requests (approve, reject, revise, verdict, merge; anything else is refused).
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { COMMANDS } from "../../../core/commands.js";
import { LOCAL_SOURCE, MERGE_COMMAND } from "../../../core/local-merge.js";
import { type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { AppCommandRequest } from "../../../interfaces/factory-store.js";
import { type CommandEvent, COMMAND, QUOTABLE_COMMAND } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The state change detail key that names the app request a transition applied, so a second apply finds it. */
const APP_REQUEST = "app_request";
/** The app commands that answer as their comment command in a refusal. */
const AS_COMMENT: ReadonlyMap<string, string> = new Map([
  ["approve", COMMAND.spec_approved], ["reject", COMMAND.spec_rejected], ["revise", COMMAND.revise_requested], ["verdict", "/verdict"],
]);

/** The page's edge passport, checked for expiry at the time the request was recorded (absent: none). */
function appPassport(r: AppCommandRequest) {
  return r.passport_id === undefined ? undefined : { id: r.passport_id, at: r.created_at };
}

/** Applies the status page's requests (approve, reject, revise, verdict, merge; anything else is refused). */
export class AppRequestsUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * One app command request (design §4, app requests): `approve`, `reject` and `revise` go through the comment command
   * path and get the `/approve`, `/reject` or `/revise` permission check, note scan and transition (a reject then closes
   * its issue and its open PR, as `/reject` does; a revise stores its feedback as typed); `verdict` gets the `/verdict` check, parser and store, keyed `app-<seq>`;
   * `merge` on a local item with no PR goes to mergeLocal, the same local merge as `factory merge`, and on any item
   * with a PR to the PR merge (design §9, the Merge button). Each puts the request's seq on the state change (a
   * verdict on its key). Any other command is refused. A refusal is posted once on the item's source, keyed on the
   * request, then stored on the row by the conditional mark. A failed post leaves the request pending for the next
   * tick. Safe to run twice: a request whose transition is already stored (an earlier try, another replica) is
   * marked applied.
   */
  async applyAppRequest(r: AppCommandRequest): Promise<void> {
    const known = COMMANDS.some((c) => c.name === r.command);
    const name = AS_COMMENT.get(r.command) ?? (QUOTABLE_COMMAND.test(r.command) ? r.command : null);
    const say = (reason: string) => (name ? `\`${name}\` was not applied: ${reason}.` : `The command was not applied: ${reason}.`);
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
    } else if (r.command === "approve" || r.command === "reject" || r.command === "revise") {
      refusal = await this.specCommand(r, item, key, note);
    } else {
      refusal = "only `approve`, `merge`, `reject`, `revise` and `verdict` are applied from an app request" + (known ? `; reply \`/${r.command}\` on the issue instead` : "");
    }
    // Refused here, but applied by a concurrent try of the same request: that one stands.
    if (refusal !== null && (await applied())) refusal = null;
    await this.finishAppRequest(r, item, refusal === null ? null : say(refusal));
  }

  /**
   * An app `approve`, `reject` or `revise`, as the comment's: the `approve_spec` check, the note (the reject's reason,
   * the revise's feedback) through the egress scan, the transition with the request's seq, the standing-rule
   * follow-up and a reject's close. A revise is the issue's `/revise` (`revise_requested`): its feedback is stored as typed.
   */
  private async specCommand(r: AppCommandRequest, item: WorkItem, key: string, raw: string | undefined): Promise<string | null> {
    const principal = await this.c.unit("auth").allowed({ user_id: r.actor, attributes: {} }, "approve_spec", item.id, true, appPassport(r));
    if ("refuse" in principal) return principal.refuse;
    const note = await this.c.unit("commands").approvalNote(item.id, raw, AS_COMMENT.get(r.command));
    if ("refuse" in note) return note.refuse;
    const text = note.note ?? "";
    const who = { provider: "local" as const, subject: r.actor };
    const at = { source: item.source, comment_id: key };
    const e: CommandEvent = r.command === "reject"
      ? { kind: "spec_rejected", ...at, approver: who, reason: text }
      : r.command === "revise"
        ? { kind: "revise_requested", ...at, requester: who, feedback: text }
        : { kind: "spec_approved", ...at, approver: who };
    // The reject's reason and the revise's feedback are its spec feedback, never an approval note on the state change.
    const approval = e.kind === "spec_approved" ? note.note : null;
    const refusal = await this.c.unit("commands").applyCommand(item.id, e, { kind: "user", id: principal.user_id }, approval, { [APP_REQUEST]: r.seq });
    if (refusal !== null) return refusal;
    await this.c.k.guard("standing", () => this.c.unit("standing").afterSpecCommand(item.id, e, principal.user_id));
    if (e.kind === "spec_rejected") await this.c.unit("closes").afterReject(item.id);
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
