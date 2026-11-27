// The Rules page: GET /api/v1/standing, /api/v1/rules and /api/v1/rules/entry; POST /api/v1/standing (postStanding),
// POST /api/v1/rules/verdict (postRuleVerdict), /api/v1/rules/edit (postRuleEdit), /api/v1/rules/pushbacks/dismiss
// (postPushbackDismiss) and POST /api/v1/improve/run (postImproveRun).

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { t } from "../i18n/index.js";
import { getJson, postJson } from "./client.js";
import { API } from "./routes.js";

/** One standing rule of `/api/v1/standing` (design 05-standing-approvals): when it last fired (null: never) and the items it approved in the last 7 days. */
export interface StandingRuleRow {
  rule: string;
  gate: string;
  tier: number;
  threshold: number;
  enabled: boolean;
  set_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_fired_at: string | null;
  recent: { id: string; title: string }[];
}

/** A proposal to turn a rule on that no one has answered yet. */
export interface StandingProposalRow {
  id: string;
  rule: string;
  run_length: number;
  threshold: number;
  created_at: string;
}

/**
 * `/api/v1/standing`: the rules, the pending proposals and `waiting`, the items waiting now that the rule would approve
 * (the dialogs' preview; absent from an older server); `csrf_token` is null when the server has no write route.
 */
export interface StandingView {
  as_of: string;
  csrf_token: string | null;
  rules: StandingRuleRow[];
  proposals: StandingProposalRow[];
  waiting?: { id: string; title: string }[];
}

/** A POST /api/v1/standing body: a rule on or off (naming the proposal it answers, if any), its row removed, or the threshold changed. */
export type StandingWriteBody =
  | { rule: string; enabled: boolean; proposal?: string }
  | { rule: string; action: "remove" }
  | { rule: string; action: "edit"; threshold: number };

/** One ledger entry waiting for the owner's verdict on the Rules page (issue #571). */
export interface RuleRow {
  /** `C-…` for a candidate class, `P-…` for a structure proposal. */
  id: string;
  title: string;
  /** `open`, `pending` or `held`: the ledger's heading it is listed under. */
  state: string;
  /** The decision of a ledger verdict newer than the pending view: judged already, no verdict offered. Null: not judged. */
  judged: string | null;
  /** A class's draft (`evolve show`), which prefills Promote; null for a proposal, a judged entry or a failed read. */
  draft: { default: string; exception: string; incidents: string[]; scope: string } | null;
  /** Why a class's draft could not be read (Promote is off then), or null. */
  draft_error: string | null;
  /** A proposal's kind (`promote-learning`, `edit-asset`, `new-asset`) and the asset it changes, when the ledger lists them. */
  kind?: string;
  target?: string;
  /**
   * A waiting proposal's one-line gist: the first line it adds, else its prose change, description or root reason;
   * null when the ledger gave none, or for any other entry (absent from an older server).
   */
  gist?: string | null;
  /** The task a promote of this proposal created to build it (`tk_` + its ID in lower case); null before (absent from an older server). */
  task?: string | null;
}

/** One incident behind an entry: its linked ID (T-, L-, E-, P-), day, the agent's proposal, the owner's quote, its root reason. */
export interface RuleEvidence {
  ref?: string;
  date?: string;
  proposal?: string;
  quote?: string;
  root_reason?: string;
}

/** One entry's detail from `/api/v1/rules/entry?id=`; a field the ledger did not print is absent. */
export interface RuleDetail {
  id: string;
  /** One line on what the entry is. */
  description?: string;
  default?: string;
  exceptions?: string;
  kind?: string;
  target?: string;
  /** A proposal's current lines of its target and the change it proposes, when the ledger carries them. */
  current?: string;
  proposed?: string;
  /** A proposal's change in prose, when it gives no current and proposed lines. */
  change?: string;
  incidents?: number;
  /** The incidents, newest first. */
  evidence?: RuleEvidence[];
  root_reason?: string;
  scope?: string;
}

/**
 * `/api/v1/rules/entry?id=`: `detail` null when the ledger gave none; `error` a failed read, or null. `retire`: an
 * applied class's reasons to retire it ([] for none), null for any other entry (absent from an older server).
 */
export interface RuleEntryView {
  id: string;
  detail: RuleDetail | null;
  error: string | null;
  retire?: string[] | null;
  /** The newest ledger verdict of each evidence ID that has one; an ID with none is left out (absent from an older server). */
  cited?: Record<string, string>;
}

/** One retired class from the ledger's retire verdicts: the owner's reason and the day (YYYY-MM-DD). */
export interface RetiredRule {
  id: string;
  reason: string;
  date: string;
}

/** One promoted block of the rules file (Applied group); a part it lacks is null, an unparsable block has only `raw`. */
export interface AppliedRule {
  id: string | null;
  name: string | null;
  default: string | null;
  exceptions: string | null;
  scope: string | null;
  incidents: string[] | null;
  judged: string | null;
  raw: string | null;
}

/** One active pushback in no class yet: its incident ID (sent by Dismiss, never shown), the owner's words, the day or null. */
export interface PushbackRow {
  id: string;
  pushback: string;
  date: string | null;
}

/** One agents home and the first of bin/tacit and bin/evolve that is missing or not executable there (null: both are). */
export interface AgentsHomeView {
  path: string;
  missing: string | null;
}

