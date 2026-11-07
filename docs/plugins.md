# Plugins: index

Every infrastructure interface has one or more **named plugins** (design D6). `factory.config.json` picks
one name per interface; guards (`SecretStore`, `EgressScanner`, `ToolBroker`) can be switched, never
disabled.

How to use it: read this index first, then open only the topic file of the interface your change touches.
Each topic file says what the interface does, every plugin (how to enable it, its secrets, its settings) and
how to switch back; older decisions are under "History" at the bottom. A change edits the topic file, never
this index, unless it adds an interface or a plugin name. A topic file is named after its interface in
kebab-case (KeepAwake is `keep-awake.md`).

| Interface | Plugins | Topic |
|---|---|---|
| How selection works | config keys, defaults, rules, the discovered registry, declared secrets | [selection.md](plugins/selection.md) |
| FactoryStore | `mysql`, `sqlite` | [factory-store.md](plugins/factory-store.md) |
| AuthProvider | `github`, `none` | [auth-provider.md](plugins/auth-provider.md) |
| GrantSource | `github-permission`, `static` | [grant-source.md](plugins/grant-source.md) |
| SecretStore (guard) | `env-file` | [secret-store.md](plugins/secret-store.md) |
| EgressScanner (guard) | `pattern` | [egress-scanner.md](plugins/egress-scanner.md) |
| ToolBroker (guard) | `github` | [tool-broker.md](plugins/tool-broker.md) |
| Sandbox | `noop` | [sandbox.md](plugins/sandbox.md) |
| AgentRunner | `claude-code` | [agent-runner.md](plugins/agent-runner.md) |
| LLMProvider | `claude-cli`, `openai-compatible` | [llm-provider.md](plugins/llm-provider.md) |
| SourceAdapter | `github-issues` | [source-adapter.md](plugins/source-adapter.md) |
| SharedStorage | `fs` | [shared-storage.md](plugins/shared-storage.md) |
| CapabilitySearch | `list-all`, `bm25` | [capability-search.md](plugins/capability-search.md) |
| Clock | `system` | [clock.md](plugins/clock.md) |
| Updater | `git-worktree`, `none` | [updater.md](plugins/updater.md) |
| KeepAwake | `caffeinate`, `none` | [keep-awake.md](plugins/keep-awake.md) |
| GitHubCredentials | `token`, `app` | [github-credentials.md](plugins/github-credentials.md) |
| TestDatabase | `mysql-local`, `none` | [test-database.md](plugins/test-database.md) |

## Granted broker tools

Each `ToolBroker` tool descriptor sets `read_only`: true only for a tool that changes nothing (the `github`
broker marks `github.preflight` read-only and `github.push_branch`, `github.open_pr`, `github.comment` not).
A broker lists every tool it serves through `allTools()`; one without it can be granted nothing.

`tool_grants` in `factory.config.json` grants read-only broker tools to agent runs, per run kind (`triage`,
`implement`, `review`, `update`, `resolve`, `manual`): `{"tool_grants": {"triage": ["github.preflight"]}}`.
Absent: no grants. Startup checks it when the broker is built and fails on an unknown run kind, an unknown
tool or one that is not read-only, listing the valid names. Only a runner with `exposes_tools` (the
`claude-code` runner) can take grants. How the guards hold: `docs/architecture.md` §5.
