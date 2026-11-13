# AuthProvider

What it does: resolves an external identity to a factory user and decides whether it may act (submit work, approve, reject, retry, record a verdict, approve a pack tool). Deny by default.

**One owner check, no plugins (decision changed 2026-11-13, issue #669, phase B of #575; current).** The decision that changed: **AuthProvider is no longer a plugin kind**: the `github`, `local` and `none` plugins, the per-origin `auth` selection and the GrantSource interface with its `github-permission` and `static` grants are deleted. Every person's command, whatever its origin (a GitHub comment, a Slack thread or tap, the CLI, the dashboard), takes the one owner check, `OwnerAuth` in `src/core/authorize.ts` ([08-permissions.md](../design/08-permissions.md), One owner):

- `resolve` maps the identity to a factory user: its linked user first (by provider and subject only, never a display name), else a local identity's own ID (`local:<x>`, or a `cli_user` such as `github:1`), else `<provider>:<subject>`.
- `authorize` (principal, action, resource; no passport argument since #577) allows the store's owner (`identity_owner`, one row since #577) and refuses anyone else as `not_owner`, with the one reply "only the owner may send this command". The first local identity to send a command becomes the owner; `local:anonymous` never does. `submit_work` stays open to any caller but an unlinked chat account (the intake label is its gate).
- It makes no remote call, so commands work while GitHub is down or rate limited. It writes one `authz_audit` row per decision itself, passport `none`, for every caller (since #577; [08-permissions.md](../design/08-permissions.md)). `AuditedAuthProvider`, which compose still wraps it in, only delegates and is deprecated.
- Service principals (the controller's auto-mode spec approvals and merges, the worker's and outbound's tool calls) never reach it: they keep their passport checks in Identity.

Enable: nothing; it is always on. Secrets: none. Config: none; the top-level `auth` and `permissions` keys are no longer read (a config that still has them loads with one warning).

Switch back / disable: there is no other AuthProvider and no way to run without the owner check.

## History

- **The owner check audits itself and reads one owner row** (decision changed 2026-11-13, issue #577). Before: `OwnerAuth` read the owner from `identity_local_users` (role `owner`) and wrote no audit row; `AuditedAuthProvider` wrote it, so only the callers compose wrapped were audited, and `authorize` took an optional command passport that the wrapper checked first.
- **Owner check replaces the auth plugins and the grants** (decision changed 2026-11-13, issue #669, phase B of #575). Before: the `github` (`GitHubAuthProvider`), `local` (`LocalAuthProvider`) and `none` (`NoAuthProvider`) plugins, selected per command origin by `auth` (`github_issue`, `local`, `slack_thread`), judged commands through the grant plugins of the GrantSource interface (`github-permission`: write access on the repository; `static`: roles and denies from `permissions.static`), selected by `permissions.grants`. Phase A (#668) had already made the owner check decide every command and left them unused.

- **`github`, `local` and `none` deprecated** (decision changed 2026-11-11, owner decision). Before: the three plugins, selected per command origin, judged several people by their links, stored local roles and grants.
- **Slack accounts are judged by `local`** (decision changed 2026-11-09, issue #498). Before: the plugin selected for GitHub comments (`github`) judged Slack accounts through their links, so their rights came from GitHub grants, not from the stored local roles.

- **Auth per command origin, `local` plugin** (new decision, 2026-11-07, issue #318). Before: one `auth` plugin judged every command, so local CLI commands under `auth: github` needed a link that no command created.
- **Slack thread commands get their own origin** (decision changed 2026-11-09, issue #486). Before: `auth` knew only `github_issue` and `local`, and every non-local identity, Slack included, was judged by the `github_issue` plugin with no way to change it. With #498 merged first, the default for Slack is the `local` origin's plugin, and `slack_thread` overrides it.
