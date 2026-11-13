// Learned rules (design 07-self-improvement.md, issue #571): the rules the owner promoted in their tacit ledger, read
// at each run start through the TacitLedger plugin only (`rules()`), never a file path, and put in the prompt under
// their own heading: each rule's default, with its exceptions and scope as the ledger words them, for the agent to
// apply.

import { type Logger, errorText } from "./log.js";
import type { GuidanceSource } from "./worker-deps.js";
import type { TacitLedger, TacitRule } from "../interfaces/tacit-ledger.js";

/** The verdicts the Rules page sends; `retire` is for an applied class only. */
export const RULE_VERDICTS = ["promote", "reject", "hold", "retire"] as const;
export type RuleVerdict = (typeof RULE_VERDICTS)[number];

/** The cap on learned rules text per prompt (fixed): about 1000 tokens. Text past it is dropped with a warning. */
export const LEARNED_RULES_MAX = 4000;

const HEADING = "## Learned rules";
const INTRO = "Rules the owner promoted from their own pushbacks. Follow them unless the work item says otherwise.";

const indent = (t: string): string => t.replace(/\n/g, "\n  ");

/** One rule as a prompt bullet: its default, then its exceptions and scope when it has them. */
function bullet(r: TacitRule): string {
  return [`- ${indent(r.default)}`, ...(r.exceptions ? [`  Except: ${indent(r.exceptions)}`] : []), ...(r.scope ? [`  Scope: ${indent(r.scope)}`] : [])].join("\n");
}

/**
 * The `## Learned rules` section for a run's prompt: the ledger's promoted rules in its order, each with a default.
 * No ledger, no rule, or a failed read (a warning): no section, so the prompt is as without it.
 */
export class LearnedRules implements GuidanceSource {
  constructor(private readonly ledger: Pick<TacitLedger, "enabled" | "rules">) {}

  async read(log: Logger): Promise<string> {
    if (!this.ledger.enabled) return "";
    let rules: readonly TacitRule[];
    try {
      rules = await this.ledger.rules();
    } catch (err) {
      log.warn("learned rules could not be read; none in the prompt", { error: errorText(err) });
      return "";
    }
    const bullets = rules.filter((r) => r.default !== "").map(bullet);
    if (bullets.length === 0) return "";
    const body = bullets.join("\n");
    const kept = body.slice(0, LEARNED_RULES_MAX);
    if (kept.length < body.length) log.warn("learned rules over their cap; the rest was dropped", { dropped_chars: body.length - kept.length, cap: LEARNED_RULES_MAX });
    return [HEADING, INTRO, kept].join("\n\n");
  }
}

/** Several guidance sections as one, in order; each empty one is left out. */
export function joinGuidance(sources: readonly GuidanceSource[]): GuidanceSource {
  return {
    async read(log) {
      return (await Promise.all(sources.map((s) => s.read(log)))).filter((t) => t !== "").join("\n\n");
    },
  };
}
