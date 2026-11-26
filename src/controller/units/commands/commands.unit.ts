// Gate commands from any source (approve, reject, revise, retry, resolve, budget), help, plain comments, links and PR feedback.
// Moved out of the legacy controller (RFC 0015 M5); it reads through the kernel's reader and writes through the kernel.
// PR feedback (pr-feedback.ts), the budget checkpoint answer (checkpoint.ts) and the info and link replies (replies.ts) are its siblings.
//
// The store-only checks of Approve, a command's note and Merge live in src/core/request-transition.ts (design
// 04-gate-commands, 2026-11-15); the dashboard's request path runs them too, and `afterRequestApprove` does its rest.

import { BUDGET_CHECKPOINT, parseBudgetAmount } from "../../../core/budget.js";
import { latestSpec, overCap, overCapApproval,
  APPROVED_RUN_QUEUED, APP_REQUEST, CHECKPOINT_REFUSAL, CLOSED_REFUSAL, HOLD_PATHS, RECHECK_PATHS_REFUSAL, appliesLocally, noFilesRefusal, appliesOnPr, approveCheck, approvesHold, awaitingSpec, commandFooter, commandNote, commandPhase, commandSpec,
  commandState, failedRunKind, floorCommand, floorTierNeeded, floorWip, helpReply, parseLink, phaseLabel, refusalText, ruleOfTwoCommand, scanNote, specDecision,
  specNotWaiting, unknownCommandReply, withTag, CANCEL_APP_COMMAND, SENTENCE_APP_COMMAND, localIdentity, specKind, localMergeRefusal, mergeReturned, prMergeRefusal, queuedRun, awaitingMerge, mergeCheckAgain, mergeCheckRetryRefusal, mergeCheckStopped, LOCAL_SOURCE, MERGE_COMMAND, RESTART_COMMAND,
} from "../../../core/commands.js";
import { AGENT_NEEDS_HUMAN, REPEATED_FAILURE, blockingRunKind, floorTier, isCovered, runKey, workItemIdFromBranch } from "../../../core/policy.js";
import { commandEvent, syncedCommand } from "../../../core/command-inbox.js";
import { CONFIRM_COMMAND, INTERPRET_MAX_CHARS, INTERPRET_MAX_ITEMS, interpretMessage, interpretReply, interpretTexts, openItems, proposalEvent } from "../../../core/interpret.js";
import { type Actor, RECURRING_FAILURE, type RunKind, type StateChangeDetail, type UserId, type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { AppCommandRequest, CliCommand } from "../../../interfaces/factory-store.js";
import type { SourceEvent } from "../../../interfaces/source-adapter.js";
import { answersDetail, splitAnswers } from "../../../shared/command-notes.js";
import { type Decision, type Refusal, type Widening, NO_WIDENING, type CommandEvent, COMMAND, MAX_CONFLICT_RETRIES, FLOOR_TIER, RULE_OF_TWO, CONFLICT_PENDING, SOURCE_CLOSE_PENDING, SYSTEM, retry, retryWip, footerAfter, alreadyAllowed } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";
import { answerPlain, appProposal, confirmProposal, storeProposals } from "./proposals.js"; import { RUN_NEXT_COMMAND, runNext } from "./run-next.js";
import { FEEDBACK_REQUIRED, applyQueued, queueRevise, replyQueued } from "./queued-revise.js"; import { scanClean } from "./scan.js"; import { recheckRetry } from "./premise-recheck.js"; import { commandText, pathsCommand } from "./paths.js"; import { noteCommand, noteOnSource } from "./note.js";
import { PR_REVISE, type PrFeedbackDeps, handlePrReview, itemOfPr, prFeedback } from "./pr-feedback.js"; import { RETRY, answerCheckpoint } from "./checkpoint.js"; import { type InfoSay, handleInfo, handleLink } from "./replies.js";

type AppSender = { user_id: UserId } | null;
type ItemCommandEvent = Exclude<CommandEvent, { kind: "budget_continue" }>;
type ResolveEvent = Extract<SourceEvent, { kind: "resolve_requested" }>;
type PlainCommentEvent = Extract<SourceEvent, { kind: "plain_comment" }>;
/** The decision answers of an approval note (`N: <answer>` lines, issue #526), as the shared approve gate reads them. */
const NOTE_ANSWERS = { split: splitAnswers, detail: answersDetail };
/** How the controller's refusals name a PR (core writes no change-ref form of its own). */
const PR_NAME = (ref: string) => `PR #${ref}`;
/** What pr-feedback.ts needs from the legacy core: the item a factory branch names, and where `/revise` feedback is taken. */
const PR_DEPS: PrFeedbackDeps = { branchItem: workItemIdFromBranch, phases: (local) => (local ? commandSpec("revise").local_phases : commandSpec("revise").pr_phases) ?? [] };
/** The info replies' text (replies.ts handleInfo). */
const INFO: InfoSay = { help: helpReply, unknown: unknownCommandReply };
/**
 * `/resolve [notes]` (design §5 Merge conflict). Only on an item waiting on a merge conflict, on a local item waiting for
 * a merge whose branch conflicts (`localConflict`, 2026-11-12), or one whose resolve run asked for a human. Starts a resolve
 * run under a new key: restart_count + 1, as /retry does, since the run key is per (loop, restart) and a second
 * /resolve would otherwise be a silent no-op. The notes (scanned and capped, the `+paths` line split off) go on
 * the run for the worker; they are untrusted. A `+paths` widens allowed_paths in the same transition (`w`).
 */
function resolveCommand(e: ResolveEvent, it: WorkItem, actor: Actor, resolveAsked: boolean, localConflict: boolean, note: string | null, w: Widening): Decision | Refusal {
  // Also the answer to a resolve run that asked for a human (agent_needs_human): the reply is its notes.
  const asked = resolveAsked && it.blocked_on === "human" && it.blocked_reason === AGENT_NEEDS_HUMAN;
  if (!conflictPending(it) && !asked && !localConflict) {
    return {
      refuse: `the item is not waiting on a merge conflict (it is ${phaseLabel(commandPhase(it))}); ` +
        `\`/resolve\` applies only when the ${phaseLabel("merge_conflict")}`,
    };
  }
  const next = { ...it, restart_count: it.restart_count + 1 };
  return {
    patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null, restart_count: next.restart_count, ...w.patch },
    actor,
    reason: "resolve_requested",
    detail: { comment_id: e.comment_id, ...w.detail },
    enqueue: { kind: "resolve", idempotency_key: runKey(next, "resolve"), input: { notes: note ?? "" } },
  };
}
/** A PR whose base no longer merges cleanly, waiting for a human (set by the update run, design §5). */
function conflictPending(it: WorkItem): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "human" && it.blocked_reason === CONFLICT_PENDING;
}
/**
 * The comment command event of an app gate command on `item`, keyed `key`: the note is the approve's or retry's
 * note, the resolve's notes, the reject's reason or the revise's feedback. Never on a PR: a revise here is the
 * issue's `/revise`. Only a `/retry` or `/resolve` reads `+paths` (APP_PATHS, design 09-dashboard-item-commands).
 */
