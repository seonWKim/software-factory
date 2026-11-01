import type { Tier, VerdictSeverity } from "./types.js";

/**
 * The `stats` key of factory.config.json (design §6 Measurement). Read only by `factory stats`; it changes
 * no dial. Every weight is required (non-negative number); `min_sample` is an integer ≥ 1, default 10.
 */
export interface StatsConfig {
  /** Feedback weight per `/verdict` severity. */
  weights: Record<VerdictSeverity, number>;
  /** A tier with fewer closed items than this shows no rate. */
  min_sample: number;
}

/** Runtime config for core code. Built by the composition root; core never reads env or files itself. */
export interface FactoryConfig {
  /** `test_command`: argv the update run uses to check a merged branch (no shell), e.g. ["npm", "test"]. */
  repo: { owner: string; name: string; path: string; base_branch: string; test_command: string[] };
  intake_label: string;
  /** Status labels are this prefix plus a fixed suffix, e.g. "sf: needs approval". Default "sf: ". */
  status_label_prefix: string;
  /** Factory PR branches are `${branch_prefix}${work_item_id}`. The broker pushes nowhere else. */
  branch_prefix: string;
  dials: { spec_gate_min_tier: Tier; auto_merge_max_tier: 0 };
  /** Human floor directories (design §3): touching a prefix raises the tier to at least `tier`. */
  floors: { prefix: string; tier: Tier }[];
  max_loops: number;
  /** Task failures (bad output, no commits, agent error) of one step before it blocks on a human. */
  max_attempts: number;
  /** Infra failures (lease loss, timeout, exception) of one step before it blocks on a human. Default 3. */
  max_restart: number;
  /** First automatic retry waits this long; each next one twice as long. Default 60000. */
  retry_base_ms: number;
  /** Cap on a retry wait, and the pause after a rate limit with no reset time. Default 1800000. */
  retry_max_ms: number;
  /** Pre-push size gate: added plus deleted lines over the whole branch diff. Default 1500. */
  max_diff_lines: number;
  /** Pre-push size gate: changed files over the whole branch diff. Default 40. */
  max_diff_files: number;
  lease_ms: number;
  heartbeat_ms: number;
  tick_ms: number;
  poll_interval_ms: number;
  run_timeout_ms: number;
  /** Worker loops in one `dev` or `worker` process (architecture §4). An integer of 1 or more; default 1. */
  workers: number;
  /** Paths agent runs may never read (G3/G4). Absolute. */
  deny_paths: string[];
  agent_git_identity: { name: string; email: string };
}

export interface Prompts {
  triage: string;
  implement: string;
  review: string;
}
