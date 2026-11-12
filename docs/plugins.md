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
| FactoryStore | `sqlite` | [factory-store.md](plugins/factory-store.md) |
| AuthProvider | none: one built-in owner check | [auth-provider.md](plugins/auth-provider.md) |
| SecretStore (guard) | `env-file` | [secret-store.md](plugins/secret-store.md) |
| EgressScanner (guard) | `pattern` | [egress-scanner.md](plugins/egress-scanner.md) |
| ToolBroker (guard) | `github`, `local` | [tool-broker.md](plugins/tool-broker.md) |
| Sandbox | `noop` | [sandbox.md](plugins/sandbox.md) |
| AgentRunner | `claude-code`, `openai-compatible` | [agent-runner.md](plugins/agent-runner.md) |
| LLMProvider | `claude-cli`, `openai-compatible` | [llm-provider.md](plugins/llm-provider.md) |
| SourceAdapter | `github-issues`, `local`, `slack` | [source-adapter.md](plugins/source-adapter.md) |
| SharedStorage | `fs` | [shared-storage.md](plugins/shared-storage.md) |
| CapabilitySearch | `list-all`, `bm25` | [capability-search.md](plugins/capability-search.md) |
| Clock | `system` | [clock.md](plugins/clock.md) |
| Updater | `git-worktree`, `none` | [updater.md](plugins/updater.md) |
| KeepAwake | `caffeinate`, `none` | [keep-awake.md](plugins/keep-awake.md) |
| GitHubCredentials | `token`, `app` | [github-credentials.md](plugins/github-credentials.md) |
| TestDatabase | `none` | [test-database.md](plugins/test-database.md) |
| NetworkProbe | `http` | [network-probe.md](plugins/network-probe.md) |
| EventBus | `sql` | [event-bus.md](plugins/event-bus.md) |
| TickGenerator | `time-based`, `manual` | [tick-generator.md](plugins/tick-generator.md) |
| ExecutionEngine | `journal` | [execution-engine.md](plugins/execution-engine.md) |
| TacitLedger | `agents-home`, `none` | [tacit-ledger.md](plugins/tacit-ledger.md) |
| AppShell (wired by the desktop entry, not chosen in config) | `macos` | [app-shell.md](plugins/app-shell.md) |
| CalendarSource (optional; top-level `calendar` list, default `[]`) | `google-calendar` | [calendar-source.md](plugins/calendar-source.md) |
| Forge (optional; follows `plugins.source`: `github` with `github-issues`, else none) | `github`, `local` | [forge.md](plugins/forge.md) |
