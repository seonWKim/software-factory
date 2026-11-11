// The owner's tacit-knowledge ledger (issue #570): where a pushback (a `/revise`, a `/reject`, a `changes` verdict)
// is captured, so the owner's own tools can learn from it. The ledger lives outside the factory; a plugin only runs
// its CLIs. The controller records each capture as an outbound intent, and outbound calls `capture` (retried with
// backoff, its text through G5 first). `list` and `verdict` read and judge the ledger's entries.

/** One pushback as the factory knows it. The ledger's own fields (root reason, hypothesis, rule draft) stay empty. */
export interface TacitPushback {
  /** The work item's ID. */
  readonly session: string;
  /** The stored summary of the item's latest finished run (its spec, change or review); empty when none. */
  readonly proposal: string;
  /** The owner's words, verbatim (after the egress scan). */
  readonly pushback: string;
}

/** One ledger entry as the ledger's CLI lists it: its fields, as written. */
export type TacitEntry = Readonly<Record<string, unknown>>;

export interface TacitLedger {
  /** False: there is no ledger (the `none` plugin, or no CLI at the home): nothing is captured and no intent recorded. */
  readonly enabled: boolean;
  /** Writes one pushback to the ledger; throws on a failure (outbound retries it). */
  capture(p: TacitPushback): Promise<void>;
  /** The ledger's entries in `state`. */
  list(state: string): Promise<readonly TacitEntry[]>;
  /** Records the owner's verdict on entry `id`. */
  verdict(id: string, verdict: string): Promise<void>;
}
