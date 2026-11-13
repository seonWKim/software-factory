// The owner's tacit-knowledge ledger (issue #570): where a pushback (a `/revise`, a `/reject`, a `changes` verdict)
// is captured, so the owner's own tools can learn from it. The ledger lives outside the factory; a plugin only runs
// its CLIs and reads its promoted rules. The controller records each capture as an outbound intent, and outbound calls
// `capture` (retried with backoff, its text through G5 first). `pending`, `show`, `verdict` and `rules` read and judge
// the ledger (a promote of a class also writes the rule into the owner's rules file): the dashboard's Rules page and
// the learned rules in every prompt (issue #571) go through them only.

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
  /** A proposal's kind (`promote-learning`, `edit-asset`, `new-asset`); absent for a class or a row with none. */
  readonly kind?: string;
  /** The asset a proposal changes; absent for a class or a row with none. */
  readonly target?: string;
}

/**
 * One entry's detail, as `evolve show <id>` gives it; a field the ledger did not print is absent. What it would
 * change (a class's draft rule, a proposal's kind and target), why (the incidents, the owner's words, the root reason)
 * and where it applies (the scope).
 */
export interface TacitEntryDetail {
  readonly id: string;
  /** A class's draft rule (`기본값`). */
  readonly default?: string;
  /** When the draft rule does not hold (`예외`). */
  readonly exceptions?: string;
  /** A proposal's kind and the asset it changes. */
  readonly kind?: string;
  readonly target?: string;
  /** How many times it came up. */
  readonly incidents?: number;
  /** The owner's own words, one per incident that has them. */
  readonly quotes?: readonly string[];
  /** The reason the incidents share. */
  readonly root_reason?: string;
  /** Where it applies (`범위`). */
  readonly scope?: string;
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
   * One entry's detail, or null when the ledger has none; throws on a failed read. Reads only: it writes nothing to the
   * store or the ledger. Optional while the runtime holder (src/runtime/live-tacit.ts) does not delegate it.
   */
  show?(id: string): Promise<TacitEntryDetail | null>;
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
