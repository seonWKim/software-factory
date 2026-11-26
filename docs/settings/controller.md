# Settings catalog: controller

The settings that `src/controller/` reads; the index is [docs/settings.md](../settings.md).
Generated from the `*.setting.ts` files by `npm run settings:catalog`; do not edit by hand.
Direction: `tighten-only` keys may only be tightened by a lower level (owner → org → project → pack → user);
`review` keys change only by a reviewed PR to factory.config.json. Guards are never loosened.

| Key | Owner | Changed by | Scope | Direction | Class | Default | What it controls |
|---|---|---|---|---|---|---|---|
| `alarm_repeat_count` | controller | runtime | global | free |  | `3` | Matching failed runs on distinct items, or zero-token agent runs in a row, that raise an alert. |
| `alarm_restart_count` | controller | runtime | global | free |  | `5` | Child restarts within 30 minutes that raise an alert. |
| `alarm_window_minutes` | controller | runtime | global | free |  | `60` | Minutes over which the alarm counts matching failed runs and zero-token runs. |
| `auto_grant_test_paths` | controller | runtime | project | tighten-only |  | `true` | Whether an implement run asking for test paths, or up to 3 other unprotected files, gets them once. |
| `auto_merge_max_tier` | controller | runtime | global | tighten-only | dial (approve_merge) | `0` | In auto mode, the highest tier (0 to 3) a reviewed local change merges at by itself; 0 is none. |
| `conflict_hotspot_threshold` | controller | runtime | global | free |  | `3` | Conflicts or held items on one file in 7 days that file a task to reduce conflicts on it. |
| `coordinator` | controller | runtime | global | free |  | `false` | Whether the coordinator runs its cycle every 15 minutes and acts on the work items. |
| `dials` | controller | review | global | tighten-only | dial |  | The lowest tier that needs a spec approval; its auto_merge_max_tier stays 0 (the setting decides). |
| `floors` | controller | review | project | tighten-only | dial | `[]` | Paths that raise a work item's tier to at least a given tier when a change touches them. |
| `hold_policy` | controller | runtime | global | free |  | `{"mode":"run_after_minutes","minutes":120}` | What a run held by coordination cost does: wait for /approve, start after some minutes, or start. |
| `hotspot_weight` | controller | runtime | global | tighten-only |  | `3` | Weight of a shared hotspot path in the coordination cost of two runs side by side. |
| `max_attempts` | controller | runtime | project | tighten-only |  | `3` | Task failures of one step before the work item blocks on a human. |
| `max_coordination_cost` | controller | runtime | global | tighten-only |  | `2.5` | Coordination cost at or above which an implement run waits for the work it shares files with. |
| `max_loops` | controller | runtime | global | tighten-only |  | `3` | Review feedback loops on one change before the work item blocks on a human. |
| `max_restart` | controller | runtime | global | tighten-only |  | `3` | Infra failures of one step (lease loss, timeout, crash) before it blocks on a human. |
| `mechanical_weight` | controller | runtime | global | tighten-only |  | `0.25` | Weight of a shared mechanical path (index and History lines), above 0 and below 1.0. |
| `merge_queue.depth` | controller | review | global | free |  | `1` | Merge queue entries checked at once from the head, each on the base plus those ahead (1 to 10). |
| `mode` | controller | runtime | project | free | dial (approve_merge) | `"manual"` | Manual waits for a person at every spec and merge; auto approves and merges what it may itself. |
| `notice_kinds` | controller | runtime | global | free |  | `["spec","merge","failure","other","finished"]` | Which notices are raised: spec, merge, failure, other, finished; a kind left out raises none. |
| `notify_channels` | controller | runtime | global | free |  | `[]` | Source plugins that also get the owner's notices, e.g. slack; one without notifyOwner gets none. |
| `phases_auto_approve` | controller | runtime | global | tighten-only |  | `false` | Whether a phase spec of an approved split needs no approval of its own. |
| `probe_interval_ms` | controller | runtime | global | free |  | `600000` | How often a stall pause probes the cheap model; a failed probe moves the pause this much later. |
| `quiet_hours` | controller | runtime | global | free |  | `""` | Local window, HH:MM-HH:MM, that holds notices until it ends, then sends one summary; empty is off. |
| `retry_base_ms` | controller | runtime | global | free |  | `60000` | Wait before the first automatic retry; each next retry waits twice as long. |
| `retry_max_ms` | controller | runtime | global | free |  | `1800000` | Longest wait between retries, and the pause after a rate limit with no reset time. |
| `review_time` | controller | runtime | global | free |  | `"09:00"` | Local time, HH:MM, until which asks that are no merge and block nothing are held; empty is off. |
| `spend.coordinator_daily_usd` | controller | runtime | global | free |  | `5` | Dollars per UTC day the coordinator's cycles may spend on model calls. |
| `spend.daily_budget_usd` | controller | runtime | global | free |  |  | Dollars per UTC day; spend at 80% and 100% of it alerts once each in Needs you. None: no budget. |
| `spend.weekly_budget_usd` | controller | runtime | global | free |  |  | Dollars per week from Monday UTC; spend at 80% and 100% of it alerts once each. None: no budget. |
| `standing_approvals.threshold` | controller | runtime | global | tighten-only |  | `10` | Spec approvals in a row, with the spec unchanged, before a standing rule is proposed. |
| `summary_evening_time` | controller | runtime | global | free |  | `"22:00"` | Local time, HH:MM in the machine's zone, of the owner's evening summary post. |
| `summary_morning_time` | controller | runtime | global | free |  | `"08:30"` | Local time, HH:MM in the machine's zone, of the owner's morning summary post. |
| `test_globs` | controller | runtime | global | tighten-only |  | `["tests/**","**/*.test.*"]` | Globs of the test files an implement run's ask may be granted automatically. |
