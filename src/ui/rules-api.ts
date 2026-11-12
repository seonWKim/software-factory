// The Rules page (design 09-dashboard-app.md and 07-self-improvement.md, issue #571). GET /api/v1/rules lists the
// owner's tacit ledger entries waiting for a verdict (candidate classes `C-…` and structure proposals `P-…`, open or
// held), each with its ID, title and state, read through `TacitLedger.pending` only. POST /api/v1/rules/verdict sends
// one verdict (promote, reject or hold) with the owner's reason, and for promote of a class their wording as the rule,
// through `TacitLedger.verdict` only: the page has no other write path and writes nothing to the store. The request guards
// (Host, Origin, Content-Type, CSRF token, body size, JSON) run in server.ts; then the owner check (decision 1 of #571:
// the store's local owner only); every refusal comes before the ledger's CLI runs.
//
// The ledger is the UI's live holder (design 08-settings, 2026-11-12): each request first refreshes the UI's settings,
// so a changed `integrations` entry takes effect here with no restart. With the ledger off, GET also says where the
// agents home is and which CLI is missing there, and gives the owner the `integrations` value that turns the ledger
// on; the page writes it through POST /api/v1/settings, whose guards and owner check run as for any setting.

import { RULE_VERDICTS, type RuleVerdict } from "../core/learned-rules.js";
import { errorText } from "../core/log.js";
import { LiveSettings } from "../core/settings.js";
import { checkAgentsHome } from "../impl/tacit/agents-home-tacit-ledger.js";
import { LiveTacit } from "../runtime/live-tacit.js";
import type { UserId } from "../core/types.js";
import { type TacitLedger, type TacitPendingEntry, tacitIdKind } from "../interfaces/tacit-ledger.js";
import type { ApiResult } from "./api.js";
import type { PauseDeps, UiPauses } from "./pause-api.js";
import { Withholder } from "./withhold.js";

export const RULES_PATH = "/api/v1/rules";
export const RULE_VERDICT_PATH = "/api/v1/rules/verdict";

/** The longest reason and rule text a verdict takes. */
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
  const ledger = await LiveTacit.start(configured, build, o.log);
  const settings = new LiveSettings({ ...o, config: { ...o.config, project: { key: "", label: "" } }, integrations: [ledger] });
  return { ledger, settings, home: () => checkAgentsHome(process.env) };
}

/** The plugin the Rules page turns on. */
export const RULES_PLUGIN = "agents-home";

/** The page's user when they are the local owner, else why not; `does` names the act (`judges rules`). */
export async function ownerOf(d: PauseDeps, p: UiPauses, does: string): Promise<{ user: UserId } | { error: string }> {
  const user = await p.principal();
  if (user === null) return { error: "No factory user acts from this page: link your local account or set cli_user." };
  // The local grants first (as every check): a solo store's first identity becomes its owner there.
  const decision = await p.authorize(user);
  if (!decision.allow) return { error: `Only the owner ${does}: ${decision.reason}.` };
  if ((await d.store.getLocalUser(user))?.role !== "owner") return { error: `Only the owner ${does}; you are ${user}.` };
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
    if (!d.tacit) return { status: 200, value: { enabled: false, entries: [], error: null, csrf_token: null, judge: null, home: null, turn_on: null } };
    const judge = await judgeOf("turns the ledger on");
    const home = d.tacit.home();
    // The whole entry with `tacit` set: other integrations keep theirs.
    const turnOn = judge === null && home.missing === null ? JSON.stringify({ ...d.tacit.settings.values().integrations, tacit: RULES_PLUGIN }) : null;
    return {
      status: 200,
      value: {
        enabled: false, entries: [], error: null, csrf_token: judge === null ? d.pauses!.csrfToken : null, judge,
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
    shown.push({ id: await text(e.id), title: await text(e.title), state: e.state });
  }
  return {
    status: 200,
    value: { enabled: true, entries: shown, error: error === null ? null : await text(error), csrf_token: d.pauses?.csrfToken ?? null, judge, home: null, turn_on: null },
  };
}

type VerdictBody = { id: string; verdict: RuleVerdict; reason: string; text?: string };

/** The POST body as a verdict, or why it is not one. */
function parseVerdict(body: unknown): VerdictBody | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "the body must be a JSON object";
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !["id", "verdict", "reason", "text"].includes(k));
  if (extra) return `unknown field "${extra}"`;
  if (typeof b.id !== "string" || b.id.trim() === "") return "id must be a non-empty string";
  if (!RULE_VERDICTS.includes(b.verdict as RuleVerdict)) return `verdict must be one of ${RULE_VERDICTS.join(", ")}`;
  if (typeof b.reason !== "string" || b.reason.trim() === "" || b.reason.length > MAX_REASON) return `reason must be 1 to ${MAX_REASON} characters`;
  if (b.text !== undefined) {
    if (b.verdict !== "promote" || tacitIdKind(b.id.trim()) !== "class") return "only promote of a class (C-) takes a text";
    if (typeof b.text !== "string" || b.text.trim() === "" || b.text.length > MAX_RULE_TEXT) return `text must be 1 to ${MAX_RULE_TEXT} characters`;
  }
  return { id: b.id.trim(), verdict: b.verdict as RuleVerdict, reason: b.reason.trim(), ...(typeof b.text === "string" ? { text: b.text.trim() } : {}) };
}

/**
 * POST /api/v1/rules/verdict with `{ id, verdict, reason, text? }` (`text` only on promote of a class), after the
 * request guards: 400 for a body that is not one, 409 with no ledger, 403 for anyone but the owner, 502 when the
 * ledger's CLI fails; else 200.
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
    // The owner's wording goes as the promoted class's rule; the CLIs take no "by", so the log keeps who judged.
    await tacit.verdict(v.id, v.verdict, v.reason, v.text);
  } catch (err) {
    return { status: 502, value: { error: `The ledger refused the verdict: ${errorText(err)}` } };
  }
  p.log.info("rule verdict sent", { id: v.id, verdict: v.verdict, actor: who.user, edited: v.text !== undefined });
  return { status: 200, value: { id: v.id, verdict: v.verdict } };
}
