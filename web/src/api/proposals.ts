// The Proposals page (design 09-dashboard-proposals, issue #496): GET /api/v1/proposals and POST
// /api/v1/proposals/verdict (postProposalVerdict). The route URLs live here, beside the page's only reads and writes.

import { t } from "../i18n/index.js";
import { postJson } from "./client.js";

export const PROPOSALS_API = { list: "/api/v1/proposals", verdict: "/api/v1/proposals/verdict" } as const;

/** One golden replay of the review cases: each case's verdict, and the rates (null: no completed case of that kind). */
export interface ProposalEvidence {
  cases: { id: string; expect: "should_flag" | "should_pass"; verdict: "bug" | "pass" | "errored" }[];
  catch_rate: number | null;
  false_alarm_rate: number | null;
}

export type ProposalVerdict = "promote" | "reject" | "hold";

/** One stored proposal; free text has passed the server's Withholder. */
export interface ProposalRow {
  id: string;
  /** watching, skipped, withheld, pending, held, promoted or rejected. */
  state: string;
  /** Why it was skipped (`proposal_cap`, `draft_failed`, `replay_failed`), else null. */
  reason: string | null;
  error_code: string;
  run_count: number;
  file: string;
  why: string | null;
  diff: string | null;
  before: ProposalEvidence | null;
  after: ProposalEvidence | null;
  /** A withheld proposal's scan rules, else null. */
  rules: string[] | null;
  needs_human_merge: boolean;
  decided_at: string | null;
  /** A work item was filed for it (promoted). */
  filed: boolean;
  created_at: string;
}

/** `/api/v1/proposals`: newest first; `csrf_token` is null when the page's user may not decide. */
export interface ProposalsView {
  csrf_token: string | null;
  proposals: ProposalRow[];
}

/** POST /api/v1/proposals/verdict: the state after it, `unchanged` when it was decided already; or the refusal. */
export async function postProposalVerdict(
  token: string,
  body: { id: string; verdict: ProposalVerdict },
): Promise<{ ok: true; state: string; unchanged: boolean } | { ok: false; error: string }> {
  const r = await postJson<{ state?: string; unchanged?: boolean; error?: string }>(PROPOSALS_API.verdict, token, body);
  if (r.ok && r.value.state) return { ok: true, state: r.value.state, unchanged: r.value.unchanged === true };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}
