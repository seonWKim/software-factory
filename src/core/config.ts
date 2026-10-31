import type { Tier } from "./types.js";

/** Runtime config for core code. Built by the composition root; core never reads env or files itself. */
export interface FactoryConfig {
  repo: { owner: string; name: string; path: string; base_branch: string };
  intake_label: string;
  /** Factory PR branches are `${branch_prefix}${work_item_id}`. The broker pushes nowhere else. */
  branch_prefix: string;
  dials: { spec_gate_min_tier: Tier; auto_merge_max_tier: 0 };
  /** Human floor directories (design §3): touching a prefix raises the tier to at least `tier`. */
  floors: { prefix: string; tier: Tier }[];
  max_loops: number;
  max_attempts: number;
  lease_ms: number;
  heartbeat_ms: number;
  tick_ms: number;
  poll_interval_ms: number;
  run_timeout_ms: number;
  /** Paths agent runs may never read (G3/G4). Absolute. */
  deny_paths: string[];
  agent_git_identity: { name: string; email: string };
}

export interface Prompts {
  triage: string;
  implement: string;
  review: string;
}
