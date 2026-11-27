// The Rules page (design 09-dashboard-app.md and 07-self-improvement.md, issue #571). GET /api/v1/rules lists the
// owner's tacit ledger entries waiting for a verdict (candidate classes `C-…` and structure proposals `P-…`, open or
// held), each with its ID, title and state, and a proposal's kind and target, read through `TacitLedger.pending` only;
// an entry the ledger judged after its pending view was built comes with that decision (`judged`), and a class not
// judged with its draft (default, exception, incidents, scope) or why the draft could not be read.
// `applied` (the Applied group) is the promoted rules file read through `TacitLedger.applied` only: its blocks and its
// encoded-elsewhere lines, null with the ledger off; `retired` the classes the ledger's retire verdicts name
// (`TacitLedger.retired`), with reason and date.
// GET /api/v1/rules/entry?id= reads one entry's detail on demand (a description, what it would change, a proposal's
// prose `change`, why, where it applies, and each incident's ID, date, proposal, quote and root reason as `evidence`) through
// `TacitLedger.show` only; for an applied class it adds `retire`, the reasons it looks ready to retire
// (src/core/rule-retirement.ts: the rules file, the detail's incident count, the other applied rules and this repo's
// paths; no model call). The page's Suggest button reads it once per applied rule; it writes nothing. Every ledger text
// leaves through the Withholder. POST /api/v1/rules/verdict sends one verdict (promote, reject, hold or retire) with
// the owner's reason, and for promote of a class their wording, default and exception, which the plugin encodes in the
// owner's rules file before the verdict (a retire removes the class's block instead); promote of a proposal takes no
// field beyond the reason: the plugin applies the proposal's current → proposed lines (as `show` gives them) to its
// target file, then sends the verdict (a prose change: the verdict only, applied to its target), all through
// `TacitLedger.verdict`. After a prose change's verdict one plain task is stored to build it (2026-11-20: `tk_` + the
// proposal ID in lower case, its title, and a body with the rationale, change, target, evidence IDs and proposal ID):
// the store's one write from this page. A retry finds that task, or the ledger's promote verdict, and sends nothing
// twice. GET lists each proposal's task ID once it exists (`task`), and the entry read gives `cited`, the newest
// ledger verdict of each evidence ID that has one. The request guards
// (Host, Origin, Content-Type, CSRF token, body size, JSON) run in server.ts; then the owner check (decision 1 of #571:
// the store's local owner only); every refusal comes before the ledger's CLI runs.
//
// The ledger is the UI's live holder (design 08-settings, 2026-11-12): each request first refreshes the UI's settings,
// so a changed `integrations` entry takes effect here with no restart. With the ledger off, GET also says where the
// agents home is and which CLI is missing there, each known home (AGENTS_HOME when set, ~/.agents) with its own check
// for the page's picker, and gives the owner the `integrations` value that turns the ledger on (the plugin name only:
// no home path is stored); the page writes it through POST /api/v1/settings, whose guards and owner check run as for
// any setting.
//
// `improve` (design 07-self-improvement, 2026-11-16) carries the latest improve report, every text through
// the Withholder, and `run_now`: whether the viewer may run one now
// (improve-api.ts runNowButton, approve_spec), with the token Run now sends to POST /api/v1/improve/run. It is there
// with the ledger on or off.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RULE_VERDICTS, type RuleVerdict } from "../core/learned-rules.js";
import type { SkillVerdict } from "../core/skill-improve.js";
import { isHotspot } from "../core/hotspots.js";
import { errorText } from "../core/log.js";
import { type RetireRule, retireSuggestions } from "../core/rule-retirement.js";
import { LiveSettings } from "../core/settings.js";
import { type AgentsHomeCheck, checkAgentsHome } from "../impl/tacit/agents-home-tacit-ledger.js";
import { LiveTacit } from "../runtime/live-tacit.js";
import type { AskRow, ProposalRow } from "../core/owner-asks.js";
import type { FailureGroup, ImproveReport, UserId } from "../core/types.js";
import {
  type TacitEntryDetail, type TacitEvidence, type TacitLedger, type TacitPendingEntry, type TacitPromotion, TacitRefusal, TacitSyncFailed,
  type TacitVerdictRecord, proposalTaskId, tacitIdKind,
} from "../interfaces/tacit-ledger.js";
import type { ApiResult } from "./api.js";
import { runNowButton } from "./improve-api.js";
import type { PauseDeps, UiPauses } from "./pause-api.js";
import { type Excerpt, previewOf } from "./rules-preview.js";
import { type VerdictBody, promoteProposal, sendVerdict } from "./rules-promote.js";
import { Withholder } from "./withhold.js";

