# 5. Coordination: CI gate

- **CI gate.** Two parts:
  - **Workflow:** `.github/workflows/test.yml` runs on every pull request and every push to `main`: job `test` (`npm ci`, `npm run typecheck`, `npm test`) and job `test-mysql` (a `mysql:8` service, `npm test` with `SF_TEST_MYSQL_URL`). No secrets, `contents: read`. Branch protection on `main` requires the `test` check (SET_UP.md); that is a manual repository setting.
  - **Check gate in the controller:** when a review passes, the controller reads the PR's checks through the new optional `SourceAdapter.prChecks(pr_number)` → `pending` | `passed` | `failed` (with the failed names) before it decides. GitHub (`GitHubIssueSource`): the head commit's check runs (latest per name) and commit statuses; a conclusion other than success / neutral / skipped, or a status `failure` / `error`, is failed; anything unfinished is pending; no checks at all is passed, so a repository without CI is not held. A source without `prChecks` counts as passed.
    - **Passed:** `merge_pending` as before (`review_passed`, the merge comment keyed on the review run).
    - **Pending, or the source failed to answer:** the item stays in `REVIEW` with `blocked_on: ci`, `blocked_reason: checks_pending` (`checks_pending`; no new stage). `tickChecks` runs every `poll_interval_ms` on any replica, re-reads each waiting item and applies the gate again with the latest succeeded review run's id; still pending changes nothing.
    - **Failed:** treated like a review bug: `loop_count + 1`, `RUNNING`, an implement run keyed by `runKey` (`checks_failed`, detail `failed_checks` = JSON array of up to 20 names, each up to 100 characters, and `review_run_id`). At `max_loops` the item blocks on a human with `max_loops` instead. One comment, keyed on the review run, names the checks (G5-scanned; the names are dropped if the scan flags them). The next implement prompt gets a "Failing CI checks to fix" section, fenced as untrusted text, when the item's latest loop-starting change is `checks_failed`.
  - **Known gaps:** the status label for `blocked_on: ci` is `needs human` until `status-label.ts` maps it to `in review`; `setup` does not yet ask for the token's Checks and Commit statuses read permissions (SET_UP.md says to add them by hand). A push after the item reached `merge_pending` is not re-gated; branch protection covers it.

## History

- **CI gate** (new decision, 2026-11-01). Before: a PR that passed review went straight to `merge_pending`, and GitHub ran no tests on PRs, so PR #51 merged with a failing test and nothing showed it.