function appGateEvent(kind: Exclude<CommandEvent["kind"], "budget_continue">, item: WorkItem, key: string, r: AppCommandRequest, note: string): CommandEvent {
  const who = { provider: "local" as const, subject: r.actor };
  const at = { source: item.source, comment_id: key };
  switch (kind) {
    case "spec_approved": return { kind, ...at, approver: who, note };
    case "spec_rejected": return { kind, ...at, approver: who, reason: note };
    case "revise_requested": return { kind, ...at, requester: who, feedback: note, pr: null };
    case "retry_requested": case "paths_requested": return { kind, ...at, requester: who, note };
    case "resolve_requested": return { kind, ...at, requester: who, notes: note, pr: null };
  }
}
const APP_PATHS: readonly CommandEvent["kind"][] = ["retry_requested", "resolve_requested"];
/** Gate commands from any source (approve, reject, revise, retry, resolve, budget), help, plain comments, links and PR feedback. */
export class CommandsUnit {
  constructor(readonly c: Ctx) {}

  /**
   * The merge gate (core request-transition, design 04-gate-commands), the one copy the dashboard's request path and
   * the controller's merges share: whether an item waits for its merge (merge_pending, or merge_queued once its Merge
   * was pressed), and why the local merge or a PR's merge does not apply to it (`held`: parked, resolve-held, or a
   * failed merge check's max_loops, `stopped`, which `again` sends to merge_pending). For the local-merge, merge-queue and pr-events units.
   */
  readonly merge = { waits: awaitingMerge, stopped: mergeCheckStopped, again: mergeCheckAgain,
    localRefusal: (it: WorkItem, canMerge: boolean, held = false) => localMergeRefusal(it, canMerge, PR_NAME, held),
    prRefusal: (it: WorkItem, forge: boolean) => prMergeRefusal(it, forge, PR_NAME) };

  /**
   * A merge refused or failed after its Merge was pressed (a conflict, a red check, a hook veto): a local item at
   * merge_queued goes back to merge_pending with the refusal on its state change, so the dashboard's row shows why
   * and offers Merge again. Any other item changes nothing (a `factory merge` or auto mode's merge never left it).
   */
  async mergeReturned(id: WorkItemId, refusal: string): Promise<void> {
    await this.c.unit("transitions").decide(id, (it) => mergeReturned(it, refusal, SYSTEM));
  }

