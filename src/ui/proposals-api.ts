// The Proposals page (design 09-dashboard-proposals, issue #496): GET /api/v1/proposals lists the improve run's entity
// proposals of the configured project, newest first, with their golden evidence; POST /api/v1/proposals/verdict takes
// promote, reject or hold. The request guards (Host, Origin, Content-Type, CSRF token, body size, JSON) run in server.ts
// first; then the body, then the approver check (the page's factory user must be allowed `approve_spec` on the project,
// asked of the local grants only), and only then one conditional store write. Promote files nothing here: the controller's
// improve step files the promoted proposal's item (fileProposals), so the verdict never waits on a sync plugin.

import { type Proposal, parseProposalVerdict } from "../core/proposals.js";
import type { UserId } from "../core/types.js";
import type { ApiResult } from "./api.js";
import type { PauseDeps, UiPauses } from "./pause-api.js";
import { Withholder } from "./withhold.js";

export const PROPOSALS_PATH = "/api/v1/proposals";
export const PROPOSAL_VERDICT_PATH = "/api/v1/proposals/verdict";
/** The newest proposals the page lists. */
const LIST_LIMIT = 100;

/** The page's user when they may decide, else why not: no user, or no `approve_spec`. */
async function approver(p: UiPauses): Promise<{ user: UserId } | { error: string }> {
  const user = await p.principal();
  if (user === null) return { error: "No factory user acts from this page: link your local account or set cli_user." };
  const decision = await p.authorize(user);
  return decision.allow ? { user } : { error: `Deciding a proposal needs write permission (approve_spec): ${decision.reason}.` };
}

/** GET /api/v1/proposals: each proposal, free text through the Withholder; the CSRF token only when the page's user may decide. */
export async function readProposals(d: PauseDeps): Promise<ApiResult> {
  const project = d.settings ? await d.settings.resolveProject() : null;
  const rows = await d.store.listProposals({ ...(project ? { project: project.key } : {}), limit: LIST_LIMIT });
  const w = new Withholder(d.scanner);
  const text = async (v: string | null) => (v === null ? null : (await w.plain(v, { channel: "run_outcome" })).text);
  const view = async (p: Proposal) => ({
    id: p.id, state: p.state, reason: p.reason, error_code: await text(p.error_code), run_count: p.run_count, file: p.file,
    why: await text(p.why), diff: await text(p.diff), before: p.before, after: p.after, rules: p.rules, needs_human_merge: p.needs_human_merge,
    decided_at: p.decided_at, filed: p.filed_ref !== null, created_at: p.created_at,
  });
  const decides = d.pauses !== undefined && !("error" in (await approver(d.pauses)));
  return { status: 200, value: { csrf_token: decides ? d.pauses!.csrfToken : null, proposals: await Promise.all(rows.map(view)) } };
}

/**
 * POST /api/v1/proposals/verdict with `{ id, verdict }`, after the request guards: the body (400), the approver (403,
 * nothing written), the proposal (404), then the conditional verdict. A decided proposal answers 200 with `unchanged`.
 */
export async function writeProposalVerdict(d: PauseDeps, p: UiPauses, body: unknown): Promise<ApiResult> {
  const v = parseProposalVerdict(body);
  if (typeof v === "string") return { status: 400, value: { error: v } };
  const who = await approver(p);
  if ("error" in who) return { status: 403, value: { error: who.error } };
  if (!(await d.store.getProposal(v.id))) return { status: 404, value: { error: "No such proposal." } };
  const changed = await d.store.decideProposal(v.id, v.verdict, who.user);
  const now = (await d.store.getProposal(v.id))!;
  p.log.info("proposal verdict", { proposal_id: v.id, verdict: v.verdict, actor: who.user, changed });
  return { status: 200, value: { id: v.id, state: now.state, unchanged: !changed } };
}
