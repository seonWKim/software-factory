// G5: every agent output (commits, PR text, comments, handoff rows, run outcomes, logs)
// is checked before it leaves. A hit fails the run.

export type EgressChannel = "commit" | "pr" | "comment" | "handoff" | "run_outcome" | "log" | "tool_result";

export type ScanResult =
  | { clean: true }
  /** `findings` name the matched rule, never the matched text. */
  | { clean: false; findings: { rule: string; channel: EgressChannel }[] };

export interface EgressScanner {
  scan(channel: EgressChannel, content: string): Promise<ScanResult>;
}
