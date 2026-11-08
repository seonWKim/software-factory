# Forge

What it does: the forge is where pull requests live. The `Forge` interface (`src/interfaces/forge.ts`) is the factory's only way to PRs (issue #273, phase 2 of #172):

- **PR events.** `poll(cursor)` returns the PR events (`change_merged`, `change_closed`, `change_open`, `change_unmergeable`, `pr_changes_requested`) and the next cursor. Each names its PR as `change_ref`, the PR number as text (the type the store keeps, design 02); the controller converts it with `prNumber` (`src/core/change-ref.ts`) only for a forge call. The methods below take the PR number as `pr` (a number), and `closePr`'s input names it `pr`. The controller polls it on `poll_interval_ms`, under its own guard (a forge that fails does not stop the sources' intake in the same tick, and its cursor does not move), through the cursor `forge:<ref type>` (`forge:github_issue`). The poll sources are read first and the forge after them, and the forge's events are handled first, so a merge that closed its issue is applied before the issue's close. While that cursor is empty the forge's `handover_cursor` is its first cursor (below).
- **PR facts.** `prChecks` (the checks on a PR's head commit), `prFiles` (the paths a PR changes), `labelAddedBy` (who put a label on a PR), `commitAuthor` (the forge account behind a commit), `commitsBetween(from_sha, to_sha)` (how many commits a push from `from_sha` to `to_sha` added, or null when the forge cannot say; read once per person's push to a factory PR, for the reason of its implicit `changes` verdict, design 04-gate-commands). All read-only.
- **PR writes.** `postPrComment` (one comment per marker on a PR), `setPrStatus` (the item's status on its PR), `closePr` (close a factory PR after one comment; called only by outbound's `github-change` target for a keyed `close_pr` action, RFC 0015 M7). A PR comment is an item thread entry whose outbox row targets the forge's PR ref (`prRef`, rows of type `ref_type`); the outbox step posts it through the forge, recognising the ref with `prNumberOf`, whatever source the item came from. So a Slack or local item's PR gets its comments and labels on the PR.

**Which forge.** No forge plugin is a default. `plugins.forge` left out follows the sources (derived in `src/compose.ts`, `withForgeDefault`; not a setting): `github` when `plugins.source` lists `github-issues`, none otherwise. One rule for both use cases:

- Solo default: `"source": ["local"]` (or `[]`): no forge, no GitHub call at all. PR events stop; no item's PR is read, labelled or commented on.
- Enterprise: `github-issues` (plus any other sources): the `github` forge, with the same reads as before.

