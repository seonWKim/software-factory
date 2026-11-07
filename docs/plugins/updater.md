# Updater

What it does: keeps `npm run factory -- dev` on the latest commit of `origin/<base_branch>`. `dev` starts a supervisor; the updater decides where controller + worker run from and when they restart. `controller`, `worker` and the other commands never use it.

Plugins:

- `git-worktree`: `GitWorktreeUpdater`. The default.
  - Folders: every version runs from its own detached git worktree, `<state_dir>/versions/<short-rev>` (`.factory/versions/<rev>`). First start: creates the folder at `origin/<base_branch>`, links its `node_modules` to the install for its `package-lock.json` (`.factory/deps/<lock hash>/node_modules`; `npm ci` runs in the folder only for a lock file with no install yet, and the result moves into `deps/`), runs `npm run build` and forks the child from `<folder>/dist/main.js`. The child reads `factory.config.json` and `prompts/` from its folder (`SOFTWARE_FACTORY_CODE_ROOT`, set by the supervisor); its state stays in the main checkout: `state_dir`, `worktrees_dir`, `repo.path`, the database, `.factory/storage` and the secret file. The supervisor writes the child's pid to `<folder>/.factory-pid`.
  - Every `poll_interval_ms`: `git fetch origin <base_branch>`. A change to `src/`, `prompts/`, `package.json`, `package-lock.json`, `tsconfig*.json` or `factory.config.json` is built in a new folder while the old child keeps claiming. Only if that build succeeds, start-then-drain (overlap): the new child starts in the same step, then each older child is asked to drain (an IPC message, no new signal); it stops claiming, finishes its in-flight run from its own folder, acknowledges and exits. The supervisor does not wait for it. An old child that has not exited `run_timeout_ms` plus 60 s after its drain request is hard-stopped (SIGKILL) and the log says so as an error. Its exit while draining is not a crash.
  - Worker index ranges: each child gets `SF_WORKER_INDEX_BASE`, the lowest block of `max_workers` indexes (absent: `workers`; from the new folder's `factory.config.json`) no live child uses; its worker pool numbers workers from there, so old and new children never share an `SF_WORKER_INDEX`.
  - Any other change (docs) only fast-forwards the newest folder; older live folders and every child are left alone.
  - A failed build (or `npm ci`) starts, drains and kills nothing; the old child keeps claiming. Its folder is removed at once and nothing is left in `deps/`. The log has the failing step and the tail of its output; the next new commit is tried. A crashed child is restarted on the next poll from its own folder, only if that folder built.
  - Cleanup: kept are the folders with a live child plus the newest one (or, while that one runs, the newest built folder not already kept); any other folder is removed after its process exited and no kept folder links into it, through `git worktree remove --force` (plain deletion if that fails) and `git worktree prune`. An install in `deps/` is removed when no kept folder links to it.
  - Orphan sweep on supervisor start: every folder under `versions/` whose `.factory-pid` is missing or names a dead process is removed, except the newest one when its build matches `origin/<base_branch>` (reused, no rebuild). A folder whose pid is alive is kept. The first start under this layout also removes the legacy `.factory/runtime` and `.factory/runtime-next` worktrees, once the sweep finds no live child.
  - SIGINT/SIGTERM to `dev` stops every live child, old and new (SIGTERM, SIGKILL after the drain timeout), and returns after all have exited. One supervisor per state directory is assumed.
  - Your checkout is fast-forwarded (`git merge --ff-only origin/<base_branch>`, i.e. `git pull --ff-only` after the fetch) only when it is on the base branch and `git status --porcelain` is empty; otherwise the log says why it was skipped (not on base, dirty, or ff failed). The updater never checks out, stashes, resets or switches branches in it.
  - Enable: `"plugins": { "updater": "git-worktree", ... }`, or no `plugins` object. Secrets: none (git uses your usual credentials for `fetch`). Settings: `repo.base_branch`, `state_dir`, `poll_interval_ms`, `run_timeout_ms`; `git` and `npm` on `PATH`.
  - Behaviour change: `dev` runs `origin/<base_branch>`, not your working tree. Uncommitted edits, local branches and commits merged locally but not pushed never run under `dev` until they are pushed and merged.
- `none`: `NoneUpdater`. `dev` runs controller + worker in place, from the checkout it was started in, exactly as before the updater existed. No git or process calls.
  - Enable: `"plugins": { "updater": "none", ... }`. Secrets: none.

Switch back / turn it off: `"plugins": { "updater": "none" }` (add the guards too if you write a `plugins` object, see [selection.md](selection.md)). The supervisor itself reads `plugins.updater`, `repo.base_branch`, `poll_interval_ms` and `run_timeout_ms` from the checkout it was started in; restart `dev` after changing them.

The `git-worktree` updater also writes `<state_dir>/supervisor.json` (what it is doing: running, building, draining, restarting, build_failed, crashed with the child's error, stopped) for the status page's banner. `none` writes nothing, and the page then shows no banner state beyond "stopped".

## History

No earlier decision is recorded for this topic.
- **Worker index block size** (changed 2026-11-07). Before: the block was `workers` wide; it is `max_workers` wide now, since the pool has that many slots and the live `workers` setting can raise the count up to it.