export const RULES_PATH = "/api/v1/rules";
export const RULE_VERDICT_PATH = "/api/v1/rules/verdict";
export const RULE_ENTRY_PATH = "/api/v1/rules/entry";
export const RULE_EDIT_PATH = "/api/v1/rules/edit";
export const PUSHBACK_DISMISS_PATH = "/api/v1/rules/pushbacks/dismiss";
export const SKILL_VERDICT_PATH = "/api/v1/rules/skill-verdict";

/** The longest reason and rule text (each of wording, default and exception) a verdict takes. */
export const MAX_REASON = 1000;
export const MAX_RULE_TEXT = 2000;

/** The Rules page's tacit ledger as the UI process holds it (design 08-settings, 2026-11-12). */
export interface UiTacit {
  /** The live holder (src/runtime/live-tacit.ts): the plugin the `integrations` entry, else config, names. */
  ledger: TacitLedger;
  /** The UI's settings: refreshed before each Rules request, which rebuilds `ledger` when the entry changed. */
  settings: { refresh(): Promise<void>; values(): { integrations: Readonly<Record<string, string>> } };
  /**
   * The agents home (AGENTS_HOME, else ~/.agents) and the first CLI missing there, or null when both are executable;
   * `homes`, each known home with its own check.
   */
  home(): AgentsHomeCheck & { homes: readonly AgentsHomeCheck[] };
}

type LiveOpts = ConstructorParameters<typeof LiveSettings>[0];

/**
 * The UI's ledger (compose.ts buildUiParts): a live holder that starts with `configured` (`plugins.tacit`), and its own
 * LiveSettings on the store, whose refresh before each Rules request switches it. That LiveSettings reads only
 * `integrations`, a global key, so its config names no project. The home is this process's.
 */
export async function uiTacit(
  configured: string,
  build: (name: string) => Promise<TacitLedger>,
  o: Omit<LiveOpts, "integrations" | "config"> & { config: Omit<LiveOpts["config"], "project"> },
): Promise<UiTacit> {
  // The holder delegates no `show`, `retired`, `decided`, `edit`, `pushbacks`, `dismiss` or `verdictRecord`: the page reaches them on the
  // plugin the holder last built (a failed build keeps it). `pushbacks` is there only while that plugin has it, so a
  // plugin without it shows no Pushbacks list.
  let inUse: TacitLedger | undefined;
  const live = await LiveTacit.start(configured, async (n) => (inUse = await build(n)), o.log);
  const missing = (what: string) => new TacitRefusal(`this rules plugin cannot ${what}`);
  const ledger: typeof live & TacitLedger = Object.assign(live, {
    show: async (id: string) => (await inUse?.show?.(id)) ?? null,
    retired: async () => (await inUse?.retired?.()) ?? [],
    decided: async (ids: readonly string[]) => (await inUse?.decided?.(ids)) ?? {},
    edit: async (id: string, rule: TacitPromotion) => { if (!inUse?.edit) throw missing("edit a rule"); await inUse.edit(id, rule); },
    dismiss: async (id: string) => { if (!inUse?.dismiss) throw missing("dismiss a pushback"); await inUse.dismiss(id); },
    verdictRecord: async (v: TacitVerdictRecord) => inUse?.verdictRecord?.(v), // a skill verdict's hand-off (design 07-self-improvement)
  });
  Object.defineProperty(ledger, "pushbacks", { get: () => inUse?.pushbacks?.bind(inUse) });
  const settings = new LiveSettings({ ...o, config: { ...o.config, project: { key: "", label: "" } }, integrations: [ledger] });
  return { ledger, settings, home: () => checkAgentsHome(process.env) };
}

/** The plugin the Rules page turns on. */
export const RULES_PLUGIN = "agents-home";