  /**
   * The rest of an approval the dashboard's request path stored while the request was handled (core requestTransition,
   * design 09-dashboard-app, 2026-11-15), done once by the pass that handles its request row: the run it left to the
   * controller (its QUEUED_RUN detail) is queued through the Rule of Two and budget holds of `decide`, unless it is
   * queued already or the item moved on meanwhile (closed, blocked); the item's status is shown on its source; then
   * the standing-rule follow-up, as after a comment's approval (the request as that comment). A rejected
   * request-time approval has nothing to capture (captureTacit follows only a reject or a revise). Safe to run twice:
   * the run's key, the status and the follow-up's posts are keyed. No such change (the controller applied it): nothing.
   */
  async afterRequestApprove(item: WorkItem, r: AppCommandRequest): Promise<void> {
    const change = (await this.c.k.reader.listStateChanges(item.id)).find((c) => c.detail?.[APP_REQUEST] === r.seq && queuedRun(c) !== null);
    const run = change ? queuedRun(change) : null;
    if (!change || !run) return;
    await this.c.unit("transitions").decide(item.id, async (it) => {
      const queued = (await this.c.k.reader.listRuns(it.id)).some((x) => x.idempotency_key === run.idempotency_key);
      if (queued || it.stage === "CLOSED" || it.blocked_on !== "none") return null;
      return { patch: {}, actor: change.actor, reason: APPROVED_RUN_QUEUED, detail: { [APP_REQUEST]: r.seq }, enqueue: run };
    });
    const now = await this.c.k.reader.getWorkItem(item.id);
    if (now) await this.c.unit("outbox").showStatus(now);
    const e = appGateEvent("spec_approved", item, `app-${r.seq}`, r, "");
    await this.c.k.guard("standing", () => this.c.unit("standing").afterSpecCommand(item.id, e, r.actor));
  }

  async handleInboxCommand(c: CliCommand): Promise<void> {
    if (c.origin === "app") {
      // An app request (RFC 0015 D7): its own row, or a row from before the merge that points at it by seq.
      const r = await this.c.k.reader.getAppCommandRequest(typeof c.args.app_request === "number" ? c.args.app_request : c.key);
      if (r && r.handled_at === null) await this.c.unit("app-requests").applyAppRequest(r);
      return;
    }
    const synced = syncedCommand(c);
    if (synced) {
      // A source's own command (issue #284): applied only where its adapter runs, a failure logged and passed like a polled
      // event's, so a sync plugin's outage never holds later local commands. A `/merge` skips the comment mapping (no case).
      const e = synced.event, who = { provider: "github" as const, subject: c.actor.slice("github:".length) };
      if (!this.c.k.hasAdapter(synced.source.type)) return;
      if (c.command === MERGE_COMMAND) await this.c.k.guard("event:merge", () => this.c.unit("pr-events").mergeComment(c.key, who, synced.source, c.args.pr));
      else if (c.command === "note") await this.c.k.guard("event:note", () => noteOnSource(this.c, synced.source, who, c.key.slice("github:".length), String(c.args.text ?? ""), { say: refusalText, closed: CLOSED_REFUSAL }));
      else if (e) await this.c.k.guard(`event:${e.kind}`, () => this.c.dispatch(e));
      return;
    }
    const id = c.args.item; if (typeof id !== "string" || id === "") return;
    // Any source's item (design 05-sources, CLI intake): identity provider `local`, judged by the local auth plugin; never waits on its source.
    const item = await this.c.k.reader.getWorkItem(id as WorkItemId); if (!item) return;
    // A proposal's confirm press (proposals.ts), `factory merge <id>`, `/hold <id>` (the coordination unit's) and `/note` (note.ts) skip the comment mapping.
    if (c.command === CONFIRM_COMMAND) return confirmProposal(this.c, c, item, { event: (r, s) => proposalEvent(r, s, localIdentity(c.actor)), say: refusalText });
    if (c.command === MERGE_COMMAND && item.source.type === LOCAL_SOURCE) return void (await this.c.unit("local-merge").mergeLocal(item.id, localIdentity(c.actor), c.key));
    if (c.command === MERGE_COMMAND) return this.c.unit("pr-events").mergeCommand(item, localIdentity(c.actor), c.key, item.source);
    if (c.command === "hold") return void (await this.c.unit("coordination").holdCommand(item, { who: localIdentity(c.actor) }, c.key, String(c.args.text ?? "")));
    if (c.command === "note") return noteCommand(this.c, item, localIdentity(c.actor), c.key, String(c.args.text ?? ""), { say: refusalText, closed: CLOSED_REFUSAL });
    const e = commandEvent(c, item.source); if (e) await this.c.dispatch(e);
  }

  /**
   * A human command on a work item. Applied or not, the comment gets 👀; a refusal also gets one reply
   * saying why, keyed on the comment id. Commands on issues that are not work items are ignored entirely
   * (no reaction, no reply): they may be ordinary conversation on an unrelated issue.
   */
  async handleCommand(e: CommandEvent): Promise<void> {
    const onPr = (e.kind === "resolve_requested" || e.kind === "revise_requested") && e.pr ? e.pr : null;
    const item = onPr ? await itemOfPr(this.c, PR_DEPS, onPr) : await this.c.k.reader.getWorkItemBySource(e.source.type, e.source.id);
    if (!item) return;
    // A `/revise` on the PR of a closed item is ordinary conversation now: no reaction, no reply (design §4).
    if (e.kind === "revise_requested" && onPr && item.stage === "CLOSED") return;
    const refusal = await this.gateCommand(item, e);
    await this.c.unit("outbox").markSeen(e.source, e.comment_id);
    if (refusal === null) return;
    this.c.k.d.log.info("command refused", { work_item_id: item.id, command: e.kind, reason: refusal });
    // A /resolve or /revise sent on the PR is answered on the PR; every other command on the item's own issue.
    await this.c.unit("outbox").post(
      item,
      onPr ? e.source : item.source,
      refusalText(COMMAND[e.kind], refusal),
      `<!-- factory:refused:${e.comment_id} -->`,
    );
  }

