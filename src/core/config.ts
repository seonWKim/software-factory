import type { SettingsLayers } from "./settings.js";
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
  /**
   * `install_command` and `test_command`: argv (no shell) of the gate commands. The update run runs the test
   * command on a merged branch; the resolve run runs install, then test, before any push. Defaults
   * ["npm", "ci"] and ["npm", "test"].
   */
  repo: { owner: string; name: string; path: string; base_branch: string; install_command: string[]; test_command: string[] };
  intake_label: string;
  /** Status labels are this prefix plus a fixed suffix, e.g. "sf: needs approval". Default "sf: ". */
  status_label_prefix: string;
  /** Factory PR branches are `${branch_prefix}${work_item_id}`. The broker pushes nowhere else. */
  branch_prefix: string;
  dials: { spec_gate_min_tier: Tier; auto_merge_max_tier: 0 };
  /**
   * The per-project gate settings in layers: max_attempts, max_diff_lines, max_diff_files, budgets, floors
   * (design 2026-11-01). Read only through settingsFor / settingValues (src/core/settings.ts), never directly.
   */
  settings: SettingsLayers;
  max_loops: number;
  /** Infra failures (lease loss, timeout, exception) of one step before it blocks on a human. Default 3. */
  max_restart: number;
  /** First automatic retry waits this long; each next one twice as long. Default 60000. */
  retry_base_ms: number;
  /** Cap on a retry wait, and the pause after a rate limit with no reset time. Default 1800000. */
  retry_max_ms: number;
  lease_ms: number;
  heartbeat_ms: number;
  tick_ms: number;
  poll_interval_ms: number;
  run_timeout_ms: number;
  /**
   * Stream intake: inbox rows older than this many days, and already behind their source's inbox cursor,
   * are deleted by the controller's cleanup. Default 14.
   */
  inbox_retention_days: number;
  /** Worker loops in one `dev` or `worker` process (architecture §4). An integer of 1 or more; default 1. */
  workers: number;
  /** Paths agent runs may never read (G3/G4). Absolute. */
  deny_paths: string[];
  agent_git_identity: { name: string; email: string };
  /** Finished items a tier needs before budget suggestions come from its history. Absent: 10. */
  budget_min_sample?: number;
}

export interface Prompts {
  triage: string;
  implement: string;
  review: string;
  /** prompts/resolve.md. Absent when the file is missing; a resolve run then fails with `prompt_missing`. */
  resolve?: string;
}
