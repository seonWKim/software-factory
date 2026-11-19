// The Rules page (design 09-dashboard-app.md and 07-self-improvement.md, issue #571). GET /api/v1/rules lists the
// owner's tacit ledger entries waiting for a verdict (candidate classes `C-…` and structure proposals `P-…`, open or
// held), each with its ID, title and state, and a proposal's kind and target, read through `TacitLedger.pending` only;
// an entry the ledger judged after its pending view was built comes with that decision (`judged`), and a class not
// judged with its draft (default, exception, incidents, scope) or why the draft could not be read.
// `applied` (the Applied group) is the promoted rules file read through `TacitLedger.applied` only: its blocks and its
// encoded-elsewhere lines, null with the ledger off; `retired` the classes the ledger's retire verdicts name
// (`TacitLedger.retired`), with reason and date.
// GET /api/v1/rules/entry?id= reads one entry's detail on demand (a description, what it would change, why, where it
// applies, and each incident's ID, date, proposal, quote and root reason as `evidence`) through
// `TacitLedger.show` only; for an applied class it adds `retire`, the reasons it looks ready to retire
// (src/core/rule-retirement.ts: the rules file, the detail's incident count, the other applied rules and this repo's
// paths; no model call). The page's Suggest button reads it once per applied rule; it writes nothing. Every ledger text
// leaves through the Withholder. POST /api/v1/rules/verdict sends one verdict (promote, reject, hold or retire) with
// the owner's reason, and for promote of a class their wording, default and exception, which the plugin encodes in the
// owner's rules file before the verdict (a retire removes the class's block instead); promote of a proposal takes no
// field beyond the reason: the plugin applies the proposal's current → proposed lines (as `show` gives them) to its
// target file, then sends the verdict, all through `TacitLedger.verdict`. A proposal with no such lines (a change to
// build, 2026-11-20) has only its verdict recorded, and then one plain task is stored to build it (`tk_` + the
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
import { MAX_TASK_BODY, taskBody } from "../core/tasks.js";
import { isHotspot } from "../core/hotspots.js";
import { errorText } from "../core/log.js";
import { type RetireRule, retireSuggestions } from "../core/rule-retirement.js";
import { LiveSettings } from "../core/settings.js";
import { type AgentsHomeCheck, checkAgentsHome } from "../impl/tacit/agents-home-tacit-ledger.js";
import { LiveTacit } from "../runtime/live-tacit.js";
import type { FailureGroup, ImproveReport, UserId } from "../core/types.js";
import {
  type TacitEntryDetail, type TacitEvidence, type TacitLedger, type TacitPendingEntry, type TacitPromotion, TacitRefusal, TacitSyncFailed, hasLines,
  proposalTaskId, tacitIdKind,
} from "../interfaces/tacit-ledger.js";
import type { ApiResult } from "./api.js";
import { runNowButton } from "./improve-api.js";
import type { PauseDeps, UiPauses } from "./pause-api.js";
import { Withholder } from "./withhold.js";

export const RULES_PATH = "/api/v1/rules";
export const RULE_VERDICT_PATH = "/api/v1/rules/verdict";
export const RULE_ENTRY_PATH = "/api/v1/rules/entry";

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
  // The holder delegates no `show`, `retired` or `decided`: the page reads them from the plugin the holder last built (a failed build keeps them).
  let inUse: TacitLedger | undefined;
  const live = await LiveTacit.start(configured, async (n) => (inUse = await build(n)), o.log);
  const ledger = Object.assign(live, {
    show: async (id: string) => (await inUse?.show?.(id)) ?? null,
    retired: async () => (await inUse?.retired?.()) ?? [],
    decided: async (ids: readonly string[]) => (await inUse?.decided?.(ids)) ?? {},
  });
  const settings = new LiveSettings({ ...o, config: { ...o.config, project: { key: "", label: "" } }, integrations: [ledger] });
  return { ledger, settings, home: () => checkAgentsHome(process.env) };
}

/** The plugin the Rules page turns on. */
export const RULES_PLUGIN = "agents-home";

