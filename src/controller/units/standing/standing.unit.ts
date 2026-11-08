// Standing approvals: the command, proposals after a run of approvals, turning a rule off.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { SPEC_GATE, STANDING_APPROVED, STANDING_TIER, dueProposal, findRule, gateEvents, parseRuleId, parseStanding, protectedCategory, ruleId } from "../../../core/standing.js";
import { type Tier, type UserId, type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { SourceEvent } from "../../../interfaces/source-adapter.js";
import { type CommandEvent, COMMAND } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

type StandingEvent = Extract<SourceEvent, { kind: "standing_requested" }>;
/** Newest items whose spec decisions the standing-approval run check reads (design 05-standing-approvals). */
const STANDING_WINDOW = 200;
/** The settable key of the run length that proposes a standing rule. */
const STANDING_THRESHOLD = "standing_approvals.threshold";

/** Standing approvals: the command, proposals after a run of approvals, turning a rule off. */
export class StandingUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * `/standing` on a work item (design 05-standing-approvals): the same permission check as `/approve`, 👀, then one
   * reply keyed on the comment. Without arguments it shows the rule's state; `accept` turns the rule on, `decline`
   * turns it off (and keeps its proposal quiet until the run resets). A rule already in the asked state is left
   * alone with no reply, so a second accept or a redelivery posts nothing new. The user ID is recorded as `set_by`.
   */
  async handleStanding(e: StandingEvent): Promise<void> {
    const item = await this.c.k.reader.getWorkItemBySource(e.source.type, e.source.id);
    if (!item) return;
    const principal = await this.c.unit("auth").authorize(e.requester, "approve_spec", item.id);
    await this.c.unit("outbox").markSeen(e.source, e.comment_id);
    const marker = `<!-- factory:standing:${e.comment_id} -->`;
    const refuse = async (reason: string) => {
      this.c.k.d.log.info("command refused", { work_item_id: item.id, command: e.kind, reason });
      await this.c.unit("outbox").post(item, item.source, `\`/standing\` was not applied: ${reason}.`, `<!-- factory:refused:${e.comment_id} -->`);
    };
    if ("refuse" in principal) return refuse(principal.refuse);
    const asked = parseStanding(e.args);
    if ("refuse" in asked) return refuse(asked.refuse);
    const rules = await this.c.k.reader.listStandingRules();
    const id = ruleId(SPEC_GATE, STANDING_TIER);
    if (asked.action === "show") {
      const rule = findRule(rules, SPEC_GATE, STANDING_TIER);
      const state = rule?.enabled
        ? `on, turned on by \`${rule.set_by}\`; reply \`/standing decline ${id}\` to turn it off`
        : `off${rule ? `, turned off by \`${rule.set_by}\`` : ""}; reply \`/standing accept ${id}\` to turn it on`;
      const threshold = this.c.k.live.values()[STANDING_THRESHOLD];
      await this.c.unit("outbox").post(item, item.source, [
        "## Standing approvals",
        "",
        `- \`${id}\` (tier ${STANDING_TIER} specs that wait at the spec gate): ${state}.`,
        "",
        `A rule is proposed after ${threshold} tier ${STANDING_TIER} spec approvals in a row with the spec unchanged (\`${STANDING_THRESHOLD}\`).`,
      ].join("\n"), marker);
      return;
    }
    const enabled = asked.action === "accept";
    const rule = findRule(rules, asked.gate, asked.tier);
    if (rule && rule.enabled === enabled) return;
    await this.c.k.commit({ writes: [{ kind: "standing_rule", rule: { gate: asked.gate, tier: asked.tier, enabled, set_by: principal.user_id } }] });
    this.c.k.d.log.info(enabled ? "standing rule on" : "standing rule off", { rule: id, user_id: principal.user_id });
    await this.c.unit("outbox").post(item, item.source, enabled
      ? `The standing rule \`${id}\` is on: the next tier ${asked.tier} specs that wait at the spec gate are approved without a reply, as \`standing:${id}\`. ` +
        `It never approves a spec whose allowed paths touch the factory's gates, prompts, permissions, tools, guard settings or floor paths. ` +
        `To turn it off, reply \`/standing decline ${id}\`, or \`/revise\` or \`/reject\` on an item it approved.`
      : `The standing rule \`${id}\` is off: tier ${asked.tier} specs wait for \`/approve\` again. It is not proposed again until the run of approvals resets and reaches the threshold again.`,
      marker);
  }

  /**
   * After a spec command was applied (design 05-standing-approvals): an `/approve` may bring the tier 1 run to the
   * threshold, which posts one proposal on this item; a `/revise` or `/reject` on an item a rule approved turns
   * that rule off, with one reply. Both are keyed, so running this twice posts once.
   */
  async afterSpecCommand(id: WorkItemId, e: CommandEvent, user: UserId): Promise<void> {
    const it = await this.c.k.reader.getWorkItem(id);
    if (!it) return;
    if (e.kind === "spec_approved") return this.proposeStanding(it);
    if (e.kind === "spec_rejected" || e.kind === "revise_requested") return this.turnOffStanding(it, e.kind, e.comment_id, user);
  }

  /** One proposal comment when this item's approval brought the run of tier 1 approvals to the threshold. */
  async proposeStanding(it: WorkItem): Promise<void> {
    const threshold = this.c.k.live.values()[STANDING_THRESHOLD];
    const own = gateEvents(await this.c.k.reader.listStateChanges(it.id));
    const items = await this.c.k.reader.listWorkItems(Math.max(STANDING_WINDOW, threshold * 4));
    const events = own.slice();
    for (const x of items) if (x.id !== it.id) events.push(...gateEvents(await this.c.k.reader.listStateChanges(x.id)));
    const rule = findRule(await this.c.k.reader.listStandingRules(), SPEC_GATE, STANDING_TIER);
    const due = dueProposal(events, own, threshold, rule);
    if (!due) return;
    await this.c.k.commit({ writes: [{ kind: "standing_proposal", proposal: { gate: due.gate, tier: due.tier, run_length: due.run_length, threshold } }] });
    const id = ruleId(due.gate, due.tier);
    await this.c.unit("outbox").comment(it, `standing-proposal:${id}:${it.id}:${own.at(-1)!.at}`, [
      `## Standing approval proposed: \`${id}\``,
      "",
      `The last ${due.run_length} tier ${due.tier} specs were approved in a row with the spec unchanged (\`${STANDING_THRESHOLD}\` = ${threshold}).`,
      "",
      `- Reply \`/standing accept ${id}\` to approve the next tier ${due.tier} specs that wait at the spec gate without a reply.`,
      `- Reply \`/standing decline ${id}\` to keep approving each one; this is not proposed again until the run resets and reaches ${threshold} again.`,
      "",
      "A rule never approves a spec whose allowed paths touch the factory's gates, prompts, permissions, tools, guard settings or floor paths. " +
        "A `/revise` or `/reject` on an item it approved turns it off.",
    ].join("\n"));
    this.c.k.d.log.info("standing proposal", { rule: id, run_length: due.run_length, work_item_id: it.id });
  }

  /** A `/revise` or `/reject` on an item a rule approved turns that rule off, if it is still on; one reply. */
  async turnOffStanding(it: WorkItem, kind: "spec_rejected" | "revise_requested", commentId: string, user: UserId): Promise<void> {
    const approved = (await this.c.k.reader.listStateChanges(it.id)).filter((c) => c.reason === STANDING_APPROVED).at(-1);
    const named = typeof approved?.detail?.standing_rule === "string" ? parseRuleId(approved.detail.standing_rule) : null;
    if (!named) return;
    const rule = findRule(await this.c.k.reader.listStandingRules(), named.gate, named.tier);
    if (!rule?.enabled) return;
    await this.c.k.commit({ writes: [{ kind: "standing_rule", rule: { gate: named.gate, tier: named.tier, enabled: false, set_by: user } }] });
    const id = ruleId(named.gate, named.tier);
    this.c.k.d.log.info("standing rule off", { rule: id, user_id: user, work_item_id: it.id });
    await this.c.unit("outbox").post(it, it.source, [
      `The standing rule \`${id}\` is off: \`${COMMAND[kind]}\` on an item it approved turned it off.`,
      `Tier ${named.tier} specs wait for \`/approve\` again; reply \`/standing accept ${id}\` to turn it back on.`,
    ].join(" "), `<!-- factory:standing-off:${commentId} -->`);
  }

  /** The rule that approves this spec at the gate: on, for its tier, and none of its allowed paths protected. */
  async standingRule(it: WorkItem, tier: Tier, paths: readonly string[]) {
    if (tier !== STANDING_TIER) return null;
    const rule = findRule(await this.c.k.reader.listStandingRules(), SPEC_GATE, tier);
    if (!rule?.enabled) return null;
    const category = protectedCategory(paths, this.c.k.settings(it.project).floors);
    if (category === null) return rule;
    this.c.k.d.log.info("standing rule skipped: protected paths", { work_item_id: it.id, rule: ruleId(SPEC_GATE, tier), category });
    return null;
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "standing": StandingUnit;
  }
}

export default controllerUnit({
  name: "standing",
  create: (c: Ctx) => new StandingUnit(c),
  events: {
    standing_requested: (u, e) => u.handleStanding(e),
  },
});