  /**
   * An app gate command (the app-requests unit) through the comment's handler, tagged with the request's seq. A reject's
   * reason and a revise's feedback are new text the factory would publish (the reject's close quotes it), so they pass
   * the egress scan first, as an approve's, retry's or resolve's note does in the handler; a comment's own text is
   * already on its source.
   */
  async appGate(
    r: AppCommandRequest, item: WorkItem, kind: Exclude<CommandEvent["kind"], "budget_continue">, key: string, raw: string | undefined,
  ): Promise<string | null> {
    let note = raw ?? "";
    if (kind === "spec_rejected" || kind === "revise_requested") {
      const scanned = await this.approvalNote(item.id, raw, COMMAND[kind]);
      if ("refuse" in scanned) return scanned.refuse;
      note = scanned.note ?? "";
    }
    return this.gateCommand(item, appGateEvent(kind, item, key, r, note), { user_id: r.actor }, { [APP_REQUEST]: r.seq });
  }

  /** A gate command from a comment (`app` null) or an app request (its user), design §4: `approve_spec`, the
   * note (with its `+paths`: a comment's, or an app request's `/retry` or `/resolve`, APP_PATHS) through G5, the transition (`tag` on its change), an "already allowed" `+paths` reply, the standing follow-up, a reject's close, the pushback's capture. */
  async gateCommand(item: WorkItem, e: CommandEvent, app: AppSender = null, tag: StateChangeDetail | null = null): Promise<string | null> {
    const who = e.kind === "spec_approved" || e.kind === "spec_rejected" || e.kind === "budget_continue" ? e.approver : e.requester;
    const principal = app ? await this.c.unit("auth").allowed({ user_id: app.user_id }, "approve_spec", item.id) : await this.c.unit("auth").authorize(who, "approve_spec", item.id);
    if ("refuse" in principal) return principal.refuse;
    const input = await this.commandInput(item.id, e, app === null || APP_PATHS.includes(e.kind));
    if ("refuse" in input) return input.refuse;
    const refusal = await this.applyCommand(item.id, e, { kind: "user", id: principal.user_id }, input.note, tag, input.paths);
    const said = refusal === null ? alreadyAllowed(item, e, input.paths) : null; if (said) await this.c.unit("outbox").post(item, said.target, said.body, said.marker); if (refusal === null) await this.c.k.guard("standing", () => this.c.unit("standing").afterSpecCommand(item.id, e, principal.user_id));
    if (refusal === null && e.kind === "spec_rejected") await this.c.unit("closes").afterReject(item.id);
    if (refusal === null && (e.kind === "spec_rejected" || e.kind === "revise_requested")) { const words = e.kind === "spec_rejected" ? e.reason : e.feedback; await this.c.unit("outbox").captureTacit(item, e.comment_id, words); await this.c.unit("improve").captureCorrection(item, "pushback", e.comment_id, words); }
    if (refusal === null && e.kind === "revise_requested") await replyQueued(this.c, item, e.comment_id);
    return refusal;
  }

  /** applyQueued (queued-revise.ts) at a run end that would queue review (or a triage run's end); the run's key starts with the next loop's `runKey` (the triage key). */
  applyQueued = (it: WorkItem, d: NonNullable<Decision>) => applyQueued(this.c, it, d, it.stage === "NEW" ? runKey(it, "triage") : runKey({ ...it, loop_count: it.loop_count + 1 }, "implement"));

  /**
   * `/budget` and `/reject` at a budget checkpoint answer it (design §6); every other command, and `/reject`
   * elsewhere, goes through `command`. Returns the refusal reason, else null.
   */
  async applyCommand(
    id: WorkItemId,
    e: CommandEvent,
    actor: Extract<Actor, { kind: "user" }>,
    note: string | null,
    tag: StateChangeDetail | null = null,
    paths: readonly string[] = [],
  ): Promise<string | null> {
    for (let i = 0; i < MAX_CONFLICT_RETRIES; i++) {
      const it = await this.c.k.reader.getWorkItem(id);
      if (!it) return null;
      const atCheckpoint = it.stage !== "CLOSED" && it.blocked_reason === BUDGET_CHECKPOINT;
      if (atCheckpoint && (e.kind === "budget_continue" || e.kind === "spec_rejected")) {
        const r = await answerCheckpoint(this.c, it, e, actor, parseBudgetAmount);
        if (r === RETRY) continue;
        return r;
      }
      if (e.kind === "budget_continue") return it.stage === "CLOSED" ? CLOSED_REFUSAL : "the work item is not at a budget checkpoint";
      // `/approve` while implementing: lifts a coordination-cost hold on the queued implement run (design §5).
      if (e.kind === "spec_approved" && approvesHold(it)) {
        // The held run is already queued with its paths; `+paths` does not change them (issue #280).
        if (paths.length > 0) return HOLD_PATHS;
        const r = await this.approveHold(it, actor);
        if (r === RETRY) continue;
        return r;
      }
      if (e.kind === "retry_requested" && commandPhase(it) === "dependency_closed") return this.c.unit("coordination").retryDependencies(it, actor, note, paths);
      return this.c.unit("transitions").decide(id, async (x) =>
        withTag(await specDecision(x, await this.command(e, x, actor, note, tag, paths), () => this.specKindOf(x)), tag));
    }
    this.c.k.d.log.warn("command gave up after conflicts", { work_item_id: id, command: e.kind });
    return null;
  }

