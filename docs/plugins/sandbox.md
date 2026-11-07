# Sandbox

What it does: where an agent run happens: create a workspace for a branch, run commands in it, destroy it.


`updateBase(repo, base_ref)` is trusted like `create`: it fetches only the base branch (`+refs/heads/<base_ref>:refs/remotes/origin/<base_ref>`, no `--prune`, no tags) in the factory repo and returns its `origin/<base_ref>` commit. Touching no other ref keeps it from racing other runs' fetches of their own branches. Sync before push copies that commit into the clone from the factory repo, never from the clone's own remote.

Plugins:

- `noop`: `NoOpSandbox`. One clone of the factory repo per run, in its own folder under `worktrees_dir` on the host, no OS isolation (design §5: keep it on test environments only).
  - The clone has its own git folder inside the run folder, not a worktree sharing the owner's `.git`: branches, index, `HEAD`, refs and config an agent changes there never reach the factory repo, and the run gets no writable path outside its folder (architecture §5). Objects are borrowed from the factory repo through an alternates link, not copied; the agent can still read them.
  - `core.hooksPath` points to `<worktrees_dir>/.empty-hooks`, an empty, read-only folder outside every run folder, so a hook the agent puts in the clone's `.git/hooks` never runs. Creation refuses if that folder is not empty.
  - The handle's `base_sha` is the factory repo's `origin/<base>`, resolved before any agent runs; the worker's gates and the broker diff from the factory repo's commit, not the run folder's ref. The clone's `origin` names the real remote for reading only: the broker pushes to the factory repo's remote.
  - `destroy` removes the run folder. Nothing is registered in the factory repo, so `git worktree list` there has no entry for it; a second destroy is a no-op.
  - Fetches in the factory repo are serialized per repo path on the host: `create` (which fetches all of `origin`, so an existing `factory/<id>` branch can be resumed) and `updateBase` wait for each other. A fetch that fails with a ref-lock message (`cannot lock ref`, `incorrect old value`, `unable to update local ref`), meaning another git process moved the ref, is retried up to 3 times with backoff (200, 400, 800 ms); any other failure throws at once.
  - Risk: if the factory repo runs `git gc --prune` during a run and drops an object only a clone still needs, that clone can break. Runs are short, so this is accepted.
  - Vitest in a run folder: its cache goes to `.vite-cache/` in the run folder (`cacheDir` in `vitest.config.ts`, git-ignored), never to `node_modules/.vite`, because a run folder's `node_modules` may be shared and read-only. The test scripts (`scripts.test`, `scripts.test:mysql`) run `vitest run --configLoader runner`: Vite's default `bundle` loader writes the bundled `vitest.config.ts` to `node_modules/.vite-temp` before any config setting applies, which fails with EPERM there (#225). The `runner` loader writes no temp file and works on every supported Node (`native` needs type stripping, which Node 22.13 lacks without a flag). `tests/noop-sandbox.test.ts` runs the run folder's own `npm test` command with a read-only `node_modules` and checks nothing is written under it. The sandbox code is unchanged. Calling vitest directly (`npx vitest run tests/x.test.ts`) skips that flag and still fails; the implement, resolve and review prompts tell agents to use `npm test -- <file>` instead (2026-11-07).
  - With no GitHub plugin selected (`local_only`, design `05-sources.md`, Local startup) nothing fetches origin: the trusted base is the factory repo's local `refs/heads/<base>`, the clone gets the factory repo's local branches as its `refs/remotes/origin/*` and no `origin` remote, `updateBase` and `fetchBranch` read the local branches with no fetch.
  - `mergeLocal` (the local merge, `src/core/local-merge.ts`; the controller calls it for `factory merge <id>`): `git merge-tree --write-tree` then `git commit-tree` in the factory repo, objects only, then `git update-ref refs/heads/<base> <merge> <old base>`, so another merge in between is refused and nothing is lost. No push, no checkout, no index, no hook. A conflict returns the files and moves nothing; a base branch checked out in any worktree is refused; a branch the base already contains returns the base's commit. The method lives on the plugin, not yet on the `Sandbox` interface, like `fetchBranch` and `mergeCheck` it is checked for at runtime (`canMergeLocal`).
  - Enable: `"plugins": { "sandbox": "noop", ... }`. Secrets: none. Settings: `worktrees_dir`.

Switch back / disable: `"sandbox": "noop"`. There is no "off": runs need a workspace.

## History

- 2026-11-07: `create`, `updateBase` and `fetchBranch` always fetched origin and the base was always `origin/<base>`, also with no GitHub plugin selected; there was no local merge. Replaced by the local mode and `mergeLocal` above (design `05-sources.md`, Local startup).
- 2026-11-07: `updateBase` fetched all of `origin` with `--prune`, unserialized, so parallel runs raced on ref locks. Replaced by the base-only, serialized, retried fetch above (#206).
- 2026-11-07: vitest used Vite's default cache, `node_modules/.vite`, and the default `bundle` config loader, which writes to `node_modules/.vite-temp`; both fail in a run folder whose `node_modules` is shared and read-only. Replaced by `.vite-cache/` in the run folder and `--configLoader runner` in the test scripts (#225).