/** The page's user when they are the local owner, else why not; `does` names the act (`judges rules`). */
export async function ownerOf(d: Pick<PauseDeps, "store">, p: UiPauses, does: string): Promise<{ user: UserId } | { error: string }> {
  const user = await p.principal();
  if (user === null) return { error: "No factory user acts from this page: link your local account or set cli_user." };
  // The owner check first (as every check): a solo store's first local identity becomes its owner there.
  const decision = await p.authorize(user);
  if (!decision.allow) return { error: `Only the owner ${does}: ${decision.reason}.` };
  if ((await d.store.getOwner()) !== user) return { error: `Only the owner ${does}; you are ${user}.` };
  return { user };
}

/** GET /api/v1/rules. Every ledger text leaves through the Withholder (G5, `ui`). */
export async function readRules(d: PauseDeps): Promise<ApiResult> {
  await d.tacit?.settings.refresh();
  const tacit = d.tacit?.ledger;
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const improve = await readImprove(d, text);
  const judgeOf = async (does: string) => {
    const who = d.pauses ? await ownerOf(d, d.pauses, does) : { error: "The page has no owner check: verdicts are off." };
    return "error" in who ? await text(who.error) : null;
  };
  if (!tacit?.enabled) {
    if (!d.tacit) return { status: 200, value: { enabled: false, entries: [], applied: null, retired: null, pushbacks: null, error: null, csrf_token: null, judge: null, home: null, turn_on: null, improve } };
    const judge = await judgeOf("turns the ledger on");
    const home = d.tacit.home();
    // The whole entry with `tacit` set to the plugin name: other integrations keep theirs, and no path goes in.
    const turnOn = judge === null && home.missing === null ? JSON.stringify({ ...d.tacit.settings.values().integrations, tacit: RULES_PLUGIN }) : null;
    const homes = await Promise.all(home.homes.map(async (h) => ({ path: await text(h.path), missing: h.missing })));
    return {
      status: 200,
      value: {
        enabled: false, entries: [], applied: null, retired: null, pushbacks: null, error: null, csrf_token: judge === null ? d.pauses!.csrfToken : null, judge,
        home: { path: await text(home.path), missing: home.missing, homes }, turn_on: turnOn, improve,
      },
    };
  }
  const judge = await judgeOf("judges rules");
  let entries: readonly TacitPendingEntry[] = [];
  let error: string | null = null;
  try {
    entries = await tacit.pending();
  } catch (err) {
    error = `The ledger could not be read: ${errorText(err)}`;
  }
  const shown = [];
  const excerpts: Record<string, Excerpt> = {};
  for (const e of entries) {
    const proposal = { ...(e.kind !== undefined ? { kind: await text(e.kind) } : {}), ...(e.target !== undefined ? { target: await text(e.target) } : {}) };
    const draft = e.draft === undefined ? null : {
      default: await text(e.draft.default), exception: await text(e.draft.exception),
      incidents: await Promise.all(e.draft.incidents.map(text)), scope: await text(e.draft.scope),
    };
    let gist: string | null = null;
    if ((e.judged ?? null) === null && tacitIdKind(e.id) === "proposal") {
      const p = await previewOf(tacit, e.id, text);
      if (p.excerpt !== null) excerpts[await text(e.id)] = p.excerpt;
      gist = p.gist;
    }
    shown.push({
      id: await text(e.id), title: await text(e.title), state: e.state, ...proposal, judged: e.judged ?? null, gist, draft,
      draft_error: e.draft_error === undefined ? null : await text(e.draft_error), task: await taskOf(d, e.id),
    });
  }
  return {
    status: 200,
    value: {
      enabled: true, entries: shown, excerpts, applied: await readApplied(tacit, text), retired: await readRetired(tacit, text), pushbacks: await readPushbacks(tacit, text),
      error: error === null ? null : await text(error), csrf_token: d.pauses?.csrfToken ?? null, judge, home: null, turn_on: null, improve,
    },
  };
}

/** The ID of the task a promote of proposal `id` created, or null: none yet, or `id` is no proposal. A store read. */
async function taskOf(d: PauseDeps, id: string): Promise<string | null> {
  const task = tacitIdKind(id) === "proposal" ? proposalTaskId(id) : null;
  return task !== null && (await d.store.getTask(task)) !== null ? task : null;
}

/**
 * The `improve` field: the latest improve report (null: none yet) and whether the viewer may run one now, with the
 * write routes' token when they may (null otherwise). Store reads only.
 */
async function readImprove(d: PauseDeps, text: (v: string) => Promise<string>) {
  const report = await d.store.getLatestImproveReport();
  const button = await runNowButton(d);
  return { report: report === null ? null : await improveReport(report, text), run_now: button !== null, csrf_token: button?.csrfToken ?? null };
}

