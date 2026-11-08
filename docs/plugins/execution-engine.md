# ExecutionEngine

What it does: runs each worker run as named steps (RFC 0015 §7 Workers, [10-event-driven.md](../design/10-event-driven.md), "Runs execute as journaled steps"). A step an earlier attempt finished returns its stored result instead of running again, so a run another worker takes over resumes after its last finished step. The engine also holds the run's lease: it renews it on the worker's `heartbeat` tick and aborts the run when the lease is lost.

Interface (`src/worker/engine/index.ts`): the plugin builds an `ExecutionEngines`, whose `create(options)` gives each worker loop its `ExecutionEngine` (`claim`, `adopt`, `step`, `complete`, `release`, `attach`, `heartbeat`, `reap`). The contract is `tests/execution-engine-contract.test.ts`, on SQLite and MySQL.

Plugins:

- `journal`: `JournalEngines` (`src/worker/engine/plugins/journal/`). The step journal in the store's own database: `worker_run_steps` (one row per run and step, the result as JSON), `worker_runs.code_version` and `worker_runs.deadline_at` (migration `20261108T1730-worker-run-journal`). Writes are fenced by the run's lease token. Needs a SQL store (`sqlite` or `mysql`).
  - Enable: `"plugins": { "engine": "journal", ... }`, or leave `engine` out: it is the default. Secrets: none. Settings: none; each run kind's named timeouts live in its `src/worker/runs/<kind>/<kind>.run.ts`.

Solo developer and enterprise team: the same `journal` plugin. Solo: SQLite, one machine. Enterprise: MySQL; any worker on any host may take a run over, and a run journaled by another `code_version` is resumed only by code that declares it can resume it.

Turn on / off: it cannot be turned off, and there is no other plugin yet. Temporal and Restate engines implement the same contract later.

## History

No earlier decision is recorded for this topic.