  /** The spec kind a spec decision's standing-approval detail names (design 05-standing-approvals): phase, split or single. */
  async specKindOf(it: WorkItem) {
    return specKind(it, it.parent_id === null && (await this.c.unit("phases").specPhases(it)) !== null);
  }

  /**
   * The approval note to store: trimmed, capped at MAX_NOTE_CHARS, null when empty. The whole note is
   * egress-scanned first; a finding refuses the approval, and neither the note nor the rule's match is kept.
   */
  async approvalNote(id: WorkItemId, raw: string | undefined, command = "/approve"): Promise<{ note: string | null } | Refusal> {
    return this.scanned(id, command, await scanNote((t) => this.c.k.d.scanner.scan("comment", t), raw, command));
  }

  /** `r` as it is, with a scan finding logged (its rules, never the text): the shared note checks (core request-transition) log nothing. */
  private scanned<T>(id: WorkItemId, command: string, r: T | { refuse: string; rules?: string }): T | Refusal {
    if (typeof r === "object" && r !== null && "rules" in r && r.rules !== undefined) {
      this.c.k.d.log.warn("command note blocked by the egress scan; command refused", { work_item_id: id, command, rules: r.rules });
    }
    return r;
  }

  /**
   * The note and the `+paths` of an `/approve`, `/retry`, `/resolve` or `/paths` (design §4, issue #280); none for other
   * commands. The whole text is egress-scanned first (so a refusal never quotes a flagged path), then `+paths` is
   * split off and checked (unless `paths` is false: an app request's other than APP_PATHS), the note what is left, capped. A finding or a bad path refuses it.
   */
  async commandInput(id: WorkItemId, e: CommandEvent, paths = true): Promise<{ note: string | null; paths: string[] } | Refusal> {
    const text = commandText(e); if (text === null) return { note: null, paths: [] }; if (typeof text === "object") return text; // paths.ts: `/paths +a` as `+paths a`
    return this.scanned(id, COMMAND[e.kind], await commandNote((t) => this.c.k.d.scanner.scan("comment", t), text, COMMAND[e.kind], paths));
  }

  /**
   * The allowed paths a `+paths` widens to (issue #280): the paths no allowed path covers yet, added once each,
   * and a tier raised to the highest floor they touch, as triage does; never lowered. No new path: no change.
   */
  widen(it: WorkItem, paths: readonly string[]): Widening {
    const added = [...new Set(paths)].filter((p) => !isCovered(p, it.allowed_paths));
    if (added.length === 0) return NO_WIDENING;
    const floor = floorTier(added, this.c.k.settings(it.project).floors);
    const raised = floor !== null && (it.tier === null || floor > it.tier) ? { tier: floor } : {};
    return { patch: { allowed_paths: [...it.allowed_paths, ...added], ...raised }, detail: { added_paths: JSON.stringify(added) } };
  }

  /**
   * A plain-language comment on a work item (design §4, issues #583, #584): at most one reply, keyed on the comment id
   * (proposals.ts answerPlain). Changes no item state. In order: the item, the commenter's permission (no model call
   * and no reply without it), then the answer, whose fallback lists the commands for the item's state.
   */
  async handlePlainComment(e: PlainCommentEvent): Promise<void> {
    const code = parseLink(e.body);
    if (code !== null) return handleLink(this.c, e, code);
    if (!this.c.k.reader.llm) return;
    const item = await this.c.k.reader.getWorkItemBySource(e.source.type, e.source.id);
    if (!item || item.stage === "CLOSED") return;
    if ("refuse" in (await this.c.unit("auth").authorize(e.author, "approve_spec", item.id))) return;
    await answerPlain(this.c, item, e, async () => commandFooter(await this.stateOf(item)));
  }

  /** The dashboard's Confirm all, Cancel or sentence (proposals.ts appProposal), `hold` (the coordination unit's), `restart` (the local-merge unit's) and `run-next` (run-next.ts), each also from its CLI command; undefined for any other app command. */
  appProposal(r: AppCommandRequest, item: WorkItem, key: string): Promise<string | null> | undefined {
    if (r.command === "hold") return this.c.unit("coordination").holdCommand(item, { app: r.actor }, key, typeof r.args.note === "string" ? r.args.note : "");
    if (r.command === RESTART_COMMAND) return this.c.unit("local-merge").restart(item, r.actor, key, { [APP_REQUEST]: r.seq });
    if (r.command === RUN_NEXT_COMMAND) return runNext(this.c, item, r.actor, key);
    const who = localIdentity(r.actor), kind = r.command === CONFIRM_COMMAND ? "confirm" : r.command === CANCEL_APP_COMMAND ? "cancel" : r.command === SENTENCE_APP_COMMAND ? "sentence" : null;
    return kind ? appProposal(this.c, r, item, key, kind, { who, event: (row, s) => proposalEvent(row, s, who), say: refusalText, footer: async () => commandFooter(await this.stateOf(item)) }) : undefined;
  }

