# GitHubCredentials

What it does: supplies the token for every GitHub call: the shared REST client (issues, comments, labels, PRs) and the broker's `git push`. Only those two tool implementations call it; the token never reaches an agent, a prompt, a log or the store (guards G1–G2).

Plugins:

- `token`: `TokenCredentials`. A personal access token from the secret file, used as is. GitHub shows every write as the token's owner.
  - Enable: `"plugins": { "github_auth": "token", ... }`, or no `github_auth` key.
  - Secrets: `GITHUB_TOKEN` (fine-grained, this repository only; `docs/setup.md`).
- `app`: `AppCredentials`. Acts as the GitHub App's bot. It signs a JWT (RS256, 9 minutes) with the App's key, looks up the App's installation on `repo`, and exchanges the JWT for an installation token limited to that one repository. The token is cached until 5 minutes before it expires (GitHub gives one hour); concurrent callers share one mint.
  - Enable: `"plugins": { "github_auth": "app", ... }`. The App must be installed on the repository with Contents, Issues and Pull requests read and write.
  - Secrets: `GITHUB_APP_ID`. Settings: the App's private key in `github-app.pem`, next to the secret file (`~/.config/software-factory/`), read only when a token is minted. A missing ID or unreadable key is a FAIL in `npm run factory -- doctor`.

Turn on / off: set `plugins.github_auth` to `app` (bot) or `token` (your account); delete the key to go back to `token`.

Shared REST client settings (both plugins; `GitHubClient`, design §5 Sources, GitHub call budget):

- `"github": { "min_remaining": 200 }`: below this many core API calls left in the hour, optional reads (per-PR mergeable, review and base-commit reads in the poll, PR checks) wait until the reset; the intake lists always run. Absent: 200. A whole number, 0 or more; `0` turns the skipping off (calls are still refused locally once none are left). One log line (`component: "github"`) on entering and one on leaving.
- `"github": { "history_since": "2026-01-01" }`: read by the `github-issues` source, not the client: check merges back to this date, once, at most 5 pages of closed PRs (docs/plugins/source-adapter.md, `github-issues`). Absent: merges before the first start are not checked. A date or UTC time; anything else fails at startup naming the setting.
- Conditional GETs (ETag / `If-None-Match`, a 304 does not count against the limit) are always on, with a per-process cache of 500 URLs; there is no setting.

## History

- **`history_since`** (added 2026-11-07, issue #341). Before: the `github` block had only `min_remaining`, and a first start checked the merges on the first page of closed PRs.
- **Call budget** (changed 2026-11-07). Before: the client had no settings, sent no conditional requests and ignored the rate-limit headers.
