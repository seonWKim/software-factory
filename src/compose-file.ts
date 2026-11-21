// factory.config.json's shape as read from disk (moved from compose.ts, the composition root, which re-exports it).

import type { OpenAICompatibleConfig } from "./impl/openai/config.js";
import type { SlackConfig } from "./impl/source/slack-config.js";

/** The store is SQLite (design 05-coordination.md): another type fails at startup as an unknown FactoryStore plugin. */
export type StoreConfig = { type: "sqlite" };

export interface FileConfig {
  env: "local" | "cloud";
  store?: StoreConfig;
  /**
   * install_command, test_command: argv, defaults ["npm", "ci"] and ["npm", "test"]. check_commands: a list of
   * argv, the pre-push checks (design §4); absent: [test_command]. ui_check: the merge-time UI check (uiCheckConfig).
   * restart_command: argv, the restart run's command (design 04-gate-commands, restart); absent: off. */
  repo: {
    owner: string; name: string; path: string; base_branch: string;
    install_command?: unknown; test_command?: unknown; check_commands?: unknown; ui_check?: unknown; restart_command?: unknown;
  };
  intake_label: string;
  /** Prefix of the status labels (docs/plugins.md, SourceAdapter). Absent: "sf: ". */
  status_label_prefix?: string;
  branch_prefix: string;
  dials: { spec_gate_min_tier: number; auto_merge_max_tier: number };
  /** Human floors (design §3). A per-project setting: may move into `defaults`, and a project may add to it. */
  floors?: { prefix: string; tier: number }[];
  /**
   * Removed (design 08-permissions, One owner): no longer read, a config that has it loads with one warning. Typed
   * only for the unselected `static` grant plugin's descriptor, which phase B of issue #575 deletes with this line.
   */
  permissions?: { grants?: unknown; static?: unknown };
  /**
   * Plugin name per interface (docs/plugins.md). Absent: today's defaults. Guards can never be disabled.
   * `source` may be a list of names, one adapter each (design 2026-11-01).
   */
  plugins?: Record<string, unknown>;
  calendar?: unknown; calendar_ids?: unknown; // CalendarSource plugin names, in order, and the calendars a provider reads (docs/plugins/calendar-source.md). Absent or []: none.
  models: { cheap: string; standard: string; strong: string };
  /**
   * Model class per run kind and tier, plus `retry_up` (design §4, 2026-11-02). Absent: DEFAULT_MODEL_BY.
   * Checked by parseModelBy (src/core/model-choice.ts).
   */
  model_by?: unknown;
  max_loops: number;
  /** A split phase's spec counts as approved by the parent's `/approve`. Absent: false. */
  phases_auto_approve?: boolean;
  /** Task failures of one step before it blocks on a human. Per-project setting; absent everywhere: 3. */
  max_attempts?: number;
  /** Infra failures of one step before it blocks on a human. Absent: 3. */
  max_restart?: number;
  /** First automatic retry wait; doubles each retry. Absent: 60000. */
  retry_base_ms?: number;
  /** Cap on a retry wait, and the rate-limit pause with no reset time. Absent: 1800000. */
  retry_max_ms?: number;
  auth_pause_ms?: number; // forge-auth and preflight-access pause (design §5 Restarts). Absent: retry_max_ms.
  /** Pre-push size gate (design §4): added plus deleted lines. Absent: 1500. */
  max_diff_lines?: number;
  /** Pre-push size gate (design §4): changed files. Absent: 40. */
  max_diff_files?: number;
  /** Stall detection (design §5 Restarts): ms of silence that ends an agent run `stalled`. Absent: 300000. */
  stall_ms?: number;
  /** First-output limit (design §5 Restarts): ms with no model output from the start that ends a run `stalled`. Absent: 180000. */
  first_output_ms?: number;
  /** How often a stall pause probes the cheap model. Absent: 600000. */
  probe_interval_ms?: number;
  /** The alarm step's thresholds (design 05-alarms). Settable live. Absent: 3, 60 and 5 (ALARM_DEFAULTS). */
  alarm_repeat_count?: number;
  alarm_window_minutes?: number;
  alarm_restart_count?: number;
  /** The gate hooks' Stop hook (design §4): the most times it sends an implement run's agent back. Absent: 3. */
  agent_stop_checks?: number;
  lease_ms: number;
  heartbeat_ms: number;
  tick_ms: number;
  poll_interval_ms: number;
  run_timeout_ms: number;
  /** Deprecated (design 08-retention): `retention.raw_records_days` when that is absent, with a warning. Positive integer. */
  inbox_retention_days?: number;
  retention?: { outbox_days?: unknown; commands_days?: unknown; records_days?: unknown; raw_records_days?: unknown }; // design 08-retention; absent: 30, 30, 90, 7
  /** Outbound (RFC 0015 §15.1): `batching` per destination kind. Absent: `auto` everywhere. */
  outbound?: { batching?: unknown };
  /** The merge queue (RFC 0015 §7): `depth`, the speculative depth (absent: 1); `push_base`, the local forge's base push (absent: off). */
  merge_queue?: { depth?: unknown; push_base?: unknown };
  /** Hook names the owner enabled (RFC 0015 §15.2). Absent: none. Checked against the discovered hooks at startup. */
  hooks?: unknown;
  /** Worker loops per `dev` / `worker` process (architecture §4). Absent: 1. */
  workers?: unknown;
  /** Worker slots per process, the most the live `workers` setting can reach. Absent: `workers`. */
  max_workers?: unknown;
  state_dir: string;
  worktrees_dir: string;
  agent_git_identity: { name: string; email: string };
  /**
   * The status page (`factory ui`). Always bound to 127.0.0.1; there is no host option. `user_id`: the factory
   * user ID the page's commands act as (issue #227); absent, they act as the CLI identity (uiCommandsActor).
   */
  ui?: { port?: number; user_id?: string };
  /** The git-worktree updater (checked by updaterConfig): `auto_migrate` (default false), `code_update_interval_ms` (default 15 min). */
  updater?: { auto_migrate?: unknown; code_update_interval_ms?: unknown };
  /**
   * The GitHub client: `min_remaining` (default 200), the rate-limit floor under which optional reads wait for the
   * reset; `budget_share` (default 1), the part of the hourly core limit this process may count. The GitHub source: `history_since` (absent: none), a date to check merges back to (design §5, Merges).
   */
  github?: { min_remaining?: unknown; budget_share?: unknown; history_since?: unknown };
  /** Token budget per tier, e.g. {"2": 2000000} (design §6). Absent: no limits. Checked by settingsLayers. */
  budgets?: unknown;
  /** Finished items a tier needs before suggestions come from history. Absent: 10. */
  budget_min_sample?: unknown;
  /** `factory stats` (design §6): a weight per verdict severity (all required), min_sample (absent: 10). */
  stats?: { weights?: unknown; min_sample?: unknown };
  /**
   * The global value of each per-project setting (max_attempts, max_diff_lines, max_diff_files, budgets,
   * floors). The same key at top level still works; setting it in both places fails (design 2026-11-01).
   */
  defaults?: unknown;
  /**
   * Overrides per project ID ("owner/name", the configured repo's only; re-keyed to its project key at startup).
   * Per-project keys only, and each may only tighten its gate against the global value. Checked by settingsLayers (src/core/settings.ts).
   */
  projects?: unknown;
  /**
   * Broker tools granted to agent runs: a run kind to a list of tool names, e.g. {"implement": ["forge.preflight"]}.
   * Absent: no grants. Checked at startup against the broker's tools (toolGrantsConfig, src/core/config.ts): only
   * read-only tools the broker lists, only run kinds.
   */
  tool_grants?: unknown;
  /**
   * An OpenAI-style chat completions endpoint (src/impl/openai/config.ts): `base_url` (https, or http only to
   * localhost, 127.0.0.1 or [::1]) and a model name per class. Checked at load; no plugin reads it yet.
   */
  openai_compatible?: OpenAICompatibleConfig;
  /**
   * The `slack` source (issue #109, src/impl/source/slack-config.ts): `channels`, the Slack channel IDs it listens
   * in. Checked at load; required once `plugins.source` lists `slack`, ignored otherwise.
   */
  slack?: SlackConfig;
  /**
   * Path companions (design 04-triage.md): a list of `{ when, also }`. When triage's `files_to_change` names
   * `when`, each `also` path is added to `allowed_paths`. Absent: none. Checked by pathCompanionsConfig.
   */
  path_companions?: unknown;
  /**
   * The project's toolchain (design 05-sandbox.md, issue #334): `caches` (folders the agent may read, never
   * write), `env` (non-secret agent env entries) and `warm_command` (argv the worker runs before the agent, with
   * the network; absent: `repo.install_command`). Absent: none of it. A PR-only key. Checked by toolchainConfig.
   */
  toolchain?: unknown;
  /**
   * Read-only input folders (design 05-sandbox.md): a project's source data outside its repo, which the agents may
   * read and never write, with the toolchain caches' rules. Absent: none. Checked by readOnlyInputsConfig.
   */
  read_only_inputs?: unknown;
  /**
   * Packs (design 11-packs.md): `order`, the layers in order (absent: base, org, project, learned; base first,
   * learned last), `org`, the org pack's folder (absent: no org layer), and `auto_approve_read_only` (absent: false).
   * Checked by packsProblems.
   */
  packs?: { order?: unknown; org?: unknown; auto_approve_read_only?: unknown };
}
