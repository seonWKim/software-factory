# TacitLedger

What it does: captures the owner's pushback in their own tacit-knowledge ledger, so the owner's tools can learn from it (issue #570). A `/revise`, a `/reject` and a `/verdict changes` (also a dashboard revise, reject or changes verdict) each capture one record once the command applied. The capture is an outbound intent (action `tacit_capture`, destination `tacit:ledger`), keyed by the item and the command's comment ID, so a command delivered twice, or handled by two workers, stores one intent. The process that flushes outbound runs the ledger's CLI; the command's stage change never waits on it. Design: [04-gate-commands.md](../design/04-gate-commands.md).

The interface (`src/interfaces/tacit-ledger.ts`) has `capture` (one pushback), `list` (the entries in a state) and `verdict` (the owner's verdict on an entry). Only `capture` is wired in; `list` and `verdict` are not reachable from a command yet.

Plugins:

- `none`: `NoTacitLedger`. No ledger: nothing is captured and no outbound intent is recorded. `list` returns nothing.
  - Enable: `"plugins": { "tacit": "none", ... }`, or leave `tacit` out (the default on every platform). Secrets: none. Settings: none.
- `agents-home`: `AgentsHomeTacitLedger`. Runs the ledger's CLIs in the owner's agents home on this machine. The home is the `AGENTS_HOME` environment variable when set, else `~/.agents`; the path is found by the plugin only, never by core or controller code.
  - Enable: `"plugins": { "tacit": "agents-home", ... }`. Secrets: none. Settings: `AGENTS_HOME` (optional; default `~/.agents`).
  - `capture` runs `<home>/bin/tacit capture --agent software-factory` with one JSON record on stdin, never in argv: `session` (the work item ID), `proposal` (the stored summary of the item's latest finished run: its spec, change or review), `pushback` (the owner's words, verbatim), and `root_reason`, `hypothesis`, `improvement` and `rule_draft` empty (the ledger distils those itself).
  - `list` runs `<home>/bin/tacit list --agent software-factory --state <state> --json` and reads a JSON list from stdout. `verdict` runs `<home>/bin/evolve verdict --agent software-factory` with `{ "id", "verdict" }` as JSON on stdin. These two subcommands were written against stub CLIs, not checked against the real ones.
  - Each CLI call is stopped after 30 seconds and counts as a failure. A failed capture is retried with outbound's backoff (`retry_base_ms`, `retry_max_ms`) and holds only the `tacit:ledger` destination: GitHub, Slack and the factory repo keep sending.
  - The pushback and the proposal pass the egress scanner (G5) before the CLI is called; a flagged text is replaced by the notice that names the rules.
  - The factory never writes under the home: it only runs the CLIs there. The plugin is built in the controller process only; an agent run never gets it, and no agent environment holds the home.
  - No `bin/tacit` at the home: the plugin behaves as `none` and startup goes on.

Not captured: a "Request changes" PR review, implicit verdicts and reverts (a follow-up issue covers the review), and pushbacks stored before the plugin was selected (no backfill). A ledger shared between people is not built (one owner, `docs/design/08-enterprise.md`).

Turn on / off: set `plugins.tacit` to `agents-home` (on) or `none` (off); delete the key to go back to `none`. Captures already recorded and not delivered stay in outbound until a process with the plugin flushes them.

## History

- 2026-11-11 (issue #570): the interface and both plugins added, `none` the default. Before, a pushback was stored only in the factory's own store and left no trace the owner's ledger could read.
- 2026-11-11: `agents-home` added; before, no plugin wrote to the owner's ledger.
