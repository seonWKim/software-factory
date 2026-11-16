# 09-status-banner

- **The classic page kept the process-state text** (until 2026-11-16, the app-only banner decision at the top). Before: `/classic` drew its own banner from `supervisor.json` with the process state only; a claim pause showed only on the app's Floor banner.

## History

- **Factory status banner** (new decision, 2026-11-01). Before: the page could not tell an update drain from idle workers, so with `workers: 10` and two runs going it looked like the setting was ignored.
- **Crash message on the banner** (2026-11-02). Before: a pending migration kept the factory down for 77 min with no sign outside the log.
- **Both updaters write the status file** (2026-11-07, #352). Before: only the git-worktree updater wrote it; under `updater: none` there was no file, so the banner said "Factory stopped. No runs start." above runs that were progressing.
- **Pause line on the Floor banner** (decision changed 2026-11-07). Before: the Floor banner read only the supervisor's process state, so it said "Factory running" while every claim was paused.
