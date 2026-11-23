// Promote of a structure proposal from the Rules page (design 09-dashboard-rules.md, 2026-11-20), and the one verdict
// send the Rules write routes share. A proposal with Now or Proposed lines is applied by the plugin through
// `TacitLedger.verdict`; one whose change is prose has its verdict recorded, then one plain task is stored to build it
// (`tk_` + the proposal ID in lower case, its title, and a body with the rationale, change, target, evidence IDs and
// proposal ID): the store's one write from the Rules page. A retry finds that task, or the ledger's promote verdict,
// and sends nothing twice. Called by `writeRuleVerdict` in rules-api.ts after its guards and owner check.

import type { RuleVerdict } from "../core/learned-rules.js";
import { errorText } from "../core/log.js";
import { MAX_TASK_BODY, taskBody } from "../core/tasks.js";
import type { UserId } from "../core/types.js";
import {
  type TacitEntryDetail, type TacitLedger, type TacitPromotion, TacitRefusal, TacitSyncFailed, isProse, proposalTaskId,
} from "../interfaces/tacit-ledger.js";
import type { ApiResult } from "./api.js";
import type { PauseDeps, UiPauses } from "./pause-api.js";
import { Withholder } from "./withhold.js";

/** A parsed POST /api/v1/rules/verdict body. */
export type VerdictBody = { id: string; verdict: RuleVerdict; reason: string; rule?: TacitPromotion };

/** `TacitLedger.verdict`; null when it was recorded, else the refusal or failure as the route answers it. */
export async function sendVerdict(tacit: TacitLedger, v: VerdictBody): Promise<ApiResult | null> {
  try {
    await tacit.verdict(v.id, v.verdict, v.reason, v.rule);
    return null;
  } catch (err) {
    if (err instanceof TacitRefusal) return { status: 409, value: { error: `The ${v.verdict} was refused: ${errorText(err)}` } };
    if (err instanceof TacitSyncFailed) return { status: 502, value: { error: `The verdict was recorded, but sync-agents failed: ${errorText(err)}` } };
    return { status: 502, value: { error: `The ledger refused the verdict: ${errorText(err)}` } };
  }
}

/**
 * Promote of a proposal. Its task stored already (a retry): nothing is sent or written. Else its detail is read: no
 * detail or no target is refused before any verdict runs. With Now or Proposed lines the plugin applies them (one
 * without the other it refuses) and sends the verdict, as before. With none (a prose change, to build) the verdict is sent unless the ledger's newest verdict on
 * it is a promote already (a retry after a lost response), and then one plain task is stored: `tk_` + the ID in lower
 * case, the proposal's title, and a body with the rationale, change, target, evidence IDs and proposal ID. A refused
 * or failed verdict stores no task.
 */
export async function promoteProposal(d: PauseDeps, p: UiPauses, tacit: TacitLedger, v: VerdictBody, user: UserId): Promise<ApiResult> {
  const taskId = proposalTaskId(v.id)!;
  const done = { status: 200, value: { id: v.id, verdict: v.verdict, task_id: taskId } };
  if ((await d.store.getTask(taskId)) !== null) return done;
  let detail: TacitEntryDetail | null;
  try {
    detail = (await tacit.show?.(v.id)) ?? null;
  } catch (err) {
    return { status: 409, value: { error: `The promote was refused: the detail of ${v.id} could not be read: ${errorText(err)}` } };
  }
  if (detail?.target === undefined) return { status: 409, value: { error: `The promote was refused: ${v.id} has no target: nothing written` } };
  if (!isProse(detail)) {
    const failed = await sendVerdict(tacit, v);
    if (failed !== null) return failed;
    p.log.info("rule verdict sent", { id: v.id, verdict: v.verdict, actor: user, edited: false });
    return { status: 200, value: { id: v.id, verdict: v.verdict } };
  }
  // The title is read before the verdict: a judged proposal may leave the pending list.
  const listedTitle = await proposalTitle(tacit, v.id, detail);
  const recorded = (await tacit.decided?.([v.id]))?.[v.id] === "promote";
  if (!recorded) {
    const failed = await sendVerdict(tacit, v);
    if (failed !== null) return failed;
  }
  const w = new Withholder(d.scanner);
  const text = async (s: string) => (await w.plain(s)).text;
  const title = await text(listedTitle);
  const body = taskBody((await buildBody(v.id, detail, text)).slice(0, MAX_TASK_BODY));
  await d.store.addTask({
    id: taskId, title, list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: user, body: body.ok ? body.body : null,
  });
  p.log.info("rule verdict sent", { id: v.id, verdict: v.verdict, actor: user, edited: false, task: taskId, resent: !recorded });
  return done;
}

/** The proposal's title as `pending` lists it; its description, else its ID, when it is not listed (or the read fails). */
async function proposalTitle(tacit: TacitLedger, id: string, detail: TacitEntryDetail): Promise<string> {
  try {
    const listed = (await tacit.pending()).find((e) => e.id === id);
    if (listed !== undefined) return listed.title;
  } catch {
    // The description stands in for a title the ledger could not list.
  }
  return detail.description ?? id;
}

/** The task body of a proposal to build, each value through `text`: rationale (root reason), change (its prose change, else its description), target, evidence IDs and ID. */
async function buildBody(id: string, d: TacitEntryDetail, text: (v: string) => Promise<string>): Promise<string> {
  const evidence = [...new Set((d.evidence ?? []).flatMap((e) => (e.ref === undefined ? [] : [e.ref])))];
  const rationale = d.root_reason ?? d.evidence?.find((e) => e.root_reason !== undefined)?.root_reason;
  const fields: [string, string][] = [
    ["Rationale", rationale ?? "not given"], ["Change", d.change ?? d.description ?? "not given"], ["Target", d.target ?? "not given"],
    ["Evidence", evidence.length === 0 ? "none" : evidence.join(", ")], ["Proposal", id],
  ];
  return (await Promise.all(fields.map(async ([label, value]) => `${label}: ${await text(value)}`))).join("\n");
}