  /**
   * One plain message through the interpreter, on an item's comment `on` or top-level (null; the intake unit's chat
   * messages): the length filter and the egress scan of the message (`unread` when either stops it: no model call),
   * the plain/command label then the interpreter (interpretMessage), the egress scan of the answer (`blocked`: nothing stored, nothing posted),
   * then the reply, with a `commands` answer's proposals stored once for the comment. Null reply: `request` or `none`.
   * `where` names the item or the source in a scan finding's log line.
   */
  async readMessage(
    body: string,
    where: Record<string, string>,
    on: { item: WorkItem; e: PlainCommentEvent } | null,
  ): Promise<{ kind: string; body: string | null } | "unread" | "blocked"> {
    const llm = this.c.k.reader.llm;
    const text = body.trim();
    if (!llm || text === "" || text.length > INTERPRET_MAX_CHARS || !(await scanClean(this.c, where, "message", [text]))) return "unread";
    const items = openItems(await this.c.k.reader.listWorkItemsWhere({ exclude_closed: true, limit: INTERPRET_MAX_ITEMS }));
    const result = await interpretMessage(text, items, llm, on ? { item: openItems([on.item])[0]!, blocked_reason: on.item.blocked_reason } : "top_level", this.c.k.live.values().message_style);
    if (!(await scanClean(this.c, where, "answer", interpretTexts(result)))) return "blocked";
    return { kind: result.kind, body: interpretReply(result, on ? await storeProposals(this.c, on.item, on.e, result) : null) };
  }

  /**
   * The transition a command asks for, or why the item's current state cannot take it. Async only because
   * a `/revise` past the limit posts its comment before the transition (keyed, so a conflict re-run posts once).
   */
  async command(
    e: ItemCommandEvent,
    it: WorkItem,
    actor: Actor,
    note: string | null,
    tag: StateChangeDetail | null = null,
    paths: readonly string[] = [],
  ): Promise<Decision | Refusal> {
    if (e.kind === "paths_requested") return pathsCommand(e, it, actor, note, this.widen(it, paths));
    if (e.kind === "resolve_requested") {
      return resolveCommand(e, it, actor, (await this.askedBy(it)) === "resolve", await this.c.unit("local-merge").conflicting(it), note, this.widen(it, paths));
    }
    // On the PR, in a Slack thread with a PR, or on a local item with no PR at the merge wait (its local branch, issue #563).
    const asFeedback = e.kind === "revise_requested" && (it.source.type === "slack_thread" ? appliesOnPr : appliesLocally)(commandSpec("revise"), commandState(it));
    if (e.kind === "revise_requested" && (e.pr || asFeedback)) {
      return prFeedback(this.c, PR_DEPS, it, { text: e.feedback, actor, reason: PR_REVISE, change_ref: e.pr?.change_ref ?? it.change_ref, key: { comment_id: e.comment_id } });
    }
    // `/approve` (design §4): a goal split waiting for the owner (goal_question, goal_limit) is answered by the phases unit (design 04-split-specs); else the approve gate every source shares (core request-transition), a split's filing claimed here; a spec that changes no file in this repo is refused first (design 04-spec-gate-commands). Over the item's size caps (04-split-specs, 2026-11-24: at too_large `/retry`'s implement run, at its size checkpoint the spec's approval) it needs a note and stores the one-time cap with its record (overCapApproval).
    // A routine's run held at its daily cap (routines unit): `/approve` raises today's cap by the last run's cost and runs it, `/reject` skips it.
    if (this.c.unit("routines").holds(it)) return this.c.unit("routines").answerCap(e.kind, it, actor);
    if (e.kind === "spec_approved") {
      if (this.c.unit("phases").waitsOnGoal(it)) return this.c.unit("phases").approveGoal(it, actor);
      const runs = await this.c.k.reader.listRuns(it.id), noFiles = noFilesRefusal(it, runs), over = overCap(it, runs, await this.c.k.reader.listStateChanges(it.id), latestSpec(runs), this.c.k.settings(it.project)), tooLarge = over !== null && "at" in over && over.at === "too_large";
      const a = tooLarge ? retry(it, actor, "implement", note, paths.length > 0 ? this.widen(it, paths) : null, (k) => this.c.unit("run-results").kindLabel(k), retryWip(runs)) : noFiles ? { refuse: noFiles } : await approveCheck(this.c.k.reader, it, { actor, note, paths, comment_id: e.comment_id, tag, widen: (p) => this.widen(it, p), answers: NOTE_ANSWERS });
      return a && "split" in a ? this.c.unit("phases").approveSplit(it, a.split, actor, a.note, e.comment_id, a.tag) : overCapApproval(over, actor, note, a);
    }
    if (it.stage === "CLOSED") return e.kind === "spec_rejected" && it.merge_sha ? this.reject(e, it, actor) : { refuse: CLOSED_REFUSAL };
    if (it.blocked_reason === BUDGET_CHECKPOINT) return { refuse: CHECKPOINT_REFUSAL };
    if (it.blocked_reason === FLOOR_TIER) return floorCommand(e.kind, it, actor, await floorTierNeeded(this.c.k.reader, it), note, this.widen(it, paths), floorWip(await this.c.k.reader.listRuns(it.id)));
    if (it.blocked_reason === RULE_OF_TWO) return ruleOfTwoCommand(e.kind, it, actor, note, paths, await this.c.k.reader.listStateChanges(it.id));
    if (e.kind === "spec_rejected") return this.reject(e, it, actor);
    if (e.kind === "retry_requested" && mergeCheckStopped(it, await this.c.k.reader.listStateChanges(it.id))) return { refuse: mergeCheckRetryRefusal(it.id) };
    if (e.kind === "retry_requested") return commandPhase(it) === "phase_hold" ? this.c.unit("phases").retryPhase(it, actor, note, paths) : recheckRetry(it, note, paths, retry(it, actor, await this.retryKind(it), note, paths.length > 0 ? this.widen(it, paths) : null, (k) => this.c.unit("run-results").kindLabel(k), retryWip(await this.c.k.reader.listRuns(it.id))), (await this.c.k.reader.listStateChanges(it.id)).at(-1), this.c.k.d.clock.now(), RECHECK_PATHS_REFUSAL); // a day old: re-check the premise first
    const phase = commandPhase(it);
    // At the review loop limit, and in REVIEW after a factory branch's `bug` verdict (2026-11-23), too: a human chose to go back through triage or to close (design 04-spec-gate-commands).
    const afterFailure = phase === "too_large" || phase === "failed_implement" || phase === "agent_needs_human" || phase === "repeated_failure" || phase === "max_loops" ||
      (e.kind === "revise_requested" && it.stage === "REVIEW" && it.origin !== "adopted" && (await this.c.unit("checks-gate").lastVerdict(it.id))?.verdict === "bug");
    if (afterFailure && e.kind === "revise_requested") return this.reviseAfterFailure(e, it, actor);
    if (e.kind === "revise_requested" && ((phase === "implementing" && it.stage === "RUNNING") || phase === "triaging")) return queueRevise(this.c, e, it, actor); // added context on a New item (design 02-attachments)
    if (!awaitingSpec(it)) {
      const onPr = e.kind === "revise_requested" && it.change_ref !== null && commandSpec("revise").pr_phases?.includes(phase)
        ? `; to send feedback to the implementer, reply \`/revise <feedback>\` on PR #${it.change_ref}` : "";
      return { refuse: `${specNotWaiting(phase)}${onPr}` };
    }
    switch (e.kind) {
      case "revise_requested": {
        const feedback = e.feedback.trim();
        if (!feedback) return { refuse: FEEDBACK_REQUIRED };
        const limit = this.c.k.cfg.max_loops;
        if (it.blocked_reason === "max_revisions") {
          return { refuse: `the spec reached the revision limit (\`max_loops\` = ${limit}); reply \`/approve\` or \`/reject <reason>\`` };
        }
        if (it.revision_count >= limit) {
          const patch = { blocked_on: "human" as const, blocked_reason: "max_revisions" };
          await this.c.unit("outbox").comment(it, `max-revisions:${it.id}`, [
            `The spec was revised ${it.revision_count} times (limit \`max_loops\` = ${limit}), so the factory started no new triage run (\`max_revisions\`).`,
            "",
            "Reply `/approve` to implement the spec above, or `/reject <reason>` to close.",
            "",
            footerAfter(it, patch),
          ].join("\n"));
          return { patch, actor, reason: "max_revisions" };
        }
        const n = it.revision_count + 1;
        return {
          patch: { stage: "NEW", blocked_on: "none", blocked_reason: null, revision_count: n, spec_feedback: feedback },
          actor,
          reason: "spec_revision_requested",
          // Differs from the intake key and from every earlier revision's key.
          enqueue: { kind: "triage", idempotency_key: `${runKey(it, "triage")}:v${n}` },
        };
      }
    }
  }