/**
 * The report's window, counts and one row per failure group (draft and filing); its top ask reasons (count and the
 * share of the answered ones approved unchanged, null with none answered) and its standing approval proposals as
 * text (design 07-improve-report). Each text through `text`.
 */
async function improveReport(r: ImproveReport, text: (v: string) => Promise<string>) {
  const opt = async (v: string | null) => (v === null || v === "" ? null : await text(v));
  const groups = [];
  // The hot files (`hotspot` rows of the patterns) show with the groups: their file, runs and filing.
  for (const g of [...r.groups, ...r.patterns.filter(isHotspot)]) {
    groups.push({
      error_code: await text(g.error_code), detail: await opt(g.detail), runs: g.run_ids.length, hotspot: isHotspot(g),
      draft: await improveDraft(g, text), filing: await improveFiling(g, text),
    });
  }
  const asks = [];
  for (const a of r.patterns.filter(isAskRow)) {
    asks.push({ reason: await text(a.detail), asks: a.asks, answered: a.answered, share_unchanged: a.answered === 0 ? null : a.approved_unchanged / a.answered });
  }
  const proposals = [];
  for (const p of r.patterns.filter(isProposalRow)) proposals.push({ reason: await text(p.detail), run_length: p.run_length, text: await text(p.text) });
  const failures = r.patterns.filter((g) => !isAskRow(g) && !isProposalRow(g));
  return {
    window_start: r.window_start, window_end: r.window_end, created_at: r.created_at,
    runs: r.groups.reduce((n, g) => n + g.run_ids.length, 0), patterns: failures.length, groups, asks, proposals,
  };
}

// The owner's ask rows of a report (src/core/owner-asks.ts), by their codes: a type import only, so the route adds no runtime import.
const isAskRow = (g: FailureGroup): g is AskRow => g.error_code === ("owner_ask" satisfies AskRow["error_code"]);
const isProposalRow = (g: FailureGroup): g is ProposalRow => g.error_code === ("ask_proposal" satisfies ProposalRow["error_code"]);

/** A group's draft: its cause and fix when drafted, else one note `{ status, reason }` (reason `withheld` for a withheld one); null with none. */
async function improveDraft(g: FailureGroup, text: (v: string) => Promise<string>) {
  const d = g.draft;
  if (!d) return null;
  if (d.status === "drafted") return { cause: await text(d.cause), fix: await text(d.fix), note: null };
  return { cause: null, fix: null, note: { status: d.status, reason: d.status === "withheld" ? "withheld" : await text(d.reason) } };
}

/**
 * A group's filing as `{ status, reason, ref, runs }`, null when not filed yet: `reason` the stored code of a skipped or
 * failed filing (`withheld` for a withheld one), else null; `ref` the item's link or ID; `runs` the new runs a comment named.
 */
async function improveFiling(g: FailureGroup, text: (v: string) => Promise<string>) {
  const f = g.filing;
  if (!f) return null;
  const ref = "ref" in f ? await text(f.ref.link || f.ref.id) : null;
  const runs = f.status === "commented" ? f.run_ids.length : null;
  const reason = f.status === "skipped" || f.status === "failed" ? await text(f.reason) : f.status === "withheld" ? "withheld" : null;
  return { status: f.status, reason, ref, runs };
}

/** The retired classes, newest first, each text through the Withholder; a failed read gives none. */
async function readRetired(tacit: TacitLedger, text: (v: string) => Promise<string>) {
  try {
    const retired = (await tacit.retired?.()) ?? [];
    return await Promise.all(retired.map(async (r) => ({ id: await text(r.id), reason: await text(r.reason), date: r.date })));
  } catch {
    return [];
  }
}

/**
 * The active unclustered pushbacks, each text through the Withholder: `{ rows, error }`, `error` a failed read (no
 * rows then); null when the ledger has no `pushbacks`, so the page shows no Pushbacks list.
 */
async function readPushbacks(tacit: TacitLedger, text: (v: string) => Promise<string>) {
  const list = tacit.pushbacks;
  if (list === undefined) return null;
  try {
    const rows = await list.call(tacit);
    return { rows: await Promise.all(rows.map(async (r) => ({ id: await text(r.id), pushback: await text(r.pushback), date: r.date ?? null }))), error: null };
  } catch (err) {
    return { rows: [], error: await text(`The pushbacks could not be read: ${errorText(err)}`) };
  }
}

