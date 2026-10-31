# Plugins

Every infrastructure interface has one or more **named plugins** (design D6). `factory.config.json` picks one
name per interface; `src/plugins.ts` maps each name to the code that builds it, and it is the only non-test
file that constructs these implementations. `src/compose.ts` (`build()`), the setup/doctor commands and the
G6 canary all resolve plugins through that registry, so whatever config selects is what runs and what
the canary tests.

## How selection works

| Interface | Config key | Default (today) | Guard |
|---|---|---|---|
| FactoryStore | `store.type` | `sqlite` if there is no `store` block; the checked-in config uses `mysql` | no |
| AuthProvider | `auth` (top level) | the checked-in config uses `github` | no |
| SecretStore | `plugins.secrets` | `env-file` | **yes** |
| EgressScanner | `plugins.egress` | `pattern` | **yes** |
| ToolBroker | `plugins.broker` | `github` | **yes** |
| Sandbox | `plugins.sandbox` | `noop` | no |
| AgentRunner | `plugins.runner` | `claude-code` | no |
| LLMProvider | `plugins.llm` | `claude-cli` | no |
| SourceAdapter | `plugins.source` | `github-issues` | no |
| SharedStorage | `plugins.storage` | `fs` | no |
| CapabilitySearch | `plugins.capability` | `list-all` | no |
| Clock | `plugins.clock` | `system` | no |

```jsonc
// factory.config.json (the checked-in defaults)
"store": { "type": "mysql", "host": "localhost", "port": 3306, "database": "software_factory", "user": "factory" },
"auth": "github",
"plugins": {
  "secrets": "env-file", "egress": "pattern", "broker": "github",
  "sandbox": "noop", "runner": "claude-code", "llm": "claude-cli",
  "source": "github-issues", "storage": "fs", "capability": "list-all", "clock": "system"
}
```

Rules, checked by `loadConfig` at startup (and again by `build()`):

- **No `plugins` object** means today's defaults for all ten interfaces in it. Store and auth keep their own keys.
- **A `plugins` object** must name every guard (`secrets`, `egress`, `broker`) explicitly. A non-guard key you leave out falls back to its default.
- **An unknown name** for any interface fails startup. The error names the interface, the bad value and every available name.
- **An unknown key** under `plugins` fails startup (so a typo cannot silently fall back to a default). `store` and `auth` under `plugins` are rejected with a pointer to their own keys.
- **Guards cannot be disabled.** For `secrets`, `egress` and `broker`, leaving the key out of a `plugins` object, or setting it to `null`, `false`, `""`, `"none"` or anything that is not a registered name, fails startup with an error that the plugin is a guard and points to `docs/architecture.md` §5. You can switch a guard to another registered plugin; you cannot turn it off.

To switch back to the defaults, set the key back to the default name above, or delete the whole `plugins` object. There is no loading from external packages: a plugin is code in this repository, registered in `src/plugins.ts`.

**Adding an implementation:** in the same change, add its registry entry in `src/plugins.ts`, its section below, and an entry in the class table in `tests/plugins.test.ts`. The tests fail if a registered name is missing from this file.

## FactoryStore

What it does: the factory's state (work items, runs, state changes, handoffs, leases). Every transition is a conditional update, so any number of controllers and workers can share it (architecture §4). The logic exists once in `SqlFactoryStore`; a backend is a `SqlDriver`.

Plugins:

