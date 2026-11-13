# ExecutionEngine

What it does: runs each worker run as named steps (RFC 0015 §7 Workers, [10-event-driven.md](../design/10-event-driven.md), "Runs execute as journaled steps"). A step an earlier attempt finished returns its stored result instead of running again, so a run the controller's reaper requeued resumes after its last finished step on its next claim. The engine also holds the run's lease: it renews it on the worker's `heartbeat` tick and aborts the run when the lease is lost or its deadline passed. It takes no run over itself: the controller's reaper is the one takeover path.

Interface (`src/worker/engine/index.ts`): the plugin builds an `ExecutionEngines`, whose `create(options)` gives each worker loop its `ExecutionEngine` (`claim`, `adopt`, `step`, `complete`, `release`, `heartbeat`). The contract is `tests/execution-engine-contract.test.ts`, on SQLite.

Plugins:

- `journal`: `JournalEngines` (`src/worker/engine/plugins/journal/`). The step journal in the store's own database: `worker_run_steps` (one row per run and step, the result as JSON), `worker_runs.code_version` and `worker_runs.deadline_at` (migration `20261108T1730-worker-run-journal`). Writes are fenced by the run's lease token. Needs a SQL store (`sqlite`).
  - Enable: `"plugins": { "engine": "journal", ... }`, or leave `engine` out: it is the default. Secrets: none. Settings: none; each run kind's named timeouts live in its `src/worker/runs/<kind>/<kind>.run.ts`.

The `journal` plugin runs on SQLite, one machine: any worker process may claim a requeued run and resume it, and a run journaled by another `code_version` is resumed only by code that declares it can resume it.

Turn on / off: it cannot be turned off, and there is no other plugin yet. Temporal and Restate engines implement the same contract later.

## History

- **Current text names SQLite only** (decision changed 2026-11-11, issue #567). Before: the contract test ran on SQLite and MySQL, the journal needed a SQL store (`sqlite` or `mysql`), and the solo and enterprise paragraph said enterprise ran MySQL, where any worker on any host could claim a requeued run.
- 2026-11-08 (M6 leftovers): the engine had `attach` and `reap` (a `reaper` tick that took runs with an expired lease over in place and failed runs past their deadline). Removed: the controller's reaper requeues instead, so there is one takeover path.
