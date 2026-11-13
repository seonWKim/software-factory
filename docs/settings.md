# Settings catalog

Generated from the `*.setting.ts` files by `npm run settings:catalog`; do not edit by hand.
Direction: `tighten-only` keys may only be tightened by a lower level (owner → org → project → pack → user);
`review` keys change only by a reviewed PR to factory.config.json. Guards are never loosened.

| Key | Owner | Changed by | Scope | Direction | Class | Default | What it controls |
|---|---|---|---|---|---|---|---|
| `alarm_repeat_count` | controller | runtime | global | free |  | `3` | Matching failed runs on distinct items, or zero-token agent runs in a row, that raise an alert. |
| `alarm_restart_count` | controller | runtime | global | free |  | `5` | Child restarts within 30 minutes that raise an alert. |
| `alarm_window_minutes` | controller | runtime | global | free |  | `60` | Minutes over which the alarm counts matching failed runs and zero-token runs. |
| `auth_pause_ms` | worker | runtime | global | free |  | `1800000` | How long a forge 401 or 403 pauses implement-type claims; with no value, it follows retry_max_ms. |
| `auto_merge_max_tier` | controller | runtime | global | tighten-only | dial (approve_merge) | `0` | In auto mode, the highest tier (0 to 3) a reviewed local change merges at by itself; 0 is none. |
| `broker` | guards | review | global | tighten-only | guard |  | Which tool broker runs the forge actions agents ask for, such as a push. |
| `deny_paths` | guards | review | global | tighten-only | guard |  | Absolute paths that agent runs may never read. |
| `dials` | controller | review | global | tighten-only | dial |  | The lowest tier that needs a spec approval; its auto_merge_max_tier stays 0 (the setting decides). |
| `egress` | guards | review | global | tighten-only | guard |  | Which scanner checks outgoing text and withholds what looks like a secret. |
| `env` | runtime | review | global | free |  |  | Whether the factory runs locally or in the cloud. |
| `first_output_ms` | worker | runtime | global | free |  | `180000` | Longest an agent run may go from its start with no model output before it counts as stalled. |
| `floors` | controller | review | project | tighten-only | dial | `[]` | Paths that raise a work item's tier to at least a given tier when a change touches them. |
| `heartbeat_ms` | worker | runtime | global | free |  | `60000` | How often a worker renews the lease on the step it runs. |
| `hold_policy` | controller | runtime | global | free |  | `{"mode":"hold"}` | What a run held by coordination cost does: wait for /approve, start after some minutes, or start. |
| `hooks` | runtime | review | global | tighten-only |  | `[]` | Hook names the owner enabled; a hook runs only when listed here. Empty: no hook runs. |
| `hotspot_weight` | controller | runtime | global | tighten-only |  | `3` | Weight of a shared hotspot path in the coordination cost of two runs side by side. |
| `intake_label` | inbound | runtime | global | free |  |  | Label that takes a forge issue in as a new work item; an open item keeps the label it has. |
| `integrations` | runtime | runtime | global | free |  | `{}` | Which plugin each integration uses, over the plugins key in factory.config.json. |
| `lease_ms` | worker | runtime | global | free |  | `300000` | How long a claimed step stays held by a worker without a lease renewal. |
| `max_attempts` | controller | runtime | project | tighten-only |  | `3` | Task failures of one step before the work item blocks on a human. |
| `max_coordination_cost` | controller | runtime | global | tighten-only |  | `2.5` | Coordination cost at or above which an implement run waits for the work it shares files with. |
| `max_diff_files` | worker | runtime | project | tighten-only |  | `40` | Most changed files a branch diff may have before push. |
| `max_diff_lines` | worker | runtime | project | tighten-only |  | `1500` | Most added plus deleted lines a branch diff may have before push. |
| `max_loops` | controller | runtime | global | tighten-only |  | `3` | Review feedback loops on one change before the work item blocks on a human. |
| `max_restart` | controller | runtime | global | tighten-only |  | `3` | Infra failures of one step (lease loss, timeout, crash) before it blocks on a human. |
| `mechanical_weight` | controller | runtime | global | tighten-only |  | `0.25` | Weight of a shared mechanical path (index and History lines), above 0 and below 1.0. |
| `merge_queue.depth` | controller | review | global | free |  | `1` | Merge queue entries checked at once from the head, each on the base plus those ahead (1 to 10). |
| `message_style` | worker | runtime | global | free |  | `""` | The owner's wording and tone for text the agents write, added after each role's instructions. |
| `mode` | controller | runtime | project | free | dial (approve_merge) | `"manual"` | Manual waits for a person at every spec and merge; auto approves and merges what it may itself. |
| `model_by` | worker | runtime | global | free |  | `{"triage":"cheap","implement":{"1":"standard","2":"standard","3":"strong","4":"strong","5":"strong"},"review":"standard","resolve":{"1":"standard","2":"standard","3":"strong","4":"strong","5":"strong"},"retry_up":true}` | Which model class each run kind uses per tier, and whether a retry goes one class up. |
| `models` | worker | runtime | global | free |  | `{"cheap":"haiku","standard":"sonnet","strong":"opus"}` | The model name used for each model class: cheap, standard and strong. |
| `notice_kinds` | controller | runtime | global | free |  | `["spec","merge","failure","other","finished"]` | Which notices are raised: spec, merge, failure, other, finished; a kind left out raises none. |
| `notify_channels` | controller | runtime | global | free |  | `[]` | Source plugins that also get the owner's notices, e.g. slack; one without notifyOwner gets none. |
| `outbound.batching` | outbound | review | global | free |  | `{}` | Per destination kind or `*`: batching mode (auto, commit, fixed), debounce, max_wait, max_messages. |
| `packs.auto_approve_read_only` | worker | review | global | tighten-only |  | `false` | Whether a read-only pack tool with no credential is approved without the owner's approval. |
| `phases_auto_approve` | controller | runtime | global | tighten-only |  | `false` | Whether a phase spec of an approved split needs no approval of its own. |
| `plugins` | runtime | review | global | free |  |  | Which named implementation the factory uses for each interface. |
| `poll_interval_ms` | inbound | runtime | global | free |  | `30000` | How often the factory polls the forge for new work items and comments. |
| `probe_interval_ms` | controller | runtime | global | free |  | `600000` | How often a stall pause probes the cheap model; a failed probe moves the pause this much later. |
| `quiet_hours` | controller | runtime | global | free |  | `""` | Local window, HH:MM-HH:MM, that holds notices until it ends, then sends one summary; empty is off. |
| `repo` | runtime | review | global | free |  |  | The repository the factory works on, its base branch and its install and test commands. |
| `retry_base_ms` | controller | runtime | global | free |  | `60000` | Wait before the first automatic retry; each next retry waits twice as long. |
| `retry_max_ms` | controller | runtime | global | free |  | `1800000` | Longest wait between retries, and the pause after a rate limit with no reset time. |
| `run_timeout_ms` | worker | runtime | global | free |  | `2700000` | Longest an agent run may take before it is stopped. |
| `secrets` | guards | review | global | tighten-only | guard |  | Which secret store tools read credentials from; agents never see them. |
| `spend.daily_budget_usd` | controller | runtime | global | free |  |  | Dollars per UTC day; spend at 80% and 100% of it alerts once each in Needs you. None: no budget. |
| `spend.weekly_budget_usd` | controller | runtime | global | free |  |  | Dollars per week from Monday UTC; spend at 80% and 100% of it alerts once each. None: no budget. |
| `stall_ms` | worker | runtime | global | free |  | `300000` | Longest an agent run may go with no model output and no open tool call before it counts as stalled. |
| `standing_approvals.threshold` | controller | runtime | global | tighten-only |  | `10` | Spec approvals in a row, with the spec unchanged, before a standing rule is proposed. |
| `store` | state | review | global | free |  |  | Where the factory keeps its state: the store's driver and location. |
| `tick_ms` | runtime | runtime | global | free |  | `2000` | How often the controller and the worker pool run their loop. |
| `tool_grants` | runtime | runtime | global | tighten-only |  | `{}` | Which read-only tools each role (run kind) may call; a role with no entry gets none. |
| `toolchain` | worker | review | global | free |  |  | Cache folders agents may read but not write, their extra env, and the command that warms them. |
| `workers` | worker | runtime | global | free |  | `1` | Worker loops in each process that claim and run steps. |
