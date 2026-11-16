## History

- **Slowest test files on main** (new decision, 2026-11-09, issue #469). Before: job `test` printed only vitest's default output, so nothing ranked the slow test files.

- **Unchanged head and red main** (decision changed 2026-11-16; changed "Unchanged head" of the 2026-11-08 decision). Before: failed checks after a review that skipped an unchanged head took the same path as any failed checks (`checks_failed`, `loop_count + 1`, `RUNNING`, a new implement run; at `max_loops` a block on a human with `max_loops`), with `unchanged_head: true` in the detail and the next implement prompt saying `The previous attempt pushed no commit`; and failed checks that also failed on the base branch looped like any others. Work item wi_4baead09 (#369) used four loops on a red main this way.
- **Stalled items swept** (decision changed 2026-11-08). Before: "Items already stalled this way are not repaired." PR #399 stayed in `REVIEW` with failed checks and nothing polling it.
- **Failed checks on an unchanged head** (decision changed 2026-11-08). Before: a review that skipped an unchanged head was only acked, so an implement run of a failed-checks loop that pushed nothing left the item in `REVIEW` with no block and nothing polling it (PR #399); and the loop never looked at whether the PR conflicted with its base before implementing.
- **No golden workflow** (new decision, 2026-11-08, issue #338). Before: the issue proposed `.github/workflows/golden.yml` on pull requests touching `prompts/**`, with the model key as an Actions secret; the owner decided (2026-11-07) the replay runs locally only.

- **CI gate** (new decision, 2026-11-01). Before: a PR that passed review went straight to `merge_pending`, and GitHub ran no tests on PRs, so PR #51 merged with a failing test and nothing showed it.
- **Checks before push** (decision changed 2026-11-03, issue #158). Before: CI was the first place any check ran on an implement run's change.
- **MySQL text removed from the current decisions** (decision changed 2026-11-11, issue #567). Before: the workflow ran "job `test` (...) and job `test-mysql` (a `mysql:8` service, `npm test` with `SF_TEST_MYSQL_URL`)", and the CI gate was "the only place the MySQL tests run when `plugins.test_database` is `none`, and it covers pushes the factory did not make".
