# AuthProvider

What it does: resolves an external identity to a factory user and decides whether it may act (submit work, approve, reject, retry). Deny by default. Since 2026-11-01 (design §8) it decides through the one shared check in `src/core/authorize.ts`, which asks the grant plugins (GrantSource, [grant-source.md](grant-source.md)); no auth plugin asks GitHub for a permission itself.

Plugins:

- `github`: `GitHubAuthProvider`. An account linked with `/link` resolves to its factory user (looked up by provider and subject only); any other GitHub account is `github:<numeric id>`; an unlinked account of another provider (Slack) resolves to no user and is refused with "not linked". Permission comes from `permissions.grants`; with the default `github-permission` grant, approvals need write permission on the repository, as before.
  - Enable: `"auth": "github"` (top level). Secrets: none of its own; links live in the store, and the grants it asks are configured under `permissions`.
- `none`: `NoAuthProvider`. Allows everything and ignores links and grants; local development only.
  - Enable: `"auth": "none"`. Secrets: none.

Switch back / disable: set `auth` to `github`. `none` is the "no checks" choice; there is no way to run without an `AuthProvider`.

## History

No earlier decision is recorded for this topic.
