# AuthProvider

What it does: resolves an external identity to a factory user and decides whether it may act (submit work, approve, reject, retry). Deny by default. Since 2026-11-01 (design §8) it decides through the one shared check in `src/core/authorize.ts`, which asks the grant plugins (GrantSource, [grant-source.md](grant-source.md)); no auth plugin asks GitHub for a permission itself.

Selection is per command origin (issue #318): `auth` as a string selects the plugin for GitHub comments, and local commands (the CLI and the local UI) use `local`; `"auth": { "github_issue": "github", "local": "local" }` names both. Local commands never depend on the GitHub plugin.

Plugins:

- `github`: `GitHubAuthProvider`. An account linked with `/link` resolves to its factory user (looked up by provider and subject only); any other GitHub account is `github:<numeric id>`; an unlinked account of another provider (Slack) resolves to no user and is refused with "not linked". Permission comes from `permissions.grants`; with the default `github-permission` grant, approvals need write permission on the repository, as before.
  - Enable: `"auth": "github"` (top level). Secrets: none of its own; links live in the store, and the grants it asks are configured under `permissions`.
- `local`: `LocalAuthProvider` (issue #318). The default for local commands. A local identity `local:<x>` (or a `cli_user` such as `github:1`) is its own factory user; other providers resolve to no user. Roles come from the store's local users (owner, approver, requester; the first identity to write becomes the owner, `anonymous` never does, `factory users add` grants the rest) and from the configured grants that make no remote call (`static`, whose denies still refuse). It never calls GitHub, so local approvals work while GitHub is down or rate limited. It judges local commands on an item of any source: an owner or approver may approve, retry, revise or reject a GitHub item from the CLI without GitHub write access, and the factory mirrors each such command to the issue as a comment, best effort (a failed post is retried on a later tick and never holds the transition).
  - Enable: nothing for local commands (the default), or `"auth": { "github_issue": "github", "local": "local" }`. Selecting it for `github_issue` too gives a GitHub account no role unless `permissions.static` grants one. Secrets: none. Its table needs `npm run migrate` on MySQL (step 0026).
- `none`: `NoAuthProvider`. Allows everything and ignores links and grants; local development only.
  - Enable: `"auth": "none"`. Secrets: none.

Switch back / disable: set `auth` to `github` (local commands keep `local`; set `"auth": { "github_issue": "github", "local": "github" }` to judge them by GitHub links again). `none` is the "no checks" choice; there is no way to run without an `AuthProvider`.

## History

- **Auth per command origin, `local` plugin** (new decision, 2026-11-07, issue #318). Before: one `auth` plugin judged every command, so local CLI commands under `auth: github` needed a link that no command created.
