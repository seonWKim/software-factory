// Standing approvals on the dashboard (design 05-standing-approvals and §9, issue #300). GET /api/v1/standing lists
// each rule (gate, tier, the effective `standing_approvals.threshold`, enabled, who set it, created, when it last fired
// and the items it approved in the last 7 days, from stored state changes), the pending proposals and `waiting`, the
// items waiting now that the rule would approve (the page's preview). POST /api/v1/standing turns a rule on or off, as
// `/standing accept|decline` does, removes its row, or changes the threshold; every change writes one change record.
// The request guards (Host, Origin, Content-Type, CSRF token) run in server.ts before writeStanding is reached; then
// the owner check, the pause route's own (`approve_spec` on the configured project). Only then is the store written.

import { SPEC_GATE, STANDING_APPROVED, STANDING_TIER, findRule, parseRuleId, ruleId, standingActor, waitingForRule } from "../core/standing.js";
import type { StandingProposal, StandingRule, UserId } from "../core/types.js";
import { ownerAnswersFor } from "../shared/command-notes.js";
import type { ApiResult } from "./api.js";
import type { PauseDeps, UiPauses } from "./pause-api.js";
import { effectiveGlobal, writeSettings } from "./settings-api.js";
import { Withholder } from "./withhold.js";

export const STANDING_PATH = "/api/v1/standing";

/** The rules a person can turn on: only `spec-t1` (tier 1 specs at the spec gate). */
const RULES = [{ gate: SPEC_GATE, tier: STANDING_TIER }] as const;

/**
 * A proposal still waiting for an answer: its rule is not on, and the rule was not written (accepted or declined)
 * after the proposal was stored. Read from the stored rows alone (no item-level run history, issue #300 decision 4).
 */
function pending(p: StandingProposal, rule: StandingRule | undefined): boolean {
  return !rule || (!rule.enabled && rule.updated_at < p.created_at);
}

/** The window of a rule's "items in the last 7 days". */
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
/** The settable key the Edit dialog changes: one threshold for every rule, not a field of the rule row. */
const THRESHOLD = "standing_approvals.threshold";
/**
 * GET /api/v1/standing. Every text value leaves through the Withholder. A rule's firings are read from the stored
 * `standing_approved` state changes (actor `standing:<rule>`), never written here: `last_fired_at` is the newest, and
 * `recent` the distinct items it approved in the 7 days before now, newest first, each `{ id, title }`.
 */
export async function readStanding(d: PauseDeps) {
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const threshold = (await effectiveGlobal(d, THRESHOLD)).value;
  const stored = await d.store.listStandingRules();
  const fired = await d.store.listStateChangesSince({ reasons: [STANDING_APPROVED], since: null });
  const since = d.clock.now().getTime() - RECENT_MS;
  const rules = [];
  for (const { gate, tier } of RULES) {
    const r = findRule(stored, gate, tier);
    const mine = fired.filter((c) => c.actor.id === standingActor(gate, tier).id).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const recent = [];
    for (const id of new Set(mine.filter((c) => Date.parse(c.at) >= since).map((c) => c.work_item_id))) {
      const item = await d.store.getWorkItem(id);
      recent.push({ id: await text(id), title: await text(item?.title ?? id) });
    }
    rules.push({
      rule: await text(ruleId(gate, tier)),
      gate: await text(gate),
      tier,
      threshold,
      enabled: r?.enabled ?? false,
      set_by: r ? await text(r.set_by) : null,
      created_at: r?.created_at ?? null,
      updated_at: r?.updated_at ?? null,
      last_fired_at: mine[0]?.at ?? null,
      recent,
    });
  }
  const proposals = [];
  for (const p of await d.store.listStandingProposals()) {
    if (!parseRuleId(ruleId(p.gate, p.tier)) || !pending(p, findRule(stored, p.gate, p.tier))) continue;
    proposals.push({
      id: await text(p.id),
      rule: await text(ruleId(p.gate, p.tier)),
      run_length: p.run_length,
      threshold: p.threshold,
      created_at: p.created_at,
    });
  }
  const waiting = [];
  const layers = d.settings?.base.layers ?? { defaults: {}, projects: {} };
  for (const it of await waitingForRule(d.store, layers, (x) => ownerAnswersFor(x, (id) => d.store.listStateChanges(id)))) {
    waiting.push({ id: await text(it.id), title: await text(it.title ?? it.id) });
  }
  return { as_of: d.clock.now().toISOString(), csrf_token: d.pauses?.csrfToken ?? null, rules, proposals, waiting };
}

type StandingWrite =
  | { rule: string; action: "set"; enabled: boolean; proposal?: string }
  | { rule: string; action: "remove" }
  | { rule: string; action: "edit"; threshold: number };

