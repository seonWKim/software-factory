# GrantSource

What it does: gives a factory user roles on a project, and may deny one. Kind `grant`, one `*.grant.ts` descriptor beside each implementation under `src/impl/grant/` (`defineGrant` from `src/plugin-api.ts`). Unlike the other interfaces, several are selected at once, by the list `permissions.grants` at the top level of `factory.config.json`, so grants sit outside the one-per-interface registry. The shared authorize check (`src/core/authorize.ts`) takes the union of their roles, minus any deny: a deny from any grant refuses, whatever the others give. Roles map onto the existing actions: `requester` gives `submit_work`; `approver` gives `submit_work`, `approve_spec`, `approve_merge`, `record_verdict` and `use_tool`. `submit_work` stays open to any resolved user unless denied, since the intake label is its gate. Local grants are asked before remote ones, and the search stops at the first role that covers the action, so a user a local grant covers costs no GitHub call. Not a guard.

Plugins:

- `github-permission`: `GitHubPermissionGrant`, in `src/impl/github/github-permission.grant.ts`. Write, maintain or admin on the configured repository gives `approver`; triage or read gives `requester`; no access gives nothing. Asked for every GitHub account of the user (its `github:<id>` and any linked GitHub account). Denies nothing. The default.
  - Enable: `"permissions": { "grants": ["github-permission"] }`, or leave `permissions` out. Secrets: none of its own; it calls GitHub through the shared client, whose credential comes from `GitHubCredentials`.
- `static`: `StaticGrant`. Roles and denies written in config, by factory user ID and project key (`*` for every project). No remote call.
  - Enable: `"permissions": { "grants": ["github-permission", "static"], "static": { "roles": { "github:12345": { "*": ["approver"] } }, "deny": { "github:666": ["*"] } } }`. Secrets: none. A role other than `requester` or `approver`, a key that is not a user ID (`<provider>:<id>`), or an unknown key fails at startup.

Switch back: remove `permissions` (or set `"grants": ["github-permission"]`); permissions are then GitHub write access again. An empty list fails at startup: there is no way to select no grant.

## History

No earlier decision is recorded for this topic.
