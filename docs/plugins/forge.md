# Forge

What it does: the forge is where pull requests live. The `Forge` interface (`src/interfaces/forge.ts`) is the factory's only way to PRs (issue #273, phase 2 of #172):

- **PR events.** `poll(cursor)` returns the PR events (`pr_merged`, `pr_closed`, `pr_open`, `pr_unmergeable`, `pr_changes_requested`) and the next cursor. The controller polls it on `poll_interval_ms`, under its own guard (a forge that fails does not stop the sources' intake in the same tick, and its cursor does not move), through the cursor `forge:<ref type>` (`forge:github_issue`). The poll sources are read first and the forge after them, and the forge's events are handled first, so a merge that closed its issue is applied before the issue's close. While that cursor is empty the forge's `handover_cursor` is its first cursor (below).
- **PR facts.** `prChecks` (the checks on a PR's head commit), `prFiles` (the paths a PR changes), `labelAddedBy` (who put a label on a PR), `commitAuthor` (the forge account behind a commit).
- **PR writes.** `postPrComment` (one comment per marker on a PR), `setPrStatus` (the item's status on its PR), `closePr` (close a factory PR after one comment). A PR comment is an item thread entry whose outbox row targets the forge's PR ref (`prRef`, rows of type `ref_type`); the outbox step posts it through the forge, recognising the ref with `prNumberOf`, whatever source the item came from. So a Slack or local item's PR gets its comments and labels on the PR.

**Which forge.** No forge plugin is a default. `plugins.forge` left out follows the sources (derived in `src/compose.ts`, `withForgeDefault`; not a setting): `github` when `plugins.source` lists `github-issues`, none otherwise. One rule for both use cases:

- Solo default: `"source": ["local"]` (or `[]`): no forge, no GitHub call at all. PR events stop; no item's PR is read, labelled or commented on.
- Enterprise: `github-issues` (plus any other sources): the `github` forge, with the same reads as before.

`"none"` (or `null`, `false`, `""`) selects no forge. Next to `github-issues` an off value fails startup with a message naming `plugins.forge` and `github-issues`: that source's PRs would never close their items (one silent path fewer; it may be allowed later if someone needs it). An unknown name fails startup, naming `Forge`, `plugins.forge` and every available name. The forge is never a guard.

Plugins:

- `github`: `GitHubForge` (`src/impl/forge/github-forge.ts`). Every PR read the factory makes, through the configured GitHub credentials (`plugins.github_auth`) and the shared `GitHubClient` (ETag cache, rate-limit budget).
  - Poll: the closed-PR list (newest-updated first, stopping at the cursor; one GET per merged PR for its merger), the open-PR list (`pr_open` for every factory PR and every other non-draft PR against the base from this repository; one GET per factory PR for `mergeable`), and the "Request changes" reviews of the PRs it reported open. Under `github.min_remaining` the per-PR reads and the reviews wait for the reset. With `github-issues` the source makes none of these reads, so one poll tick makes the same GitHub calls as when the source read PRs itself, each once.
  - Merges and the starting point (design 05-sources, Merges): the first poll stores `start` in its JSON cursor, from the Clock in GitHub's UTC format (`2026-11-07T00:00:00Z`), even when the repository has no closed PR. A PR merged before `start` gets no merger read and no `pr_merged`, so a first start on an old repository makes only the list read and flags no past merge. A cursor without `start` keeps its place: its closed-PR time becomes `start`.
  - `github.history_since` (optional, a date like `2026-01-01` or a UTC time; anything else fails at startup naming the setting): checks merges back to that time. Older than `start`, it moves `start` back once: that poll reads closed PRs back to it, at most 5 pages of 100, with one GET per merged PR, and the cursor records the value so a restart does not read it again. Not older (or already applied), it is ignored, with one warning naming the setting.
  - Upgrade (`handover_cursor`: `intake:github_issue`): before issue #273 the PR position (`pulls`, `start`, `history_since`, `reviews`, `review_ids`) lived in the GitHub source's cursor, under the same names. The forge's first poll starts from that cursor, so a merge during the upgrade is not missed and one already applied is not applied again (a boundary PR may come back; handling is idempotent). A fresh install has no such cursor: the forge starts empty and reads one page of closed PRs.
  - PR comments and labels go through a `GitHubIssueSource` with the store (`postComment` and `setStatus` on the PR ref; PRs share the issues API), so they use the same posted-comment and label-state records as issue ones (design 05-sources, GitHub sync records). build() passes the store, the Clock and a log beside the forge context; built without them (`Plugins.forge(github)` alone) it records nothing and cannot poll.
  - Enable: list `github-issues` in `plugins.source`, or set `"plugins": { "forge": "github", ... }`.
  - Secrets: none of its own (the shared client's `GitHubCredentials`).

Switch back / disable: drop `github-issues` from `plugins.source` and leave `plugins.forge` out, or set it to `"none"` with no `github-issues`.

## History

- **The forge reads PRs** (decision changed 2026-11-07, issue #273, phase 2 of #172). Before: selecting a forge only loaded it; the controller read every PR event and PR fact from the `github-issues` source and sent PR comments and PR status to the `github_issue` adapter, and `plugins.forge` left out meant no forge.
- **An optional Forge** (new decision, 2026-11-07, issue #272, phase 1 of #172). Before: the PR facts lived only on the `github-issues` source, and every non-guard kind needed a default plugin.
