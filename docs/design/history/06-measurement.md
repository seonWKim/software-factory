## History

- **Per-merge evaluation** (decision changed 2026-11-11, issue #512). Before: the store kept merges (`merge_sha`), revert and fix-forward rows, verdicts and token cost apart, and nothing combined them into one result per merge. Stats over the revert and fix-forward rows were "not built yet".
- **Autonomy** (new decision, 2026-11-11, issue #522). Before: the stored push, merge and revert verdicts were only counted together as `implicit`, so neither `factory stats` nor the Data page could say how many merged items needed a person's push.
- **Implicit verdicts in the numbers** (decision changed 2026-11-08, issue #316). Before: stats counted explicit `/verdict` verdicts only, and nothing else wrote one.

- **Golden compare** (new decision, 2026-11-08, issue #338). Before: `golden run` printed one prompt's rates and compared nothing, so a prompt change had no before/after number.

- **Run attempts** (new decision, 2026-11-07, issue #207). Before: one `worker_runs` row per run held only the latest claim: every claim overwrote `started_at`, a resumed paused run reused it, and an earlier claim's end, tokens and error had no record of their own.
- **`factory stats`** (new decision, 2026-11-01). Before: the feedback rate above had no read path, and `factory status` lists only the 50 newest items.
- **Golden set for the reviewer** (decision changed 2026-11-01: measurement now has a golden-set step). Before: "golden PRs" above was a plan with no cases, no runner and no numbers.
- **Revert and fix-forward tracking** (new decision, 2026-11-01). Replaces "revert rate (webhook)".
- **MySQL text removed from the current decisions** (decision changed 2026-11-11, issue #567). Before: the merge evaluations table was "SQLite migration 42, MySQL step `0043-merge-evaluations.sql`", and the run attempts backfill was "SQLite migration 20 (applied on open) and MySQL step `migrations/mysql/0020-run-attempts.sql` (`npm run migrate`; `CREATE TABLE IF NOT EXISTS` and `INSERT IGNORE`, so a rerun adds nothing)".