  /**
   * `/reject <reason>` at any open phase (design 04-gate-commands, 2026-11-13): closes as `rejected` without a merge, its queued and
   * running runs stopped in the same transition as a source close does; then the comment, issue close and an open PR's close
   * (finishReject). Refused, saying why, when its change is merged or in the merge queue (the closes unit's rejectRefusal).
   */
  async reject(e: Extract<ItemCommandEvent, { kind: "spec_rejected" }>, it: WorkItem, actor: Actor): Promise<Decision | Refusal> {
    const refuse = await this.c.unit("closes").rejectRefusal(it);
    if (refuse !== null) return { refuse };
    const patch = { stage: "CLOSED", close_reason: "rejected", blocked_on: "upstream", blocked_reason: SOURCE_CLOSE_PENDING, spec_feedback: e.reason.trim() || null } as const;
    return { patch, actor, reason: "spec_rejected", cancel_running_runs: true };
  }

  /**
   * `/revise <feedback>` at a failed implement run, a `diff_too_large` block, the review loop limit or in REVIEW after a `bug` verdict (design §4):
   * the item goes back through triage with the feedback, then to the spec gate. The revision counter and
   * `max_loops` apply as at the spec gate, but at the limit nothing changes: the item keeps its block, where
   * `/retry` and `/reject` still apply. restart_count + 1 so the implement run after the next `/approve` gets a
   * new run key; the old failure comment is unlinked. At the loop limit loop_count goes back to 0; the PR and
   * its branch stay.
   */
  reviseAfterFailure(e: Extract<ItemCommandEvent, { kind: "revise_requested" }>, it: WorkItem, actor: Actor): Decision | Refusal {
    const feedback = e.feedback.trim();
    if (!feedback) return { refuse: FEEDBACK_REQUIRED };
    const limit = this.c.k.cfg.max_loops;
    if (it.revision_count >= limit) {
      return {
        refuse: `the spec was revised ${it.revision_count} times, the revision limit (\`max_loops\` = ${limit}); ` +
          "reply `/retry` to run the implementer again or `/reject <reason>` to close",
      };
    }
    const n = it.revision_count + 1;
    return {
      patch: {
        stage: "NEW",
        blocked_on: "none",
        blocked_reason: null,
        revision_count: n,
        restart_count: it.restart_count + 1,
        ...(it.blocked_reason === "max_loops" ? { loop_count: 0 } : {}),
        spec_feedback: feedback,
        failure_comment_url: null,
      },
      actor,
      reason: "spec_revision_requested",
      detail: { previous_blocked_reason: it.blocked_reason },
      // The spec-gate revision key: differs from the intake key and from every earlier revision's key.
      enqueue: { kind: "triage", idempotency_key: `${runKey(it, "triage")}:v${n}` },
    };
  }

