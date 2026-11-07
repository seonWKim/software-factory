// Standing approvals on the dashboard (design 05-standing-approvals and §9, issue #300). GET /api/v1/standing lists
// each rule (gate, tier, the effective `standing_approvals.threshold`, enabled, who set it, created, last used) and
// the pending proposals; POST /api/v1/standing turns a rule on or off, as `/standing accept|decline` does. The
// request guards (Host, Origin, Content-Type, CSRF token) run in server.ts before writeStanding is reached; then the
// owner check, the pause route's own (`approve_spec` on the configured project). Only then is the store written.

import { SPEC_GATE, STANDING_TIER, findRule, parseRuleId, ruleId } from "../core/standing.js";
import type { StandingProposal, StandingRule } from "../core/types.js";
import type { ApiResult } from "./api.js";
import type { PauseDeps, UiPauses } from "./pause-api.js";
import { effectiveGlobal } from "./settings-api.js";
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

/** GET /api/v1/standing. Every text value leaves through the Withholder. */
export async function readStanding(d: PauseDeps) {
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const threshold = (await effectiveGlobal(d, "standing_approvals.threshold")).value;
  const stored = await d.store.listStandingRules();
  const rules = [];
  for (const { gate, tier } of RULES) {
    const r = findRule(stored, gate, tier);
    rules.push({
      rule: await text(ruleId(gate, tier)),
      gate: await text(gate),
      tier,
      threshold,
      enabled: r?.enabled ?? false,
      set_by: r ? await text(r.set_by) : null,
      created_at: r?.created_at ?? null,
      updated_at: r?.updated_at ?? null,
      /** Not recorded yet (issue #300 decision 1): the page shows "not recorded". */
      last_used_at: null,
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
  return { as_of: d.clock.now().toISOString(), csrf_token: d.pauses?.csrfToken ?? null, rules, proposals };
}

type StandingWrite = { rule: string; enabled: boolean; proposal?: string };

/** The POST body, or why it is not one. */
function parseWrite(body: unknown): StandingWrite | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => k !== "rule" && k !== "enabled" && k !== "proposal");
  if (extra) return { error: `unknown field "${extra}"` };
  if (typeof b.rule !== "string") return { error: "rule must be a string" };
  if (typeof b.enabled !== "boolean") return { error: "enabled must be true or false" };
  if (b.proposal !== undefined && typeof b.proposal !== "string") return { error: "proposal must be a proposal id" };
  return { rule: b.rule, enabled: b.enabled, ...(typeof b.proposal === "string" ? { proposal: b.proposal } : {}) };
}

/**
 * POST /api/v1/standing with `{ rule, enabled, proposal? }`, after the request guards: 400 for a body that is not
 * one, a rule other than `spec-t1` or a proposal that is not stored for that rule; 403 without the owner check;
 * else 200 with `changed` and the read model. A rule already in the asked state is not written (`changed: false`),
 * unless the body names a pending proposal: then the answer is recorded, so the proposal leaves the list.
 */
export async function writeStanding(d: PauseDeps, p: UiPauses, body: unknown): Promise<ApiResult> {
  const parsed = parseWrite(body);
  if ("error" in parsed) return { status: 400, value: { error: parsed.error } };
  const named = parseRuleId(parsed.rule);
  if (!named) return { status: 400, value: { error: `the only rule is ${ruleId(SPEC_GATE, STANDING_TIER)} (tier ${STANDING_TIER} specs at the spec gate)` } };
  const proposal = parsed.proposal === undefined
    ? undefined
    : (await d.store.listStandingProposals()).find((x) => x.id === parsed.proposal && x.gate === named.gate && x.tier === named.tier);
  if (parsed.proposal !== undefined && !proposal) return { status: 400, value: { error: "no such proposal is stored for this rule" } };

  const user = await p.principal();
  if (user === null) {
    return { status: 403, value: { error: "No factory user acts from this page: link your local account or set cli_user." } };
  }
  const decision = await p.authorize(user);
  const id = ruleId(named.gate, named.tier);
  if (!decision.allow) {
    const cmd = parsed.enabled ? "accept" : "decline";
    return { status: 403, value: { error: `Changing a standing rule needs approve_spec: ${decision.reason}. Or reply \`/standing ${cmd} ${id}\` on a work item.` } };
  }

  const rule = findRule(await d.store.listStandingRules(), named.gate, named.tier);
  const answers = proposal !== undefined && pending(proposal, rule);
  const changed = (rule?.enabled ?? false) !== parsed.enabled || answers;
  if (changed) {
    await d.store.putStandingRule({ gate: named.gate, tier: named.tier, enabled: parsed.enabled, set_by: user });
    p.log.info(parsed.enabled ? "standing rule on" : "standing rule off", {
      rule: id, user_id: user, ...(proposal ? { proposal: proposal.id } : {}),
    });
  }
  return { status: 200, value: { changed, ...(await readStanding(d)) } };
}