/** The page's user when they are the local owner, else why not; `does` names the act (`judges rules`). */
export async function ownerOf(d: PauseDeps, p: UiPauses, does: string): Promise<{ user: UserId } | { error: string }> {
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
    if (!d.tacit) return { status: 200, value: { enabled: false, entries: [], applied: null, retired: null, error: null, csrf_token: null, judge: null, home: null, turn_on: null, improve } };
    const judge = await judgeOf("turns the ledger on");
    const home = d.tacit.home();
    // The whole entry with `tacit` set to the plugin name: other integrations keep theirs, and no path goes in.
    const turnOn = judge === null && home.missing === null ? JSON.stringify({ ...d.tacit.settings.values().integrations, tacit: RULES_PLUGIN }) : null;
    const homes = await Promise.all(home.homes.map(async (h) => ({ path: await text(h.path), missing: h.missing })));
    return {
      status: 200,
      value: {
        enabled: false, entries: [], applied: null, retired: null, error: null, csrf_token: judge === null ? d.pauses!.csrfToken : null, judge,
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
  for (const e of entries) {
    const proposal = { ...(e.kind !== undefined ? { kind: await text(e.kind) } : {}), ...(e.target !== undefined ? { target: await text(e.target) } : {}) };
    const draft = e.draft === undefined ? null : {
      default: await text(e.draft.default), exception: await text(e.draft.exception),
      incidents: await Promise.all(e.draft.incidents.map(text)), scope: await text(e.draft.scope),
    };
    shown.push({
      id: await text(e.id), title: await text(e.title), state: e.state, ...proposal, judged: e.judged ?? null, draft,
      draft_error: e.draft_error === undefined ? null : await text(e.draft_error), task: await taskOf(d, e.id),
    });
  }
  return {
    status: 200,
    value: {
      enabled: true, entries: shown, applied: await readApplied(tacit, text), retired: await readRetired(tacit, text),
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

/** The report's window, counts and one row per failure group (draft and filing), each text through `text`. */
async function improveReport(r: ImproveReport, text: (v: string) => Promise<string>) {
  const opt = async (v: string | null) => (v === null || v === "" ? null : await text(v));
  const groups = [];
  // The hot files (`hotspot` rows of the patterns) show with the groups: their file, runs and filing.
  for (const g of [...r.groups, ...r.patterns.filter(isHotspot)]) {
    groups.push({
      error_code: await text(g.error_code), detail: await opt(g.detail), runs: g.run_ids.length,
      draft: await improveDraft(g, text), filing: await opt(filingText(g)),
    });
  }
  return {
    window_start: r.window_start, window_end: r.window_end, created_at: r.created_at,
    runs: r.groups.reduce((n, g) => n + g.run_ids.length, 0), patterns: r.patterns.length, groups,
  };
}

/** A group's draft: its cause and fix when drafted, else one note (withheld, failed or skipped); null with none. */
async function improveDraft(g: FailureGroup, text: (v: string) => Promise<string>) {
  const d = g.draft;
  if (!d) return null;
  if (d.status === "drafted") return { cause: await text(d.cause), fix: await text(d.fix), note: null };
  return { cause: null, fix: null, note: await text(d.status === "withheld" ? `withheld (${d.rules.join(", ")})` : `${d.status} (${d.reason})`) };
}

/** A group's filing as one line; null when not filed yet. */
function filingText(g: FailureGroup): string | null {
  const f = g.filing;
  if (!f) return null;
  switch (f.status) {
    case "filed":
    case "linked":
      return `${f.status}: ${f.ref.link || f.ref.id}`;
    case "commented":
      return `commented on ${f.ref.link || f.ref.id}: ${f.run_ids.length} new runs`;
    case "withheld":
      return `withheld (${f.rules.join(", ")})`;
    case "skipped":
    case "failed":
      return `${f.status} (${f.reason})`;
  }
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
  for (const key of ["description", "default", "exceptions", "kind", "target", "current", "proposed", "root_reason", "scope"] as const) {
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

type VerdictBody = { id: string; verdict: RuleVerdict; reason: string; rule?: TacitPromotion };

/** The rule's fields a promote of a class takes, each required there and refused anywhere else. */
const RULE_FIELDS = ["text", "default", "exception"] as const;

/** The POST body as a verdict, or why it is not one. */
function parseVerdict(body: unknown): VerdictBody | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "the body must be a JSON object";
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !["id", "verdict", "reason", ...RULE_FIELDS].includes(k));
  if (extra) return `unknown field "${extra}"`;
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
  const bad = RULE_FIELDS.find((k) => typeof b[k] !== "string" || b[k].trim() === "" || b[k].length > MAX_RULE_TEXT);
  if (bad) return `${bad} must be 1 to ${MAX_RULE_TEXT} characters`;
  const field = (k: (typeof RULE_FIELDS)[number]) => (b[k] as string).trim();
  return { ...v, rule: { wording: field("text"), default: field("default"), exception: field("exception") } };
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

/** `TacitLedger.verdict`; null when it was recorded, else the refusal or failure as the route answers it. */
async function sendVerdict(tacit: TacitLedger, v: VerdictBody): Promise<ApiResult | null> {
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
 * detail or no target is refused before any verdict runs. With Now and Proposed lines the plugin applies them and
 * sends the verdict, as before. With none (a change to build) the verdict is sent unless the ledger's newest verdict on
 * it is a promote already (a retry after a lost response), and then one plain task is stored: `tk_` + the ID in lower
 * case, the proposal's title, and a body with the rationale, change, target, evidence IDs and proposal ID. A refused
 * or failed verdict stores no task.
 */
async function promoteProposal(d: PauseDeps, p: UiPauses, tacit: TacitLedger, v: VerdictBody, user: UserId): Promise<ApiResult> {
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
  if (hasLines(detail)) {
    const failed = await sendVerdict(tacit, v);
    if (failed !== null) return failed;
    p.log.info("rule verdict sent", { id: v.id, verdict: v.verdict, actor: user, edited: false });
    return { status: 200, value: { id: v.id, verdict: v.verdict } };
  }
  const recorded = (await tacit.decided?.([v.id]))?.[v.id] === "promote";
  if (!recorded) {
    const failed = await sendVerdict(tacit, v);
    if (failed !== null) return failed;
  }
  const w = new Withholder(d.scanner);
  const text = async (s: string) => (await w.plain(s)).text;
  const title = await text(await proposalTitle(tacit, v.id, detail));
  const body = taskBody((await text(buildBody(v.id, detail))).slice(0, MAX_TASK_BODY));
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

/** The task body of a proposal to build: its rationale (root reason), change (description), target, evidence IDs and ID. */
export function buildBody(id: string, d: TacitEntryDetail): string {
  const evidence = [...new Set((d.evidence ?? []).flatMap((e) => (e.ref === undefined ? [] : [e.ref])))];
  const rationale = d.root_reason ?? d.evidence?.find((e) => e.root_reason !== undefined)?.root_reason;
  return [
    `Rationale: ${rationale ?? "not given"}`,
    `Change: ${d.description ?? "not given"}`,
    `Target: ${d.target ?? "not given"}`,
    `Evidence: ${evidence.length === 0 ? "none" : evidence.join(", ")}`,
    `Proposal: ${id}`,
  ].join("\n");
}
