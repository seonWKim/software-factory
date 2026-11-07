import type { ExternalIdentity } from "./auth-provider.js";
import type { ClosePrInput, PrChecks, SourceEvent } from "./source-adapter.js";

// The forge: where pull requests live (GitHub today). Optional: config may select none (plugins.forge), and
// no plugin is its default. Issue #172, phase 1: the interface and a selectable plugin only. The controller
// still reads these facts from the GitHub issue source; a later phase moves them here.

/** The PR event kinds a forge reports: merged, closed without merging, open, and open but unmergeable. */
export type ForgePrEventKind = "pr_merged" | "pr_closed" | "pr_open" | "pr_unmergeable";

/** One PR event, in the same shape the source adapters deliver it today. */
export type ForgePrEvent = Extract<SourceEvent, { kind: ForgePrEventKind }>;

/** The PR facts the factory reads from, and the one PR action it takes on, a forge. */
export interface Forge {
  /** The checks on PR `pr_number`'s current head commit (design §5 CI gate). Read-only. */
  prChecks(pr_number: number): Promise<PrChecks>;
  /** The paths PR `pr_number` changes (both sides of a rename). Read-only. */
  prFiles(pr_number: number): Promise<string[]>;
  /** The forge account that authored commit `sha`, or null when it is not linked to one. Read-only. */
  commitAuthor(sha: string): Promise<ExternalIdentity | null>;
  /**
   * Closes factory PR `pr_number` without merging it, after one comment carrying `input.marker`. A PR that is
   * already merged or closed is left alone: `not_open`. Throws on a forge failure; the caller retries.
   */
  closePr(input: ClosePrInput): Promise<"closed" | "not_open">;
}