/** This checkout: the repo whose paths the gone-from-the-repo signal checks (src/ui → the root, as the app's dist is found). */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Why the applied class `id` looks ready to retire (src/core/rule-retirement.ts), or null when it is no applied rule.
 * Reads only: the rules file through `TacitLedger.applied`, the class's incident count from `detail`, this repo's paths.
 */
async function retireReasons(tacit: TacitLedger, id: string, detail: TacitEntryDetail | null, now: Date): Promise<string[] | null> {
  const applied: RetireRule[] = [];
  for (const r of (await tacit.applied?.())?.rules ?? []) {
    if (r.id !== undefined && r.default !== undefined) applied.push({ ...r, id: r.id, default: r.default });
  }
  const rule = applied.find((r) => r.id === id);
  if (rule === undefined) return null;
  return retireSuggestions(rule, {
    applied, now, exists: (p) => existsSync(join(REPO_ROOT, p)), ...(detail?.incidents !== undefined ? { incidents: detail.incidents } : {}),
  });
}

/** The rules file's blocks and encoded-elsewhere lines, each text through the Withholder; a failed read gives none (the entries stay). */
async function readApplied(tacit: TacitLedger, text: (v: string) => Promise<string>) {
  const opt = async (v: string | undefined) => (v === undefined ? null : await text(v));
  try {
    const a = (await tacit.applied?.()) ?? { rules: [], elsewhere: [] };
    const rules = [];
    for (const r of a.rules) {
      rules.push({
        id: await opt(r.id), name: await opt(r.name), default: await opt(r.default), exceptions: await opt(r.exceptions), scope: await opt(r.scope),
        incidents: r.incidents === undefined ? null : await Promise.all(r.incidents.map(text)), judged: await opt(r.judged), raw: await opt(r.raw),
      });
    }
    return { rules, elsewhere: await Promise.all(a.elsewhere.map(text)) };
  } catch {
    return { rules: [], elsewhere: [] };
  }
}

/** One incident of the detail with each of its texts through the Withholder; a part it lacks stays absent. */
async function withheld(e: TacitEvidence, text: (v: string) => Promise<string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of ["ref", "date", "proposal", "quote", "root_reason"] as const) {
    const v = e[key];
    if (v !== undefined) out[key] = await text(v);
  }
  return out;
}

/**
 * GET /api/v1/rules/entry?id=: one entry's detail through `TacitLedger.show`, each text through the Withholder. 400
 * for an ID that is neither `C-` nor `P-`, before the ledger runs. `detail` is null when the ledger is off, has no
 * `show` or prints nothing; `error` is a failed read. `retire` is an applied class's retire suggestions ([] for none),
 * null for any other entry or a failed read of the rules file. Anyone who may read the list may read the detail.
 */
export async function readRuleEntry(d: PauseDeps, rawId: string | null): Promise<ApiResult> {
  const id = rawId?.trim() ?? "";
  if (tacitIdKind(id) === null) return { status: 400, value: { error: "id must be a class (C-) or proposal (P-) ID" } };
  await d.tacit?.settings.refresh();
  const tacit = d.tacit?.ledger;
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  let detail: TacitEntryDetail | null = null;
  let error: string | null = null;
  try {
    detail = tacit?.enabled && tacit.show ? await tacit.show(id) : null;
  } catch (err) {
    error = `The detail could not be read: ${errorText(err)}`;
  }
  let retire: string[] | null = null;
  try {
    retire = tacit?.enabled && tacitIdKind(id) === "class" ? await retireReasons(tacit, id, detail, d.clock.now()) : null;
  } catch {
    // No suggestion when the rules file cannot be read: the detail stays.
  }
  const reasons = retire === null ? null : await Promise.all(retire.map(text));
  if (detail === null) return { status: 200, value: { id: await text(id), detail: null, error: error === null ? null : await text(error), retire: reasons } };
  const shown: Record<string, unknown> = { id: await text(detail.id) };
  for (const key of ["description", "default", "exceptions", "kind", "target", "current", "proposed", "change", "root_reason", "scope"] as const) {
    const v = detail[key];
    if (v !== undefined) shown[key] = await text(v);
  }
  if (detail.incidents !== undefined) shown.incidents = detail.incidents;
  if (detail.evidence !== undefined) shown.evidence = await Promise.all(detail.evidence.map((e) => withheld(e, text)));
  return { status: 200, value: { id: shown.id, detail: shown, error: null, retire: reasons, cited: await citedVerdicts(tacit!, detail, text) } };
}

