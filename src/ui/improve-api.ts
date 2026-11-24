// The Rules page's Run now (design §7 and §9, issue #508): POST /api/v1/improve/run queues one manual improve
// run of the configured project through enqueueImprove, as `factory improve` does. The request guards (Host,
// Origin, Content-Type, CSRF token) run in server.ts first; then the approver check, the pause route's: the page's
// factory user must be allowed `approve_spec` on the project, asked of the local grants only (no forge call). A
// run already queued or running refuses the request; only then is the store written.
//
// The Proposals page (design 09-dashboard-proposals, issue #496), the improve run's entity proposals: GET /api/v1/proposals
// lists the configured project's, newest first, with their golden evidence; POST /api/v1/proposals/verdict takes promote,
// reject or hold. After server.ts's request guards (Host, Origin, Content-Type, CSRF token, body size, JSON): the body, then
// the approver check (`approve_spec` on the configured project, local grants only), then the proposal, which must be that
// project's, and only then one conditional store write. Promote files nothing here: the controller's improve step files
// the promoted proposal's item (fileProposals), so the verdict never waits on a sync plugin.
//
// The same list carries the improve run's skill drafts (design 09-dashboard-rules-waiting), `skills`: the configured
// project's, newest first, each with its state, reason, skill path, why (the failed checks it was drafted against),
// pass rates and the verdicts it offers (only a proposed or held draft offers any). The Rules page shows the waiting
// ones and sends their verdicts to POST /api/v1/rules/skill-verdict (rules-api.ts writeSkillVerdict), owner only.

import { type Proposal, enqueueImprove, parseProposalVerdict, pendingImprove } from "../core/improver.js";
import type { UserId } from "../core/types.js";
import type { SkillDraft } from "../interfaces/skill-draft-store.js";
import type { ApiResult } from "./api.js";
import type { PauseDeps, UiPauses } from "./pause-api.js";
import type { UiSettings } from "./settings-api.js";
import { Withholder } from "./withhold.js";

export const IMPROVE_RUN_PATH = "/api/v1/improve/run";

/** The route's wiring: the pause route's user and owner check, and the Settings route's store-only project. */
export type ImproveRunDeps = PauseDeps & { pauses: UiPauses; settings: UiSettings };

/** Whether Run now is wired: both the owner check and the project resolver are there. */
export function improveRunWired(d: PauseDeps): d is ImproveRunDeps {
  return d.pauses !== undefined && d.settings !== undefined;
}

/** The page's user when they may run it, else why not: no user, or no `approve_spec`. */
async function approver(p: UiPauses): Promise<{ user: UserId } | { error: string }> {
  const user = await p.principal();
  if (user === null) return { error: "No factory user acts from this page: link your local account or set cli_user." };
  const decision = await p.authorize(user);
  return decision.allow ? { user } : { error: `Running an improve run needs write permission (approve_spec): ${decision.reason}. Or run \`factory improve\`.` };
}

/** The Rules page's Run now button: its CSRF token when the route is wired and the page's user may approve, else null. */
export async function runNowButton(d: PauseDeps): Promise<{ csrfToken: string } | null> {
  if (!improveRunWired(d) || "error" in (await approver(d.pauses))) return null;
  return { csrfToken: d.pauses.csrfToken };
}

/** POST /api/v1/improve/run, after the request guards: the approver check, then one manual run, its ID returned. */
export async function runImproveNow(d: ImproveRunDeps): Promise<ApiResult> {
  const who = await approver(d.pauses);
  if ("error" in who) return { status: 403, value: { error: who.error } };
  const project = await d.settings.resolveProject();
  if (!project) return { status: 409, value: { error: "No project is stored yet: start the factory once first." } };
  const pending = await pendingImprove(d.store, project.key);
  if (pending) return { status: 409, value: { error: `An improve run is already ${pending.status} (${pending.id}).`, run_id: pending.id } };
  const { run } = await enqueueImprove(d, project.key, "manual");
  d.pauses.log.info("improve run queued", { run_id: run.id, actor: who.user, trigger: "manual" });
  return { status: 200, value: { run_id: run.id } };
}

export const PROPOSALS_PATH = "/api/v1/proposals";
export const PROPOSAL_VERDICT_PATH = "/api/v1/proposals/verdict";
/** The newest proposals the page lists. */
const LIST_LIMIT = 100;

/** The Proposals page's user when they may decide, else why not: no user, or no `approve_spec`. */
async function decider(p: UiPauses): Promise<{ user: UserId } | { error: string }> {
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
  const decides = d.pauses !== undefined && !("error" in (await decider(d.pauses)));
  const drafts = project ? (await d.store.listSkillDrafts(project.key)).reverse().slice(0, LIST_LIMIT) : [];
  const skills = await Promise.all(drafts.map((s) => skillView(s, text)));
  return { status: 200, value: { csrf_token: decides ? d.pauses!.csrfToken : null, proposals: await Promise.all(rows.map(view)), skills } };
}

/** The verdicts a skill draft in `state` offers (src/core/skill-improve.ts): promote, hold and reject when proposed; promote and reject when held. */
export function skillVerdicts(state: SkillDraft["state"]): ("promote" | "hold" | "reject")[] {
  return state === "proposed" ? ["promote", "hold", "reject"] : state === "held" ? ["promote", "reject"] : [];
}

/** A skill draft's row: never its draft text or old text; the skill path and check names through the Withholder. */
async function skillView(s: SkillDraft, text: (v: string | null) => Promise<string | null>) {
  const x = (s.detail ?? {}) as { reason?: unknown; failed_checks?: unknown; baseline_run?: { pass_rate?: unknown }; scratch_run?: { pass_rate?: unknown } };
  const rate = (r: { pass_rate?: unknown } | undefined) => (typeof r?.pass_rate === "number" ? r.pass_rate : null);
  const checks = Array.isArray(x.failed_checks) ? x.failed_checks.filter((c): c is string => typeof c === "string") : [];
  return {
    id: s.id, state: s.state, reason: typeof x.reason === "string" ? x.reason : null, skill_ref: await text(s.skill_ref),
    why: checks.length > 0 ? await text(checks.join("; ")) : null, before: rate(x.baseline_run), after: rate(x.scratch_run),
    created_at: s.created_at, verdicts: skillVerdicts(s.state),
  };
}

/**
 * POST /api/v1/proposals/verdict with `{ id, verdict }`, after the request guards: the body (400), the approver (403,
 * nothing written), the proposal of the configured project (404 for none or another project's, nothing written), then the conditional verdict. A decided proposal answers 200 with `unchanged`.
 */
export async function writeProposalVerdict(d: PauseDeps, p: UiPauses, body: unknown): Promise<ApiResult> {
  const v = parseProposalVerdict(body);
  if (typeof v === "string") return { status: 400, value: { error: v } };
  const who = await decider(p);
  if ("error" in who) return { status: 403, value: { error: who.error } };
  // approve_spec was asked on the configured project, so the proposal must be that project's: another project's answers 404.
  const proposal = await d.store.getProposal(v.id);
  const project = d.settings ? await d.settings.resolveProject() : null;
  if (!proposal || project === null || proposal.project !== project.key) return { status: 404, value: { error: "No such proposal in this project." } };
  const changed = await d.store.decideProposal(v.id, v.verdict, who.user);
  const now = (await d.store.getProposal(v.id))!;
  p.log.info("proposal verdict", { proposal_id: v.id, verdict: v.verdict, actor: who.user, changed });
  return { status: 200, value: { id: v.id, state: now.state, unchanged: !changed } };
}
