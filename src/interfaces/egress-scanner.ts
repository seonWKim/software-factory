// G5: every agent output (commits, PR text, comments, handoff rows, run outcomes, logs)
// is checked before it leaves. A hit fails the run; in a transcript, only a known secret or the canary does (docs/design/05-sandbox.md).

// `ui`: stored text the status page sends to a browser (a transcript's steps, design §9); a finding withholds the
// whole field there, it never fails a run.
export type EgressChannel = "commit" | "pr" | "comment" | "handoff" | "run_outcome" | "log" | "tool_result" | "ui";

export type ScanResult =
  | { clean: true }
  /** `findings` name the matched rule, never the matched text. */
  | { clean: false; findings: { rule: string; channel: EgressChannel }[] };

export interface EgressScanner {
  scan(channel: EgressChannel, content: string): Promise<ScanResult>;
}
