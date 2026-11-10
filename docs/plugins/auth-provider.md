# AuthProvider

What it does: resolves an external identity to a factory user and decides whether it may act (submit work, approve, reject, retry). Deny by default. Since 2026-11-01 (design §8) it decides through the one shared check in `src/core/authorize.ts`, which asks the grant plugins (GrantSource, [grant-source.md](grant-source.md)); no auth plugin asks GitHub for a permission itself.

Selection is per command origin (issue #318): `auth` as a string selects the plugin for GitHub comments, and local commands (the CLI and the local UI) and Slack accounts (issue #498: a linked account acts as its factory user, whose stored role decides) use `local`; `"auth": { "github_issue": "github", "local": "local" }` names both. Local commands never depend on the GitHub plugin.

Slack thread commands (identity provider `slack`) have their own origin, `slack_thread` (issue #486; current decision):

- Solo default: no `slack_thread` key. Slack commands are judged by the `local` origin's plugin, the same instance (issue #498: a linked account acts as its factory user); no second plugin is built.
- Enterprise: `"auth": { "github_issue": "github", "slack_thread": "<plugin>" }` names the plugin for Slack users, for example `github` to judge linked Slack accounts by the GitHub grants. Pick one that resolves them: an unlinked Slack account resolves to no factory user under `github` or `local` and is refused, and `none` allows everything. No Slack-specific auth plugin exists yet.
- An unknown origin fails at load and lists the known ones (`github_issue`, `local`, `slack_thread`).

Plugins:

- `github`: `GitHubAuthProvider`. An account linked with `/link` resolves to its factory user (looked up by provider and subject only); any other GitHub account is `github:<numeric id>`; an unlinked account of another provider (Slack) resolves to no user and is refused with "not linked". Permission comes from `permissions.grants`; with the default `github-permission` grant, approvals need write permission on the repository, as before.
  - Enable: `"auth": "github"` (top level). Secrets: none of its own; links live in the store, and the grants it asks are configured under `permissions`.
- `local`: `LocalAuthProvider` (issue #318). The default for local commands. A local identity `local:<x>` (or a `cli_user` such as `github:1`) is its own factory user; a Slack account resolves to the factory user it is linked to (design 08-permissions, "Chat accounts act as their linked factory user"); any other unlinked account resolves to no user. Roles come from the store's local users (owner, approver, requester; the first identity to write becomes the owner, `anonymous` never does, `factory users add` grants the rest) and from the configured grants that make no remote call (`static`, whose denies still refuse). It never calls GitHub, so local approvals work while GitHub is down or rate limited. It judges local commands on an item of any source: an owner or approver may approve, retry, revise or reject a GitHub item from the CLI without GitHub write access, and the factory mirrors each such command to the issue as a comment, best effort (a failed post is retried on a later tick and never holds the transition).
  - Enable: nothing for local commands (the default), or `"auth": { "github_issue": "github", "local": "local" }`. Selecting it for `github_issue` too gives a GitHub account no role unless `permissions.static` grants one. Secrets: none. Its table needs `npm run migrate` on MySQL (step 0026).
- `none`: `NoAuthProvider`. Allows everything and ignores links and grants; local development only.
  - Enable: `"auth": "none"`. Secrets: none.

Switch back / disable: set `auth` to `github` (local commands keep `local`; set `"auth": { "github_issue": "github", "local": "github" }` to judge them by GitHub links again). Remove the `slack_thread` key to judge Slack commands by the `local` origin's plugin again. `none` is the "no checks" choice; there is no way to run without an `AuthProvider`.

## History

- **Slack accounts are judged by `local`** (decision changed 2026-11-09, issue #498). Before: the plugin selected for GitHub comments (`github`) judged Slack accounts through their links, so their rights came from GitHub grants, not from the stored local roles.

- **Auth per command origin, `local` plugin** (new decision, 2026-11-07, issue #318). Before: one `auth` plugin judged every command, so local CLI commands under `auth: github` needed a link that no command created.
- **Slack thread commands get their own origin** (decision changed 2026-11-09, issue #486). Before: `auth` knew only `github_issue` and `local`, and every non-local identity, Slack included, was judged by the `github_issue` plugin with no way to change it. With #498 merged first, the default for Slack is the `local` origin's plugin, and `slack_thread` overrides it.