/**
 * `/api/v1/rules`: `enabled` false when the tacit ledger is off; `judge` is why the viewer cannot send a verdict (or,
 * with the ledger off, turn it on), or null; `error` is a failed ledger read, or null. With the ledger off, `home` is
 * the agents home in use and the CLI missing there (null: found), with `homes`, each known home (AGENTS_HOME when set,
 * ~/.agents) and its own check, for the picker; `turn_on` the `integrations` value that turns it on (the plugin name
 * only), sent through POST /api/v1/settings; null when the viewer may not or the home is not found.
 */
export interface RulesView {
  enabled: boolean;
  entries: RuleRow[];
  /** Each waiting proposal's first changed lines, by ID; a side the ledger did not give is absent (absent from an older server). */
  excerpts?: Record<string, { before?: string; after?: string }>;
  /** The rules file's blocks and encoded-elsewhere lines; null with the ledger off. */
  applied: { rules: AppliedRule[]; elsewhere: string[] } | null;
  /** The retired classes, newest first; null with the ledger off (absent from an older server). */
  retired?: RetiredRule[] | null;
  /** The active unclustered pushbacks and a failed read's error; null (or absent) with the ledger off or a plugin without them. */
  pushbacks?: { rows: PushbackRow[]; error: string | null } | null;
  error: string | null;
  csrf_token: string | null;
  judge: string | null;
  home: (AgentsHomeView & { homes?: AgentsHomeView[] }) | null;
  turn_on: string | null;
  /** The latest improve report and Run now (absent from an older server), with the ledger on or off. */
  improve?: ImproveView;
}

/**
 * The `improve` field of `/api/v1/rules`: the latest report (null: no run has reported), and `run_now` whether the
 * viewer may queue a run (approve_spec), with the token POST /api/v1/improve/run takes (null when they may not).
 */
export interface ImproveView {
  report: ImproveReportView | null;
  run_now: boolean;
  csrf_token: string | null;
}

export interface ImproveReportView {
  window_start: string;
  window_end: string;
  created_at: string;
  /** The runs in all groups. */
  runs: number;
  /** Single-run patterns (not shown). */
  patterns: number;
  groups: ImproveGroupView[];
}

/** One failure group: its draft's cause and fix, or one note (withheld, failed, skipped); `filing` null: not filed yet; `hotspot` marks a file. */
export interface ImproveGroupView {
  error_code: string;
  detail: string | null;
  runs: number;
  /** True for an often-edited file (its `detail` is the file), not a failure group. */
  hotspot: boolean;
  draft: { cause: string | null; fix: string | null; note: ImproveNote | null } | null;
  filing: ImproveFilingView | null;
}

/** A draft that was skipped, failed or withheld: `reason` is the stored code, or `withheld`. */
export interface ImproveNote {
  status: string;
  reason: string;
}

/** A group's filing: `reason` is the code of a skipped or failed one (`withheld` for a withheld one), else null; `runs` the new runs a comment named. */
export interface ImproveFilingView {
  status: "filed" | "linked" | "commented" | "skipped" | "withheld" | "failed";
  reason: string | null;
  ref: string | null;
  runs: number | null;
}

export type RuleVerdict = "promote" | "reject" | "hold" | "retire";

/**
 * One entry's detail, read once when `enabled` turns true (a card opens, or Suggest is pressed), never polled. Each
 * `round` (a Suggest press) reads it again, and the last round's answer stays shown while the next one loads.
 */
export function useRuleEntry(id: string, enabled: boolean, round = 0) {
  const url = API.ruleEntry(id);
  return useQuery({ queryKey: [url, round], queryFn: () => getJson<RuleEntryView>(url), enabled, staleTime: Infinity, placeholderData: keepPreviousData });
}

/** POST /api/v1/standing: one standing-rule change (StandingWriteBody). A refusal comes back as `{ ok: false, error }`. */
export async function postStanding(
  token: string,
  body: StandingWriteBody,
): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const r = await postJson<{ changed?: boolean; error?: string }>(API.standing, token, body);
  if (r.ok) return { ok: true, changed: r.value.changed === true };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/**
 * POST /api/v1/rules/verdict: a verdict with its reason, and for promote of a class (C-) the owner's wording, default
 * and exception. Promote of a proposal (P-) takes none: the server applies its current → proposed lines (a prose change:
 * it records the verdict as applied to its target, writes no file and creates a task to build it), and a failure comes
 * back as the error, with nothing written.
 */
export async function postRuleVerdict(
  token: string,
  body: { id: string; verdict: RuleVerdict; reason: string; text?: string; default?: string; exception?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  return postRules(API.ruleVerdict, token, body);
}

/** POST /api/v1/rules/edit: an applied class's new wording, default and exception; no reason, no verdict. */
export function postRuleEdit(token: string, body: { id: string; text: string; default: string; exception: string }) {
  return postRules("/api/v1/rules/edit", token, body);
}

/** POST /api/v1/rules/pushbacks/dismiss: records the pushback as noise. */
export function postPushbackDismiss(token: string, body: { id: string }) {
  return postRules("/api/v1/rules/pushbacks/dismiss", token, body);
}

/** A Rules page write: ok, or the server's refusal as `error`. */
async function postRules(url: string, token: string, body: object): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(url, token, body);
  if (r.ok) return { ok: true };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** POST /api/v1/improve/run: the queued run's ID, or the refusal with the run already queued or running (409). */
export async function postImproveRun(token: string): Promise<{ ok: true; run_id: string } | { ok: false; error: string; run_id: string | null }> {
  const r = await postJson<{ run_id?: string; error?: string }>(API.improveRun, token, {});
  if (r.ok && r.value.run_id) return { ok: true, run_id: r.value.run_id };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }), run_id: r.value.run_id ?? null };
}