/** The newest ledger verdict of each evidence ID that has one (`TacitLedger.decided`); none on a failed read. */
async function citedVerdicts(tacit: TacitLedger, detail: TacitEntryDetail, text: (v: string) => Promise<string>): Promise<Record<string, string>> {
  const refs = [...new Set((detail.evidence ?? []).flatMap((e) => (e.ref === undefined ? [] : [e.ref])))];
  let decided: Readonly<Record<string, string>> = {};
  try {
    decided = refs.length === 0 ? {} : ((await tacit.decided?.(refs)) ?? {});
  } catch {
    // No status when the verdict log cannot be read: the detail stays.
  }
  const out: Record<string, string> = {};
  for (const [id, decision] of Object.entries(decided)) out[await text(id)] = await text(decision);
  return out;
}


/** The rule's fields a promote of a class takes, each required there and refused anywhere else. */
const RULE_FIELDS = ["text", "default", "exception"] as const;

/** The POST body as a verdict, or why it is not one. */
function parseVerdict(body: unknown): VerdictBody | string {
  const b = bodyOf(body, ["id", "verdict", "reason", ...RULE_FIELDS]);
  if (typeof b === "string") return b;
  if (typeof b.id !== "string" || b.id.trim() === "") return "id must be a non-empty string";
  if (!RULE_VERDICTS.includes(b.verdict as RuleVerdict)) return `verdict must be one of ${RULE_VERDICTS.join(", ")}`;
  if (typeof b.reason !== "string" || b.reason.trim() === "" || b.reason.length > MAX_REASON) return `reason must be 1 to ${MAX_REASON} characters`;
  const v = { id: b.id.trim(), verdict: b.verdict as RuleVerdict, reason: b.reason.trim() };
  if (v.verdict === "retire" && tacitIdKind(v.id) !== "class") return "only a class (C-) is retired";
  if (v.verdict === "promote" && tacitIdKind(v.id) === "proposal" && proposalTaskId(v.id) === null) {
    return "a proposal ID to promote is P- followed by letters, digits, - or _ only";
  }
  if (v.verdict !== "promote" || tacitIdKind(v.id) !== "class") {
    const given = RULE_FIELDS.find((k) => b[k] !== undefined);
    return given ? `only promote of a class (C-) takes a ${given}` : v;
  }
  const rule = ruleOf(b);
  return typeof rule === "string" ? rule : { ...v, rule };
}

/** The rule's three fields of a body (promote of a class, or an edit), each 1 to MAX_RULE_TEXT characters, or why not. */
function ruleOf(b: Record<string, unknown>): TacitPromotion | string {
  const bad = RULE_FIELDS.find((k) => typeof b[k] !== "string" || b[k].trim() === "" || b[k].length > MAX_RULE_TEXT);
  if (bad) return `${bad} must be 1 to ${MAX_RULE_TEXT} characters`;
  const field = (k: (typeof RULE_FIELDS)[number]) => (b[k] as string).trim();
  return { wording: field("text"), default: field("default"), exception: field("exception") };
}

/** A POST body as an object with only `keys`, or why it is not one. */
function bodyOf(body: unknown, keys: readonly string[]): Record<string, unknown> | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "the body must be a JSON object";
  const extra = Object.keys(body).find((k) => !keys.includes(k));
  return extra ? `unknown field "${extra}"` : (body as Record<string, unknown>);
}

/**
 * POST /api/v1/rules/verdict with `{ id, verdict, reason, text?, default?, exception? }` (the three rule fields required
 * on promote of a class and refused on anything else; promote of a proposal and retire of a class take none), after the
 * request guards: 400 for a body that is not one, 409 with no ledger or when the ledger refuses a promote or retire
 * before writing anything (a proposal whose current lines are not in its target exactly once), 403 for anyone but the
 * owner, 502 when the ledger's CLI fails, with its error and any file it wrote put back (or the verdict was recorded but
 * sync-agents failed); else 200.
 */
