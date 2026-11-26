# Settings catalog: worker

The settings that `src/worker/` reads; the index is [docs/settings.md](../settings.md).
Generated from the `*.setting.ts` files by `npm run settings:catalog`; do not edit by hand.
Direction: `tighten-only` keys may only be tightened by a lower level (owner → org → project → pack → user);
`review` keys change only by a reviewed PR to factory.config.json. Guards are never loosened.

| Key | Owner | Changed by | Scope | Direction | Class | Default | What it controls |
|---|---|---|---|---|---|---|---|
| `agent_stop_check_ms` | worker | runtime | global | free |  | `2400000` | Longest the gate Stop check (the check list run when an agent tries to finish) may take. |
| `auth_pause_ms` | worker | runtime | global | free |  | `1800000` | How long a forge 401 or 403 pauses implement-type claims; with no value, it follows retry_max_ms. |
| `first_output_ms` | worker | runtime | global | free |  | `180000` | Longest an agent run may go from its start with no model output before it counts as stalled. |
| `heartbeat_ms` | worker | runtime | global | free |  | `60000` | How often a worker renews the lease on the step it runs. |
| `lease_ms` | worker | runtime | global | free |  | `300000` | How long a claimed step stays held by a worker without a lease renewal. |
| `max_diff_files` | worker | runtime | project | tighten-only |  | `40` | Most changed files a branch diff may have before push. |
| `max_diff_lines` | worker | runtime | project | tighten-only |  | `1500` | Most added plus deleted lines a branch diff may have before push. |
| `message_style` | worker | runtime | global | free |  | `""` | The owner's wording and tone for text the agents write, added after each role's instructions. |
| `model_by` | worker | runtime | global | free |  | `{"triage":"cheap","implement":{"1":"standard","2":"standard","3":"strong","4":"strong","5":"strong"},"review":{"1":"standard","2":"standard","3":"strong","4":"strong","5":"strong"},"resolve":{"1":"standard","2":"standard","3":"strong","4":"strong","5":"strong"},"routine":"cheap","retry_up":true}` | Which model class each run kind uses per tier, and whether a retry goes one class up. |
| `models` | worker | runtime | global | free |  | `{"cheap":"haiku","standard":"sonnet","strong":"opus"}` | The model name used for each model class: cheap, standard and strong. |
| `packs.auto_approve_read_only` | worker | review | global | tighten-only |  | `false` | Whether a read-only pack tool with no credential is approved without the owner's approval. |
| `run_timeout_ms` | worker | runtime | global | free |  | `2700000` | Longest an agent run may take before it is stopped. |
| `stall_ms` | worker | runtime | global | free |  | `300000` | Longest an agent run may go with no model output and no open tool call before it counts as stalled. |
| `toolchain` | worker | review | global | free |  |  | Cache folders agents may read but not write, their extra env, and the command that warms them. |
| `worker_kinds` | worker | runtime | global | free |  | `["triage","review","merge-check","update","restart","improve","implement","resolve","screenshot","judge","routine"]` | Run kinds the workers claim; a queued run of another kind waits for an interactive session. |
| `workers` | worker | runtime | global | free |  | `1` | Worker loops in each process that claim and run steps. |