/** The POST body, or why it is not one: `{ rule, enabled, proposal? }`, `{ rule, action: "remove" }` or `{ rule, action: "edit", threshold }`. */
function parseWrite(body: unknown): StandingWrite | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const fields = b.action === "edit" ? ["rule", "action", "threshold"] : b.action === "remove" ? ["rule", "action"] : ["rule", "enabled", "proposal"];
  const extra = Object.keys(b).find((k) => !fields.includes(k));
  if (extra) return { error: `unknown field "${extra}"` };
  if (typeof b.rule !== "string") return { error: "rule must be a string" };
  if (b.action === "remove") return { rule: b.rule, action: "remove" };
  if (b.action === "edit") {
    if (typeof b.threshold !== "number") return { error: "threshold must be a number" };
    return { rule: b.rule, action: "edit", threshold: b.threshold };
  }
  if (typeof b.enabled !== "boolean") return { error: "enabled must be true or false" };
  if (b.proposal !== undefined && typeof b.proposal !== "string") return { error: "proposal must be a proposal id" };
  return { rule: b.rule, action: "set", enabled: b.enabled, ...(typeof b.proposal === "string" ? { proposal: b.proposal } : {}) };
}

/** What `/standing` command does the same as this write, for the refusal; none for a remove or an edit. */
const commandHint = (w: StandingWrite, id: string): string =>
  w.action === "set" ? ` Or reply \`/standing ${w.enabled ? "accept" : "decline"} ${id}\` on a work item.` : "";

/**
 * POST /api/v1/standing, after the request guards: 400 for a body that is not one, a rule other than `spec-t1` or a
 * proposal that is not stored for that rule; 403 without the owner check (`approve_spec`), naming it; else 200 with
 * `changed` and the read model. Nothing is written when nothing would change (`changed: false`): a rule already in
 * the asked state, unless the body names a pending proposal (then the answer is recorded, so the proposal leaves the
 * list); a remove with no stored row; an edit to the threshold in force. An edit goes through the Settings write
 * (writeSettings: its refusal comes back as it is, 422). Every change writes one change record with the user's ID.
 */
export async function writeStanding(d: PauseDeps, p: UiPauses, body: unknown): Promise<ApiResult> {
  const parsed = parseWrite(body);
  if ("error" in parsed) return { status: 400, value: { error: parsed.error } };
  const named = parseRuleId(parsed.rule);
  if (!named) return { status: 400, value: { error: `the only rule is ${ruleId(SPEC_GATE, STANDING_TIER)} (tier ${STANDING_TIER} specs at the spec gate)` } };
  const proposal = parsed.action !== "set" || parsed.proposal === undefined
    ? undefined
    : (await d.store.listStandingProposals()).find((x) => x.id === parsed.proposal && x.gate === named.gate && x.tier === named.tier);
  if (parsed.action === "set" && parsed.proposal !== undefined && !proposal) return { status: 400, value: { error: "no such proposal is stored for this rule" } };

  const user = await p.principal();
  if (user === null) {
    return { status: 403, value: { error: "No factory user acts from this page: link your local account or set cli_user." } };
  }
  const decision = await p.authorize(user);
  const id = ruleId(named.gate, named.tier);
  if (!decision.allow) {
    return { status: 403, value: { error: `Changing a standing rule needs the approve_spec permission: ${decision.reason}.${commandHint(parsed, id)}` } };
  }

  let changed: boolean;
  if (parsed.action === "remove") {
    changed = await d.store.deleteStandingRule({ gate: named.gate, tier: named.tier, actor: user });
    if (changed) p.log.info("standing rule removed", { rule: id, user_id: user });
  } else if (parsed.action === "edit") {
    const edited = await editThreshold(d, user, named, parsed.threshold);
    if ("refused" in edited) return edited.refused;
    changed = edited.changed;
    if (changed) p.log.info("standing threshold changed", { rule: id, user_id: user, threshold: parsed.threshold });
  } else {
    const rule = findRule(await d.store.listStandingRules(), named.gate, named.tier);
    const answers = proposal !== undefined && pending(proposal, rule);
    changed = (rule?.enabled ?? false) !== parsed.enabled || answers;
    if (changed) {
      await d.store.putStandingRule({ gate: named.gate, tier: named.tier, enabled: parsed.enabled, set_by: user });
      p.log.info(parsed.enabled ? "standing rule on" : "standing rule off", {
        rule: id, user_id: user, ...(proposal ? { proposal: proposal.id } : {}),
      });
    }
  }
  return { status: 200, value: { changed, ...(await readStanding(d)) } };
}

/** The threshold edit: the Settings write of `standing_approvals.threshold`, then its change record. */
async function editThreshold(
  d: PauseDeps,
  user: UserId,
  rule: NonNullable<ReturnType<typeof parseRuleId>>,
  threshold: number,
): Promise<{ changed: boolean } | { refused: ApiResult }> {
  const before = (await effectiveGlobal(d, THRESHOLD)).value;
  if (before === threshold) return { changed: false };
  if (!d.settings) return { refused: { status: 422, value: { error: "The threshold cannot be changed from this page: it has no settings write." } } };
  const set = await writeSettings(d, d.settings, { action: "set", key: THRESHOLD, value: JSON.stringify(threshold) });
  if (set.status !== 200) return { refused: set };
  await d.store.recordStandingRuleChange({ ...rule, action: "edit", before: { threshold: before }, after: { threshold }, actor: user });
  return { changed: true };
}
