# 9. Status page: factory status banner

- **Factory status banner.** The git-worktree updater writes `<state_dir>/supervisor.json` (`SupervisorStatus`: running, building, draining, restarting, build_failed, crashed or stopped; the running and target revision; the child pid; since when) on every change, atomically. `factory ui` reads it and shows a banner at the top: while draining, that new runs are paused until the old process's N in-flight runs finish (counted from the running runs whose lease owner carries that pid), that the new revision then starts with `workers` from the config, and that code and settings changes apply when it starts. A child pid that is no longer alive reads as stopped; no file reads as stopped. A child that exits on its own is `crashed`: before exiting on an error it sends the message it prints (e.g. "schema step pending: run `npm run migrate`") over IPC, the banner shows it, and a crash loop keeps the time of its first crash (since 2026-11-02). A drained child also handles finished runs once more before it exits, so the run the drain waited on is not left unhandled until the next process. The page stays read-only.

## History

- **Factory status banner** (new decision, 2026-11-01). Before: the page could not tell an update drain from idle workers, so with `workers: 10` and two runs going it looked like the setting was ignored.
- **Crash message on the banner** (2026-11-02). Before: a pending migration kept the factory down for 77 min with no sign outside the log.