- `mysql`: `SqlFactoryStore` over `MysqlDriver`. Any number of processes on any hosts. Selected by the checked-in config.
  - Enable: `"store": { "type": "mysql", "host": "localhost", "port": 3306, "database": "software_factory", "user": "factory" }`.
  - Secrets: `MYSQL_PASSWORD` in the secret file (`npm run setup` creates the database, the user and the password). Settings: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER` in the secret file override the `store` block per machine (`docs/setup.md`).
- `sqlite`: `SqlFactoryStore` over `SqliteDriver`, file at `<state_dir>/db/factory.db`. One machine. Used when there is no `store` block.
  - Enable: `"store": { "type": "sqlite" }`. Secrets: none.

Switch back / disable: set `store.type` to the other name. A store cannot be disabled: the factory has no state without one.

## AuthProvider

What it does: resolves an external identity to a principal and decides whether it may act (submit work, approve, reject, retry). Deny by default.

Plugins:

- `github`: `GitHubAuthProvider`. Approvals need write permission on the repository.
  - Enable: `"auth": "github"` (top level). Secrets: `GITHUB_TOKEN` (shared with the GitHub client).
- `none`: `NoAuthProvider`. Allows everything; local development only.
  - Enable: `"auth": "none"`. Secrets: none.

Switch back / disable: set `auth` to `github`. `none` is the "no checks" choice; there is no way to run without an `AuthProvider`.

## SecretStore

What it does: guard **G1**. Loads secrets in the worker/controller process only and hands out opaque values; it also gives the egress scanner the values to look for. Agents never get it.

Plugins:

- `env-file`: `EnvFileSecretStore`. Reads `${XDG_CONFIG_HOME:-~/.config}/software-factory/.env` (or `SOFTWARE_FACTORY_SECRETS_FILE`), lazily, once.
  - Enable: `"plugins": { "secrets": "env-file", ... }`, or no `plugins` object.
  - Secrets: the file itself (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `MYSQL_PASSWORD`); see `docs/setup.md`. Settings: none.

Switch back: `"secrets": "env-file"`.

Why it cannot be disabled: without a `SecretStore` nothing keeps credentials out of the agent's environment (G1), and the egress scanner has no secret values to look for (G5). Architecture §5 layers G1–G6 so that one failure is not a leak; removing a layer breaks that. Config that selects no `SecretStore` fails at startup.

## EgressScanner

What it does: guard **G5**. Scans every agent output (commits, PR text, comments, handoff rows, run outcomes, logs, tool results) for known secret values and secret patterns before it leaves. A hit fails the run.

Plugins:

- `pattern`: `PatternEgressScanner`. Known values from the `SecretStore` (plus the G6 canary during a canary run) and secret patterns (GitHub tokens, Anthropic keys, AWS keys, private keys, the canary).
  - Enable: `"plugins": { "egress": "pattern", ... }`, or no `plugins` object. Secrets: none of its own; it reads values through the selected `SecretStore`.

Switch back: `"egress": "pattern"`.

Why it cannot be disabled: G5 is the last guard before a leak reaches GitHub or the store, and the G6 canary checks it. Architecture §5 requires every guard to stay on. Config that selects no `EgressScanner` fails at startup.

## ToolBroker

What it does: guard **G2**. Credentialed actions (push a branch, open a PR, comment) run in the worker process, outside the sandbox; the broker attaches the credential, checks the caller still holds its lease (fencing), pushes only to factory branches and egress-scans what it sends.

Plugins:

- `github`: `GitHubToolBroker`.
  - Enable: `"plugins": { "broker": "github", ... }`, or no `plugins` object.
  - Secrets: `GITHUB_TOKEN` (fine-grained, this repository only; `docs/setup.md`). Settings: `branch_prefix`, `repo`.

Switch back: `"broker": "github"`.

Why it cannot be disabled: without the broker the only way to push or comment would be to hand the agent a token, which G2 forbids (architecture §5). Config that selects no `ToolBroker` fails at startup.

## Sandbox

What it does: where an agent run happens: create a workspace for a branch, run commands in it, destroy it.

Plugins:

- `noop`: `NoOpSandbox`. A git worktree under `worktrees_dir` on the host, no isolation (design §5: keep it on test environments only).
  - Enable: `"plugins": { "sandbox": "noop", ... }`. Secrets: none. Settings: `worktrees_dir`.

Switch back / disable: `"sandbox": "noop"`. There is no "off": runs need a workspace.

## AgentRunner

What it does: runs one tool-using agent loop in a sandbox and returns its structured output and transcript.

Plugins:

- `claude-code`: `ClaudeCodeRunner` (`claude -p`), with a per-run HOME and a factory-owned `CLAUDE_CONFIG_DIR` under `<state_dir>/agents`, and the harness deny rules of architecture §5.
  - Enable: `"plugins": { "runner": "claude-code", ... }`.
  - Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) from the `SecretStore`, passed to the harness only. Settings: `models`, `run_timeout_ms`; the `claude` CLI on `PATH`.

Switch back / disable: `"runner": "claude-code"`. There is no "off".

## LLMProvider

What it does: single model calls without tools (for example classification). Refuses `prod` data.

Plugins:

- `claude-cli`: `ClaudeCliLLMProvider`, one turn through the Claude Code CLI on the subscription login (D2).
  - Enable: `"plugins": { "llm": "claude-cli", ... }`.
  - Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`). Settings: `models`; the `claude` CLI on `PATH`.

**Not wired in yet:** the name is checked at startup and resolves, but nothing in `build()` consumes an `LLMProvider` today, so no instance is created.

Switch back / disable: `"llm": "claude-cli"`.

## SourceAdapter

What it does: intake. Polls a source for new work items and commands, and posts comments back.

Plugins:

- `github-issues`: `GitHubIssueSource`. Issues with the intake label on the configured repository, their comments and pull requests.
  - Enable: `"plugins": { "source": "github-issues", ... }`.
  - Secrets: `GITHUB_TOKEN`. Settings: `repo`, `intake_label`, `branch_prefix`, `poll_interval_ms`.

Switch back / disable: `"source": "github-issues"`. There is no "off".

## SharedStorage

What it does: blobs shared between processes (transcripts, logs, the read-only shared pool), under keys.

Plugins:

- `fs`: `FsSharedStorage`, files under `<state_dir>/storage` (a deny path for agents).
  - Enable: `"plugins": { "storage": "fs", ... }`. Secrets: none. Settings: `state_dir`.

Switch back / disable: `"storage": "fs"`.

## CapabilitySearch

What it does: finds skills, tools and MCP servers for a task (design §7). Finding a capability is not permission to use it.

Plugins:

- `list-all`: `ListAllCapabilitySearch`. Returns every known capability.
  - Enable: `"plugins": { "capability": "list-all", ... }`. Secrets: none.

**Not wired in yet:** the name is checked at startup and resolves, but nothing in `build()` consumes a `CapabilitySearch` today, so no instance is created.

Switch back / disable: `"capability": "list-all"`.

## Clock

What it does: the time source. Injected so tests control time.

Plugins:

- `system`: `SystemClock`, the host's clock.
  - Enable: `"plugins": { "clock": "system", ... }`. Secrets: none.

`FakeClock` is test-only and not registered; tests pass it to `build()` directly. Switch back / disable: `"clock": "system"`.
