// The owner's tacit-knowledge ledger (issue #570): where a pushback (a `/revise`, a `/reject`, a `changes` verdict)
// is captured, so the owner's own tools can learn from it. The ledger lives outside the factory; a plugin only runs
// its CLIs and reads its promoted rules. The controller records each capture as an outbound intent, and outbound calls
// `capture` (retried with backoff, its text through G5 first). `pending`, `verdict` and `rules` read and judge the
// ledger (a promote of a class also writes the rule into the owner's rules file): the dashboard's Rules page and the learned rules in every prompt (issue #571) go through them only.

/** One pushback as the factory knows it. The ledger's own fields (root reason, hypothesis, rule draft) stay empty. */
export interface TacitPushback {
  /** The work item's ID. */
  readonly session: string;
  /** The stored summary of the item's latest finished run (its spec, change or review); empty when none. */
  readonly proposal: string;
  /** The owner's words, verbatim (after the egress scan). */
  readonly pushback: string;
}

/** A candidate class's rule draft, as `evolve show <C-id>` gives it. */
export interface TacitDraft {
  /** The rule itself (`기본값`). */
  readonly default: string;
  /** When it does not hold (`예외`). */
  readonly exception: string;
  /** The incident IDs (`T-…`) the class was drawn from, in the draft's order. */
  readonly incidents: readonly string[];
  /** Where it holds (`범위`). */
  readonly scope: string;
}

/** One entry waiting for the owner's verdict: a candidate class (`C-…`) or a structure proposal (`P-…`). */
export interface TacitPendingEntry {
  readonly id: string;
  readonly title: string;
  /** The word of the heading it is listed under: `open` or `held` for a proposal, `pending` or `held` for a class. */
  readonly state: string;
  /** The decision of a ledger verdict newer than the pending view: judged already, offered no verdict. Absent: not judged. */
  readonly judged?: string;
  /** A class's draft, when it is not judged and its draft was read. */
  readonly draft?: TacitDraft;
  /** Why a class's draft could not be read (no promote then). */
  readonly draft_error?: string;
}

/** The owner's rule on promote of a class: its wording (the rule's heading) and its default and exception. */
export interface TacitPromotion {
  readonly wording: string;
  readonly default: string;
  readonly exception: string;
}

/** A promote refused before anything was written or any verdict sent (a check failed). */
export class TacitRefusal extends Error {}

/** A promote whose verdict was recorded but whose follow-up (sync-agents) failed; the rule stays written. */
export class TacitSyncFailed extends Error {}

/** One promoted rule, as its section in the owner's rules file gives it; each value "" when the section has none. */
export interface TacitRule {
  /** The class ID, `C-…`. */
  readonly id: string;
  readonly name: string;
  /** The rule itself (`기본값`). */
  readonly default: string;
  /** When it does not hold (`예외`). */
  readonly exceptions: string;
  /** Where it holds (`범위`). */
  readonly scope: string;
}

/** The verdicts a ledger takes. `retire` is for a class only. */
export type TacitDecision = "hold" | "promote" | "reject" | "retire";

/** Which CLI judges `id`: `class` for a `C-` ID, `proposal` for a `P-` ID, null for any other. */
export function tacitIdKind(id: string): "class" | "proposal" | null {
  return id.startsWith("C-") ? "class" : id.startsWith("P-") ? "proposal" : null;
}

export interface TacitLedger {
  /** False: there is no ledger (the `none` plugin, or no CLI at the home): nothing is captured and no intent recorded. */
  readonly enabled: boolean;
  /** Writes one pushback to the ledger; throws on a failure (outbound retries it). */
  capture(p: TacitPushback): Promise<void>;
  /** The entries waiting for a verdict (open or held), in the ledger's order. */
  pending(): Promise<readonly TacitPendingEntry[]>;
  /**
   * Records the owner's verdict on entry `id` with their reason; `rule`, the owner's rule, goes only with a promote of
   * a class, which encodes it first. Throws for an ID that is neither a class nor a proposal, before any CLI runs;
   * throws `TacitRefusal` when a promote is refused with nothing written, `TacitSyncFailed` when its verdict was
   * recorded but the follow-up failed.
   */
  verdict(id: string, decision: TacitDecision, reason: string, rule?: TacitPromotion): Promise<void>;
  /** The promoted rules, in the ledger's order; none when the ledger has no rules file. */
  rules(): Promise<readonly TacitRule[]>;
}