**Local items reach the forge only through the base push** (decision changed 2026-11-08, issue #433; design 05-sources, Local items: the base push). A `local` item with no PR commits its local branch through the `local` broker, opens no PR and merges with `factory merge <id>` into the local base branch, after the install and test commands pass on the merge commit in a temporary worktree. The merge's close transition then writes one **base push** row (`outbound_base_pushes`, SQLite migration 41, MySQL step `0041-base-push.sql`) when the selected forge has `pushBase`; the controller's outbox step claims it by a conditional update, has the sandbox fetch origin's base and merge it into the local base when it moved, and calls `pushBase`, retrying with backoff on any failure. A remote base that conflicts finishes the row as `conflict` and leaves the item closed, with one message to push by hand. A local item that already has a PR (opened before #427) keeps its PR path through the GitHub broker, like a GitHub item. No `forges` setting and no new key:

- Solo default: no forge; local items take the local broker and the local merge with no config, and no push row is written.
- Enterprise: the `github` forge and GitHub broker for GitHub items, with local items on the local path beside them on the shared store, where a local merge is one conditional ref update and one conditional item transition, and its base push one claimed row, so two replicas never merge or push one change twice.

- **Run push and PR** (`pushBranch(input)`, `openPr(input)`, optional; RFC 0015 M7): outbound's `github-push` and
  `github-change` targets deliver an implement run's push and PR through them. `pushBranch` moves the remote factory
  branch to the sha the run stored in the factory repo, reconciling first (already there: `already`); `openPr` opens
  the branch's PR or updates the open one. Both throw on a failure, the message starting with its class; outbound
  retries. Absent: no process here delivers a run's push.
- **Base push** (`pushBase(input)`, optional; absent: the forge cannot push a base and no row is queued). Moves the remote base branch to `input.sha` only while it is still at `input.expected_sha`, never running a hook; throws on any failure, and the caller retries.

`"none"` (or `null`, `false`, `""`) selects no forge. Next to `github-issues` an off value fails startup with a message naming `plugins.forge` and `github-issues`: that source's PRs would never close their items (one silent path fewer; it may be allowed later if someone needs it). An unknown name fails startup, naming `Forge`, `plugins.forge` and every available name. The forge is never a guard.

Plugins:

- `github`: `GitHubForge` (`src/impl/github/github-forge.ts`). Every PR read the factory makes, through the configured GitHub credentials (`plugins.github_auth`) and the shared `GitHubClient` (ETag cache, rate-limit budget).
  - Poll: the closed-PR list (newest-updated first, stopping at the cursor; one GET per merged PR for its merger), the open-PR list (`change_open` for every factory PR and every other non-draft PR against the base from this repository; one GET per factory PR for `mergeable`, `change_unmergeable` when it is false), and the "Request changes" reviews of the PRs it reported open. Under `github.min_remaining` the per-PR reads and the reviews wait for the reset. With `github-issues` the source makes none of these reads, so one poll tick makes the same GitHub calls as when the source read PRs itself, each once.
  - Merges and the starting point (design 05-sources, Merges): the first poll stores `start` in its JSON cursor, from the Clock in GitHub's UTC format (`2026-11-07T00:00:00Z`), even when the repository has no closed PR. A PR merged before `start` gets no merger read and no `change_merged`, so a first start on an old repository makes only the list read and flags no past merge. A cursor without `start` keeps its place: its closed-PR time becomes `start`.
  - `github.history_since` (optional, a date like `2026-01-01` or a UTC time; anything else fails at startup naming the setting): checks merges back to that time. Older than `start`, it moves `start` back once: that poll reads closed PRs back to it, at most 5 pages of 100, with one GET per merged PR, and the cursor records the value so a restart does not read it again. Not older (or already applied), it is ignored, with one warning naming the setting.
  - Upgrade (`handover_cursor`: `intake:github_issue`): before issue #273 the PR position (`pulls`, `start`, `history_since`, `reviews`, `review_ids`) lived in the GitHub source's cursor, under the same names. The forge's first poll starts from that cursor, so a merge during the upgrade is not missed and one already applied is not applied again (a boundary PR may come back; handling is idempotent). A fresh install has no such cursor: the forge starts empty and reads one page of closed PRs.
  - PR comments and labels go through a `GitHubIssueSource` with the store (`postComment` and `setStatus` on the PR ref; PRs share the issues API), so they use the same posted-comment and label-state records as issue ones (design 05-sources, GitHub sync records). build() passes the store, the Clock and a log beside the forge context; built without them (`Plugins.forge(github)` alone) it records nothing and cannot poll.
  - `commitsBetween`: one GET of the compare endpoint (`/compare/<from>...<to>`), its `ahead_by`. A 404 or 422 (a sha GitHub does not know, e.g. after a force-push) or no count gives null; any other failure throws, and the controller then records the count as unknown.
  - Events carry `change_ref` as `String(<PR number>)`; the forge turns it back into a number only at a GitHub API call. `setPrStatus` hands the issue source the PR as its `change_ref`.
  - Enable: list `github-issues` in `plugins.source`, or set `"plugins": { "forge": "github", ... }`.
  - `pushBranch`: one `git ls-remote` and, unless the branch is already at the sha, one unforced
    `git push --no-verify <sha>:refs/heads/<branch>` from the factory repo to its origin URL, factory branches only.
    The token comes from the configured GitHub credentials (the forge plugin gets them since RFC 0015 M7) and reaches
    git only through the child's env and an inline credential helper. `openPr`: the open PR for the branch updated
    or a new one opened, then its labels (`src/impl/github/pull-requests.ts`). Outbound's
    `github-push` and `github-change` targets are their only callers (RFC 0015 M7; the broker's `github.push_branch`
    and `github.open_pr` are gone).
  - `pushBase`: one `git push --no-verify --force-with-lease=refs/heads/<base>:<expected_sha> origin <sha>:refs/heads/<base>` from the factory repo (`repo.path`), only for the configured base branch. It goes through the factory repo's own git configuration for origin, as the sandbox's fetches do, and makes no API call. Not built: pushing with the App credentials.
  - Secrets: none of its own (the shared client's `GitHubCredentials`).

Switch back / disable: drop `github-issues` from `plugins.source` and leave `plugins.forge` out, or set it to `"none"` with no `github-issues`.

## History

- **Local items reach the forge only through the base push** (decision changed 2026-11-08, issue #433). Before: local items never reached the forge: a local merge moved only the local base, nothing pushed it to origin, and a local item that already had a PR took the local route too.
- **Local items never reach the forge** (decision changed 2026-11-08, issue #333). Before: with the GitHub broker selected, a local item pushed to origin and opened a PR like a GitHub item.
- **PR events renamed to `change_*`** (decision changed 2026-11-08, phase 3 of the change fields). Before: the events were `pr_merged`, `pr_closed`, `pr_open` and `pr_unmergeable`, each with `pr_number` (a number), and the methods' PR parameter and `ClosePrInput` field were `pr_number`. `pr_changes_requested` keeps its kind name (now with `change_ref`); renaming it is left for later. No event changed what it does.
- **`commitsBetween`** (new method, 2026-11-08, issue #316). Before: the forge could name a commit's author but not count the commits in a push.

- **The forge reads PRs** (decision changed 2026-11-07, issue #273, phase 2 of #172). Before: selecting a forge only loaded it; the controller read every PR event and PR fact from the `github-issues` source and sent PR comments and PR status to the `github_issue` adapter, and `plugins.forge` left out meant no forge.
- **An optional Forge** (new decision, 2026-11-07, issue #272, phase 1 of #172). Before: the PR facts lived only on the `github-issues` source, and every non-guard kind needed a default plugin.
