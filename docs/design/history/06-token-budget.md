## History

- **Per-tier token budget** (decision changed 2026-11-01). Before: "Per-tier budget → `blocked_on: budget`" was a plan with no limit, no check and no human answer, so an item could spend tokens with no human check.
- **What "tokens" counts, and cost** (decision changed 2026-11-02, issue #136). Before: a run's tokens were input + output only, read from the Claude CLI's JSON result, so cache reads and writes, most of a run's tokens, were never counted; only succeeded runs added to `token_cost`; timed-out and aborted runs recorded zero without reading their output; and no cost was kept anywhere.
- **Ignored runs count** (decision changed 2026-11-07). Before: a succeeded run acknowledged as `run_ignored` (its item closed or blocked while it ran) added nothing to `token_cost`, though its outcome kept its `data.usage`; only failed ignored runs were counted.
- **MySQL text removed from the current decisions** (decision changed 2026-11-11, issue #567). Before: migration 9 was "SQLite and MySQL".
