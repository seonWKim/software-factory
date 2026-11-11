// The owner's tacit-knowledge ledger (issue #570): where a pushback (a `/revise`, a `/reject`, a `changes` verdict)
// is captured, so the owner's own tools can learn from it. The ledger lives outside the factory; a plugin only runs
// its CLIs. The controller records each capture as an outbound intent, and outbound calls `capture` (retried with
// backoff, its text through G5 first). `list` and `verdict` read and judge the ledger's entries: the dashboard's Rules
// page and the learned rules in every prompt (issue #571) go through them only, never a file under the home.

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

/** What goes with a verdict from the Rules page (issue #571): why, who, and the owner's wording of a promoted rule. */
export interface TacitVerdictNote {
  /** The owner's reason, as typed. */
  readonly reason: string;
  /** The factory user ID that gave the verdict; never a display name. */
  readonly by: string;
  /** The owner's edited rule text, stored with the verdict; the entry's own draft is kept. Absent: the draft as is. */
  readonly text?: string;
}

export interface TacitLedger {
  /** False: there is no ledger (the `none` plugin, or no CLI at the home): nothing is captured and no intent recorded. */
  readonly enabled: boolean;
  /** Writes one pushback to the ledger; throws on a failure (outbound retries it). */
  capture(p: TacitPushback): Promise<void>;
  /** The ledger's entries in `state`. */
  list(state: string): Promise<readonly TacitEntry[]>;
  /** Records the owner's verdict on entry `id`, with its note when one is given. */
  verdict(id: string, verdict: string, note?: TacitVerdictNote): Promise<void>;
}
