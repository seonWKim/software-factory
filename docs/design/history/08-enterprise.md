## History

- **Current text names SQLite only** (decision changed 2026-11-11, issue #567). The "Goes" list changed: it named the `mysql` store and the `mysql-local` test database; it now says the shared team store and its test database.
- **Roles and local users removed; earlier auth text dropped** (decision changed 2026-11-13, #577, phase 2 of #568). The "Goes" list changed, and the "Earlier text, still describing the code until the removals land" section was cut to what the code does. Before, these sentences stood:
  - > Still to go, in a later change: the roles and local users in 08-permissions.md.
  - > Since 2026-11-01 `authorize` is the shared grant check in 08-permissions.md. Factory acts on behalf of `requester_id`; effective permission = requester ∩ agent. Classes: local dev (no-auth), internal low risk, team-owned, restricted data, critical (two-person rule).
  - > User attributes: `user_id : key : value` (e.g. `u_123 : role : payments`). Domain-class policies require attributes; `AuthProvider.authorize` checks them.
  - > Auth best practices applied: … attributes come from the identity provider (agents can't edit them); … periodic access review; … Resource classes follow the common public / internal / confidential / restricted scale, mapped onto the five classes above.
- **Auth plugins and grants removed** (decision changed 2026-11-13, #669, phase B of #575). The "Goes" list changed. Before, these sentences stood:
  - > Deprecated, each with its removal plan in its topic file: the auth plugins `github`, `local` and `none` (auth-provider.md), and the whole GrantSource interface (its topic file, now deleted). The roles and local users in 08-permissions.md go with them. The auth and grant code stays until the follow-up issues remove it (numbers added when filed).
- **One owner, many workers** (decision changed 2026-11-11, owner decision). Before: every design served a solo developer and an enterprise team (many developers and several replicas on a shared store: per-person identity and permissions, audit, shared budgets), and AuthN/Z was planned around per-person classes, attributes and grants.
- **Tool and MCP intake** (decision changed 2026-11-11, issue #588). Before: "Tools/MCP: users can add them; automated credential-leak check + human approval; rules scoped to the tool", with no command or table behind it.
- **MySQL store and mysql-local removed** (decision changed 2026-11-12, #576 phase 3). The "Goes" list changed. Before, these sentences stood:
  - > Deprecated, each with its removal plan in its topic file: the `mysql` store ([factory-store.md](../plugins/factory-store.md)), the `mysql-local` test database ([test-database.md](../plugins/test-database.md)), the auth plugins
  - > The code stays until the follow-up issues remove it (numbers added when filed).
