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

## History

No earlier decision is recorded for this topic.
