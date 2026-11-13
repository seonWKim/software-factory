// The Rules page (design 09-dashboard-app.md and 07-self-improvement.md, issue #571). GET /api/v1/rules lists the
// owner's tacit ledger entries waiting for a verdict (candidate classes `C-…` and structure proposals `P-…`, open or
// held), each with its ID, title and state, and a proposal's kind and target, read through `TacitLedger.pending` only;
// an entry the ledger judged after its pending view was built comes with that decision (`judged`), and a class not
// judged with its draft (default, exception, incidents, scope) or why the draft could not be read.
// `applied` (the Applied group) is the promoted rules file read through `TacitLedger.applied` only: its blocks and its
// encoded-elsewhere lines, null with the ledger off; `retired` the classes the ledger's retire verdicts name
// (`TacitLedger.retired`), with reason and date.
// GET /api/v1/rules/entry?id= reads one entry's detail on demand (what it would change, why, where it applies) through
// `TacitLedger.show` only; for an applied class it adds `retire`, the reasons it looks ready to retire
// (src/core/rule-retirement.ts: the rules file, the detail's incident count, the other applied rules and this repo's
// paths; no model call). The page's Suggest button reads it once per applied rule; it writes nothing. Every ledger text
// leaves through the Withholder. POST /api/v1/rules/verdict sends one verdict (promote, reject, hold or retire) with
// the owner's reason, and for promote of a class their wording, default and exception, which the plugin encodes in the
// owner's rules file before the verdict (a retire removes the class's block instead), through `TacitLedger.verdict`
// only: the page has no other write path and writes nothing to the store. The request guards
// (Host, Origin, Content-Type, CSRF token, body size, JSON) run in server.ts; then the owner check (decision 1 of #571:
// the store's local owner only); every refusal comes before the ledger's CLI runs.
//
// The ledger is the UI's live holder (design 08-settings, 2026-11-12): each request first refreshes the UI's settings,
// so a changed `integrations` entry takes effect here with no restart. With the ledger off, GET also says where the
// agents home is and which CLI is missing there, and gives the owner the `integrations` value that turns the ledger
// on; the page writes it through POST /api/v1/settings, whose guards and owner check run as for any setting.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RULE_VERDICTS, type RuleVerdict } from "../core/learned-rules.js";
import { errorText } from "../core/log.js";
import { type RetireRule, retireSuggestions } from "../core/rule-retirement.js";
import { LiveSettings } from "../core/settings.js";
import { checkAgentsHome } from "../impl/tacit/agents-home-tacit-ledger.js";
import { LiveTacit } from "../runtime/live-tacit.js";
import type { UserId } from "../core/types.js";
import {
  type TacitEntryDetail, type TacitLedger, type TacitPendingEntry, type TacitPromotion, TacitRefusal, TacitSyncFailed, tacitIdKind,
} from "../interfaces/tacit-ledger.js";
import type { ApiResult } from "./api.js";
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
  /** The agents home (AGENTS_HOME, else ~/.agents) and the first CLI missing there, or null when both are executable. */
  home(): { path: string; missing: string | null };
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
  // The holder delegates no `show` or `retired`: the page reads them from the plugin the holder last built (a failed build keeps both).
  let inUse: TacitLedger | undefined;
  const live = await LiveTacit.start(configured, async (n) => (inUse = await build(n)), o.log);
  const ledger = Object.assign(live, {
    show: async (id: string) => (await inUse?.show?.(id)) ?? null,
    retired: async () => (await inUse?.retired?.()) ?? [],
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
  const judgeOf = async (does: string) => {
    const who = d.pauses ? await ownerOf(d, d.pauses, does) : { error: "The page has no owner check: verdicts are off." };
    return "error" in who ? await text(who.error) : null;
  };
  if (!tacit?.enabled) {
    if (!d.tacit) return { status: 200, value: { enabled: false, entries: [], applied: null, retired: null, error: null, csrf_token: null, judge: null, home: null, turn_on: null } };
    const judge = await judgeOf("turns the ledger on");
    const home = d.tacit.home();
    // The whole entry with `tacit` set: other integrations keep theirs.
    const turnOn = judge === null && home.missing === null ? JSON.stringify({ ...d.tacit.settings.values().integrations, tacit: RULES_PLUGIN }) : null;
    return {
      status: 200,
      value: {
        enabled: false, entries: [], applied: null, retired: null, error: null, csrf_token: judge === null ? d.pauses!.csrfToken : null, judge,
        home: { path: await text(home.path), missing: home.missing }, turn_on: turnOn,
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
      draft_error: e.draft_error === undefined ? null : await text(e.draft_error),
    });
  }
  return {
    status: 200,
    value: {
      enabled: true, entries: shown, applied: await readApplied(tacit, text), retired: await readRetired(tacit, text),
      error: error === null ? null : await text(error), csrf_token: d.pauses?.csrfToken ?? null, judge, home: null, turn_on: null,
    },
  };
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
  for (const key of ["default", "exceptions", "kind", "target", "root_reason", "scope"] as const) {
    const v = detail[key];
    if (v !== undefined) shown[key] = await text(v);
  }
  if (detail.incidents !== undefined) shown.incidents = detail.incidents;
  if (detail.quotes !== undefined) shown.quotes = await Promise.all(detail.quotes.map(text));
  return { status: 200, value: { id: shown.id, detail: shown, error: null, retire: reasons } };
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
 * POST /api/v1/rules/verdict with `{ id, verdict, reason, text?, default?, exception? }` (the three rule fields
 * required on promote of a class, refused on anything else; retire of a class takes none), after the request guards:
 * 400 for a body that is not one, 409 with no ledger or when the ledger refuses a promote or retire before writing anything, 403 for anyone but the owner,
 * 502 when the ledger's CLI fails (or the verdict was recorded but sync-agents failed); else 200.
 */
export async function writeRuleVerdict(d: PauseDeps, p: UiPauses, body: unknown): Promise<ApiResult> {
  const v = parseVerdict(body);
  if (typeof v === "string") return { status: 400, value: { error: v } };
  await d.tacit?.settings.refresh();
  const tacit = d.tacit?.ledger;
  if (!tacit?.enabled) return { status: 409, value: { error: "No tacit ledger is on: turn it on from the Rules page." } };
  const who = await ownerOf(d, p, "judges rules");
  if ("error" in who) return { status: 403, value: { error: who.error } };
  try {
    // The owner's rule goes with a promoted class; the CLIs take no "by", so the log keeps who judged.
    await tacit.verdict(v.id, v.verdict, v.reason, v.rule);
  } catch (err) {
    if (err instanceof TacitRefusal) return { status: 409, value: { error: `The ${v.verdict} was refused: ${errorText(err)}` } };
    if (err instanceof TacitSyncFailed) return { status: 502, value: { error: `The verdict was recorded, but sync-agents failed: ${errorText(err)}` } };
    return { status: 502, value: { error: `The ledger refused the verdict: ${errorText(err)}` } };
  }
  p.log.info("rule verdict sent", { id: v.id, verdict: v.verdict, actor: who.user, edited: v.rule !== undefined });
  return { status: 200, value: { id: v.id, verdict: v.verdict } };
}