  /**
   * `/approve` on an implementing item (design §5, 2026-11-03): its queued implement run's latest claim decision
   * is `held` by coordination cost, so the approval is recorded (state change `coordination_approved`, the
   * approver as actor) and the next claim takes the run. Without such a hold it is refused as before.
   */
  async approveHold(it: WorkItem, actor: Extract<Actor, { kind: "user" }>): Promise<string | null | typeof RETRY> {
    const queued = new Set((await this.c.k.reader.listRuns(it.id)).filter((r) => r.kind === "implement" && r.status === "queued").map((r) => r.id));
    const held = (await this.c.k.reader.listClaimDecisions(it.id))
      .filter((d) => d.decision === "held" && d.approved_by === null && queued.has(d.run_id))
      .at(-1);
    if (!held) {
      return `the spec is not waiting for approval and no implement run is held by coordination cost (the item is ${phaseLabel(commandPhase(it))})`;
    }
    const r = await this.c.k.commitItem([], { kind: "claim_approval", input: { id: it.id, expected_version: it.version, actor, run_id: held.run_id } });
    if (r.ok) {
      this.c.k.d.log.info("transition", { work_item_id: it.id, reason: "coordination_approved", version: r.item.version, run_id: held.run_id });
      return null;
    }
    if (r.reason === "version_conflict") return RETRY;
    return r.reason === "not_held" ? "the implement run is no longer held by coordination cost" : null;
  }

  /** The kind of run behind an agent_needs_human or repeated_failure block (from the item's runs); else undefined. */
  async blockedBy(it: WorkItem): Promise<RunKind | undefined> {
    if (it.blocked_on !== "human" || (it.blocked_reason !== AGENT_NEEDS_HUMAN && it.blocked_reason !== REPEATED_FAILURE)) return undefined;
    return blockingRunKind(it.blocked_reason, await this.c.k.reader.listRuns(it.id));
  }

  /** At agent_needs_human: the kind of run that asked; else undefined. */
  async askedBy(it: WorkItem): Promise<RunKind | undefined> {
    return it.blocked_reason === AGENT_NEEDS_HUMAN ? this.blockedBy(it) : undefined;
  }

  /** The step a `/retry` restarts: implement at the loop limit, the run behind an agent block or a recurring failure's hold (its last failed run, as at repeated_failure), else what the item's fields say. */
  async retryKind(it: WorkItem): Promise<RunKind | undefined> {
    if (it.blocked_on === "human" && it.blocked_reason === "max_loops") return "implement";
    return it.blocked_reason === RECURRING_FAILURE ? blockingRunKind(REPEATED_FAILURE, await this.c.k.reader.listRuns(it.id)) : (await this.blockedBy(it)) ?? failedRunKind(it);
  }

  /** The command state of `it`, with the kind of run that asked at agent_needs_human and whether a failed merge check stopped it at max_loops. */
  async stateOf(it: WorkItem) {
    return commandState(it, await this.askedBy(it), it.blocked_reason === "max_loops" && mergeCheckStopped(it, await this.c.k.reader.listStateChanges(it.id)));
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "commands": CommandsUnit;
  }
}

export default controllerUnit({
  name: "commands",
  create: (c: Ctx) => new CommandsUnit(c),
  events: {
    spec_approved: (u, e) => u.handleCommand(e),
    spec_rejected: (u, e) => u.handleCommand(e),
    revise_requested: (u, e) => u.handleCommand(e),
    retry_requested: (u, e) => u.handleCommand(e),
    resolve_requested: (u, e) => u.handleCommand(e), paths_requested: (u, e) => u.handleCommand(e),
    budget_continue: (u, e) => u.handleCommand(e),
    help_requested: (u, e) => handleInfo(u.c, e, INFO),
    unknown_command: (u, e) => handleInfo(u.c, e, INFO),
    plain_comment: (u, e) => u.handlePlainComment(e),
    pr_changes_requested: (u, e) => handlePrReview(u.c, PR_DEPS, e),
  },
});
