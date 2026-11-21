# History of 04-pre-push-gates: done-when checks in the implement run's check round

- **The PR body listed only the check commands** (decision changed 2026-11-22, RFC 0024 WP3 phase 2, "Done-when checks run in the round").
- Before, the PR body bullet read: "A successful run's PR body has one "Checked before push: `<command>` passed" line per command (`(after one fix step)` when one ran), and no other line, under its `## Tests` heading". The item's done-when checks (phase 1, 04-triage) were stored but no run executed them, so nothing in the PR said which done-when lines a person still had to check.
- Now: after those lines, one "Not run, a person checks it" line per `manual` done-when line.

- **Notes moved here to keep the topic file under its size cap** (2026-11-22).
  - One check list: this repo lists `npm run typecheck`, then `npm test`, the `run:` steps of `.github/workflows/test.yml` minus `npm ci`; `tests/check-commands.test.ts` fails when a workflow step has no entry or an entry has no step.
  - One fix step: its transcript is `<run>.fix.json`.
  - Second failure: the run code `checks_failed` is not the controller's `checks_failed` blocked reason (a failed PR check, §5 CI gate); the two never meet in one table.
  - Base rerun: the worktree is made with `git worktree add --detach`, hooks off, never in the live checkout, and removed afterwards with `git worktree remove --force`, then `prune`.
  - Diff budget during the agent step: the read cannot be changed by the agent's writable git folder. HEAD is resolved through the trusted git env, then the diff runs with `GIT_DIR` set to an empty bare git folder the worker makes for it (`mktemp -d`, `git init --bare --template=`), `GIT_OBJECT_DIRECTORY` the run's objects, no system or global config, and hooks off; the folder is removed after the read.
