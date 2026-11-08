# GitHubCredentials

What it does: supplies the token for every GitHub call: the shared REST client (issues, comments, labels, PRs) and the broker's `git push`. Only those two tool implementations call it; the token never reaches an agent, a prompt, a log or the store (guards G1–G2).

What each plugin builds: a `GitHubAccess`, its credentials and **the one `GitHubClient`** over them (src/interfaces/github-credentials.ts). `Plugins.githubAccess()` in src/compose.ts builds it once, so a `build()` or a CLI command holds one client: the source, auth, grant and forge get its `GitHubApi`, only the broker gets the credentials, and `doctor`, `setup`, `issue`, `migrate`, `golden add` and `settings --project` call `Plugins.githubApi()`. With no GitHub plugin selected the plugin is not built and every call is refused. The `token` and `app` descriptors name their secret themselves (`secretName()`), so discovering them loads no implementation; each sits under its own tier-4 floor.

Plugins:

- `token`: `TokenCredentials` and a `GitHubClient` over it. A personal access token from the secret file, used as is. GitHub shows every write as the token's owner.
  - Enable: `"plugins": { "github_auth": "token", ... }`, or no `github_auth` key.
  - Secrets: `GITHUB_TOKEN` (fine-grained, this repository only; `docs/setup.md`).
- `app`: `AppCredentials` and a `GitHubClient` over it. Acts as the GitHub App's bot. It signs a JWT (RS256, 9 minutes) with the App's key, looks up the App's installation on `repo`, and exchanges the JWT for an installation token limited to that one repository. The token is cached until 5 minutes before it expires (GitHub gives one hour); concurrent callers share one mint.
  - Enable: `"plugins": { "github_auth": "app", ... }`. The App must be installed on the repository with Contents, Issues and Pull requests read and write.
  - Secrets: `GITHUB_APP_ID`. Settings: the App's private key in `github-app.pem`, next to the secret file (`~/.config/software-factory/`), read only when a token is minted (never when the plugin is built). A missing ID or unreadable key is a FAIL in `npm run factory -- doctor`.

Turn on / off: set `plugins.github_auth` to `app` (bot) or `token` (your account); delete the key to go back to `token`.

Shared REST client settings (both plugins; `GitHubClient`, design §5 Sources, GitHub call budget):

- `"github": { "min_remaining": 200 }`: below this many core API calls left in the hour, optional reads (per-PR mergeable, review and base-commit reads in the poll, PR checks) wait until the reset; the intake lists always run. Absent: 200. A whole number, 0 or more; `0` turns the skipping off (calls are still refused locally once none are left). One log line (`component: "github"`) on entering and one on leaving.
- `"github": { "budget_share": 1.0 }`: the part of the installation's hourly core limit this factory process may use, checked alongside `min_remaining`. Once the process has made `budget_share` × the limit counted calls (every answer but a 304) in the current window, optional reads wait for the reset as under `min_remaining`; the count starts again at zero when the window resets. A first start's catch-up reads (each closed factory issue's full read, base-commit pages with no cursor) take at most (`budget_share` × limit) / 60 a minute, so the backlog is spread over several polls. Absent: 1.0, the whole limit. A number greater than 0 and at most 1; anything else fails at startup naming the key. The count is per process (in memory): replicas of one factory on one App split its share between them. Solo: one App, 1.0. Enterprise: one App per factory, each 1.0 (recommended), or shares summing to at most 1.0 by agreement (not enforced across factories; `docs/setup.md`).
- `"github": { "history_since": "2026-01-01" }`: read by the `github-issues` source, not the client: check merges back to this date, once, at most 5 pages of closed PRs (docs/plugins/source-adapter.md, `github-issues`). Absent: merges before the first start are not checked. A date or UTC time; anything else fails at startup naming the setting.
- Conditional GETs (ETag / `If-None-Match`, a 304 does not count against the limit) are always on, with a per-process cache of 500 URLs; there is no setting.

## History

- **The plugin builds the client** (changed 2026-11-08). Before: the plugins returned only credentials, and build(), setup, doctor and each CLI command made their own `GitHubClient` from them (setup and doctor without the `github` settings).
- **`budget_share`** (added 2026-11-07, issue #340). Before: the only limit was `min_remaining`, so one factory could use most of an installation's hourly budget that other factories on the same App also draw from.
- **`history_since`** (added 2026-11-07, issue #341). Before: the `github` block had only `min_remaining`, and a first start checked the merges on the first page of closed PRs.
- **Call budget** (changed 2026-11-07). Before: the client had no settings, sent no conditional requests and ignored the rate-limit headers.