export async function writeRuleVerdict(d: PauseDeps, p: UiPauses, body: unknown): Promise<ApiResult> {
  const v = parseVerdict(body);
  if (typeof v === "string") return { status: 400, value: { error: v } };
  await d.tacit?.settings.refresh();
  const tacit = d.tacit?.ledger;
  if (!tacit?.enabled) return { status: 409, value: { error: "No tacit ledger is on: turn it on from the Rules page." } };
  const who = await ownerOf(d, p, "judges rules");
  if ("error" in who) return { status: 403, value: { error: who.error } };
  if (v.verdict === "promote" && tacitIdKind(v.id) === "proposal") return promoteProposal(d, p, tacit, v, who.user);
  // The owner's rule goes with a promoted class; the CLIs take no "by", so the log keeps who judged.
  const failed = await sendVerdict(tacit, v);
  if (failed !== null) return failed;
  p.log.info("rule verdict sent", { id: v.id, verdict: v.verdict, actor: who.user, edited: v.rule !== undefined });
  return { status: 200, value: { id: v.id, verdict: v.verdict } };
}

/**
 * The ledger for a rules write, with the owner check, or the answer that refuses it: 409 with no ledger or one without
 * the method `has` names, 403 for anyone but the owner. Every refusal comes before the ledger's CLI runs.
 */
async function ownerLedger(d: PauseDeps, p: UiPauses, has: "edit" | "dismiss", does: string): Promise<{ tacit: TacitLedger; user: UserId } | ApiResult> {
  await d.tacit?.settings.refresh();
  const tacit = d.tacit?.ledger;
  if (!tacit?.enabled) return { status: 409, value: { error: "No tacit ledger is on: turn it on from the Rules page." } };
  if (tacit[has] === undefined) return { status: 409, value: { error: `This rules plugin cannot ${has === "edit" ? "edit a rule" : "dismiss a pushback"}.` } };
  const who = await ownerOf(d, p, does);
  if ("error" in who) return { status: 403, value: { error: who.error } };
  return { tacit, user: who.user };
}

/**
 * POST /api/v1/rules/edit with `{ id, text, default, exception }`, after the request guards: 400 for an ID that is not
 * a class or a bad field (each 1 to 2000 characters), 409 with no ledger or when the plugin refuses with nothing
 * written (no block for the ID, a failed check), 403 for anyone but the owner, 502 when the write failed (the file put
 * back) or the rule was saved but sync-agents failed; else 200. No verdict is sent and no reason taken.
 */
export async function writeRuleEdit(d: PauseDeps, p: UiPauses, body: unknown): Promise<ApiResult> {
  const b = bodyOf(body, ["id", ...RULE_FIELDS]);
  if (typeof b === "string") return { status: 400, value: { error: b } };
  const id = typeof b.id === "string" ? b.id.trim() : "";
  if (tacitIdKind(id) !== "class") return { status: 400, value: { error: "id must be a class (C-) ID" } };
  const rule = ruleOf(b);
  if (typeof rule === "string") return { status: 400, value: { error: rule } };
  const own = await ownerLedger(d, p, "edit", "edits rules");
  if (!("tacit" in own)) return own;
  try {
    await own.tacit.edit!(id, rule);
  } catch (err) {
    if (err instanceof TacitRefusal) return { status: 409, value: { error: `The edit was refused: ${errorText(err)}` } };
    if (err instanceof TacitSyncFailed) return { status: 502, value: { error: `The rule was saved, but sync-agents failed: ${errorText(err)}` } };
    return { status: 502, value: { error: `The rule could not be saved: ${errorText(err)}` } };
  }
  p.log.info("rule edited", { id, actor: own.user });
  return { status: 200, value: { id } };
}

/**
 * POST /api/v1/rules/pushbacks/dismiss with `{ id }` (a `T-` ID), after the request guards: 400 for any other body,
 * 409 with no ledger or one that cannot dismiss, 403 for anyone but the owner, 502 when the ledger's CLI fails; else
 * 200. The ledger records the pushback as noise.
 */
