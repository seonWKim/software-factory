# Forge

What it does: the forge is where pull requests live. The `Forge` interface (`src/interfaces/forge.ts`) names the PR event kinds the factory reacts to (`pr_merged`, `pr_closed`, `pr_open`, `pr_unmergeable`) and the PR facts it reads or acts on: `prChecks` (the checks on a PR's head commit), `prFiles` (the paths a PR changes), `commitAuthor` (the forge account behind a commit) and `closePr` (close a factory PR after one comment).

The forge is **optional and not a default**: no forge plugin is marked `default`, so leaving `plugins.forge` out, or setting it to `"none"` (or `null`, `false`, `""`), selects no forge and builds none. It is never a guard, so turning it off is allowed. An unknown name fails startup, naming `Forge`, `plugins.forge` and every available name.

Not wired in yet (issue #172, phase 1): selecting a forge loads and checks it, but the controller does not call it. The controller still reads PR events and facts from the `github-issues` source (`docs/plugins/source-adapter.md`); a later phase moves them here.

Plugins:

- `github`: `GitHubForge`. Each PR fact passes through to the GitHub issue source's method of the same name, through the configured GitHub credentials (`plugins.github_auth`).
  - Enable: `"plugins": { "forge": "github", ... }`
  - Secrets: none.

Switch back / disable: delete `plugins.forge`, or set it to `"none"`.

## History

- **An optional Forge** (new decision, 2026-11-07, issue #272, phase 1 of #172). Before: the PR facts lived only on the `github-issues` source, and every non-guard kind needed a default plugin.
