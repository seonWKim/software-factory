// Learned rules (design 07-self-improvement.md, issue #571): the rules the owner promoted in their tacit ledger, read
// at each run start through the TacitLedger plugin only (`list` of the promoted state), never a file path, and put in
// the prompt under their own heading. A rule whose scope names another domain is left out. The same entry reading
// serves the dashboard's Rules page (src/ui/rules-api.ts), so the page and the prompt see one shape.

import { type Logger, errorText } from "./log.js";
import type { GuidanceSource } from "./worker-deps.js";
import type { TacitEntry, TacitLedger } from "../interfaces/tacit-ledger.js";

/** The ledger state of entries waiting for the owner's verdict: what the Rules page lists. */
export const PENDING_STATE = "pending";
/** The ledger state of promoted rules: what every run's prompt reads. */
export const PROMOTED_STATE = "promoted";
/** The verdicts the Rules page sends. */
export const RULE_VERDICTS = ["promote", "reject", "hold"] as const;
export type RuleVerdict = (typeof RULE_VERDICTS)[number];

/** The domain of every factory run: a rule scoped to another (resume writing, mentoring) is not for it. */
export const RUN_DOMAIN = "software";
/** The cap on learned rules text per prompt (fixed): about 1000 tokens. Text past it is dropped with a warning. */
export const LEARNED_RULES_MAX = 4000;

const HEADING = "## Learned rules";
const INTRO = "Rules the owner promoted from their own pushbacks. Follow them unless the work item says otherwise.";

/** One ledger entry as the factory reads it; the ledger's other fields are left alone. */
export interface RuleEntry {
  id: string;
  /** `pushback`, `class` (a candidate class) or `structure` (a structure proposal); `pushback` when the ledger names none. */
  kind: string;
  /** The evidence lines, in the ledger's order. */
  evidence: string[];
  /** The ledger's rule draft; "" when it has none. */
  rule_draft: string;
  /** The owner's wording stored with a promote verdict; null when none was given. */
  text: string | null;
  /** The domains the rule is for; empty: every domain. */
  scope: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const lines = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((l) => l !== "") : str(v).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");

/** A ledger entry as a RuleEntry; null when it has no ID. Evidence falls back to the captured pushback. */
export function ruleEntry(e: TacitEntry): RuleEntry | null {
  const id = typeof e.id === "number" ? String(e.id) : str(e.id);
  if (id === "") return null;
  const evidence = lines(e.evidence);
  return {
    id,
    kind: str(e.kind) || "pushback",
    evidence: evidence.length > 0 ? evidence : lines(e.pushback),
    rule_draft: str(e.rule_draft),
    text: str(e.text) || null,
    scope: lines(e.scope).flatMap((s) => s.split(",")).map((s) => s.trim().toLowerCase()).filter((s) => s !== ""),
  };
}

/** Whether a rule is for `domain`: no scope (every domain), or a scope tag equal to it. */
export function inScope(scope: readonly string[], domain: string = RUN_DOMAIN): boolean {
  return scope.length === 0 || scope.includes(domain.toLowerCase());
}

/** The promoted rule's wording: the owner's text when stored, else the draft. */
export const ruleText = (r: RuleEntry): string => r.text ?? r.rule_draft;

/**
 * The `## Learned rules` section for a run's prompt: the ledger's promoted rules in its order, those for this run's
 * domain only. No ledger, no rule for the domain, or a failed read (a warning): no section, so the prompt is as
 * without it.
 */
export class LearnedRules implements GuidanceSource {
  constructor(
    private readonly ledger: Pick<TacitLedger, "enabled" | "list">,
    private readonly domain: string = RUN_DOMAIN,
  ) {}

  async read(log: Logger): Promise<string> {
    if (!this.ledger.enabled) return "";
    let entries: readonly TacitEntry[];
    try {
      entries = await this.ledger.list(PROMOTED_STATE);
    } catch (err) {
      log.warn("learned rules could not be read; none in the prompt", { error: errorText(err) });
      return "";
    }
    const rules = entries
      .map(ruleEntry)
      .filter((r): r is RuleEntry => r !== null && inScope(r.scope, this.domain) && ruleText(r) !== "")
      .map((r) => `- ${ruleText(r).replace(/\n/g, "\n  ")}`);
    if (rules.length === 0) return "";
    const body = rules.join("\n");
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