export async function writePushbackDismiss(d: PauseDeps, p: UiPauses, body: unknown): Promise<ApiResult> {
  const b = bodyOf(body, ["id"]);
  if (typeof b === "string") return { status: 400, value: { error: b } };
  const id = typeof b.id === "string" ? b.id.trim() : "";
  if (!/^T-[0-9A-Za-z_-]+$/.test(id)) return { status: 400, value: { error: "id must be a pushback (T-) ID" } };
  const own = await ownerLedger(d, p, "dismiss", "dismisses pushbacks");
  if (!("tacit" in own)) return own;
  try {
    await own.tacit.dismiss!(id);
  } catch (err) {
    if (err instanceof TacitRefusal) return { status: 409, value: { error: `The dismiss was refused: ${errorText(err)}` } };
    return { status: 502, value: { error: `The pushback could not be dismissed: ${errorText(err)}` } };
  }
  p.log.info("pushback dismissed", { id, actor: own.user });
  return { status: 200, value: { id } };
}

/** The verdicts a skill draft takes (src/core/skill-improve.ts). */
const SKILL_VERDICTS = ["promote", "hold", "reject"] as const;

/** The POST body as a skill verdict, or why it is not one. */
function skillVerdictOf(body: unknown): { id: string; verdict: (typeof SKILL_VERDICTS)[number] } | string {
  const b = bodyOf(body, ["id", "verdict"]);
  if (typeof b === "string") return b;
  if (typeof b.id !== "string" || b.id.trim() === "") return "id must be a skill draft ID";
  const verdict = SKILL_VERDICTS.find((x) => x === b.verdict);
  return verdict ? { id: b.id.trim(), verdict } : `verdict must be one of ${SKILL_VERDICTS.join(", ")}`;
}

/** What a skill verdict reads: the store, the configured project, for Promote the skill wiring, and the owner's ledger. */
export type SkillVerdictDeps = Pick<PauseDeps, "store" | "settings" | "skillImprove" | "tacit">;

/**
 * One verdict on a skill draft (design 09-dashboard-rules-waiting): POST /api/v1/rules/skill-verdict with `{ id, verdict }`
 * after the request guards, and `factory improve skill <id> <verdict>`, so both give the same result. 400 for a bad body,
 * 403 for anyone but the owner and 404 for no draft of the configured project (nothing written), 409 with the core's
 * reason when it refuses (another state, a skill outside capabilities.skill_folders) or Promote has no skill wiring;
 * else 200 with the draft's state. Promote re-runs the skill's suite before it answers.
 */
export async function writeSkillVerdict(d: SkillVerdictDeps, p: UiPauses, body: unknown): Promise<ApiResult> {
  const v = skillVerdictOf(body);
  if (typeof v === "string") return { status: 400, value: { error: v } };
  const who = await ownerOf(d, p, "judges skill changes");
  if ("error" in who) return { status: 403, value: { error: who.error } };
  const draft = await d.store.getSkillDraft(v.id);
  const project = d.settings ? await d.settings.resolveProject() : null;
  if (!draft || project === null || draft.project_key !== project.key) return { status: 404, value: { error: "No such skill draft in this project." } };
  const s = d.skillImprove;
  if (!s) return { status: 409, value: { error: "Skill verdicts are not wired in this process: nothing written" } };
  await d.tacit?.settings.refresh(); // an accepted verdict also goes to the owner's ledger when it is on; a failure is only logged
  const ledger = d.tacit ? { tacit: d.tacit.ledger, log: p.log } : undefined;
  const r: SkillVerdict = v.verdict === "hold" ? await s.hold(d.store, v.id, ledger)
    : v.verdict === "reject" ? await s.reject(d.store, v.id, ledger)
    : s.wiring ? await s.promote({ store: d.store, wiring: s.wiring, signal: new AbortController().signal }, v.id, who.user, ledger)
    : { refused: "Promote needs capabilities.skill_folders and a model: no skill is wired here, nothing written" };
  if ("refused" in r) return { status: 409, value: { error: r.refused } };
  p.log.info("skill verdict", { id: v.id, verdict: v.verdict, actor: who.user, state: r.draft.state });
  return { status: 200, value: { id: v.id, state: r.draft.state } };
}

/** The Rules page's write routes by path (server.ts): each behind the write guards, then its own owner check. */
export const RULE_WRITES: Readonly<Record<string, (d: PauseDeps, p: UiPauses, body: unknown) => Promise<ApiResult>>> = {
  [RULE_VERDICT_PATH]: writeRuleVerdict,
  [RULE_EDIT_PATH]: writeRuleEdit,
  [PUSHBACK_DISMISS_PATH]: writePushbackDismiss,
  [SKILL_VERDICT_PATH]: writeSkillVerdict,
};
