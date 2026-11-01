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
| Updater | `plugins.updater` | `git-worktree` | no |
| KeepAwake | `plugins.awake` | `caffeinate` on macOS, `none` elsewhere (not in the checked-in config, so the platform decides) | no |

```jsonc
// factory.config.json (the checked-in defaults)
"store": { "type": "mysql", "host": "localhost", "port": 3306, "database": "software_factory", "user": "factory" },
"auth": "github",
"plugins": {
  "secrets": "env-file", "egress": "pattern", "broker": "github",
  "sandbox": "noop", "runner": "claude-code", "llm": "claude-cli",
  "source": "github-issues", "storage": "fs", "capability": "list-all", "clock": "system",
  "updater": "git-worktree"
  // "awake" is left out on purpose: it defaults per platform (see KeepAwake below)
}
```

Rules, checked by `loadConfig` at startup (and again by `build()`):

- **No `plugins` object** means today's defaults for all twelve interfaces in it (`awake`'s default depends on the platform). Store and auth keep their own keys.
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

- `github-issues`: `GitHubIssueSource`. Issues with the intake label on the configured repository, their comments and pull requests, and commits on the base branch (`repo.base_branch`; one extra API call per poll, for revert tracking, design §6).
  - Enable: `"plugins": { "source": "github-issues", ... }`.
  - Secrets: `GITHUB_TOKEN`. Settings: `repo` (including `base_branch`), `intake_label`, `branch_prefix`, `poll_interval_ms`.

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

## Updater

What it does: keeps `npm run factory -- dev` on the latest commit of `origin/<base_branch>`. `dev` starts a supervisor; the updater decides where controller + worker run from and when they restart. `controller`, `worker` and the other commands never use it.

Plugins:

- `git-worktree`: `GitWorktreeUpdater`. The default.
  - First start: creates `<state_dir>/runtime` (`.factory/runtime`), a detached git worktree at `origin/<base_branch>`, runs `npm ci` and `npm run build` there, and forks the child from `.factory/runtime/dist/main.js`. The child reads `factory.config.json` and `prompts/` from the runtime copy (`SOFTWARE_FACTORY_CODE_ROOT`, set by the supervisor); its state stays in the main checkout: `state_dir`, `worktrees_dir`, `repo.path`, the database, `.factory/storage` and the secret file.
  - Every `poll_interval_ms`: `git fetch origin <base_branch>`. A change to `src/`, `prompts/`, `package.json`, `package-lock.json`, `tsconfig*.json` or `factory.config.json` is built first in `.factory/runtime-next` while the old child keeps running (`npm ci` only when `package-lock.json` changed). Only if that build succeeds: the child is asked to drain (an IPC message, no new signal), it stops claiming, lets its in-flight run finish, acknowledges and exits; then `.factory/runtime` is fast-forwarded, the built output is swapped in and the child restarts. A child that has not exited after `run_timeout_ms` plus 60 s is hard-stopped (SIGKILL) and the log says so.
  - Any other change (docs) only fast-forwards `.factory/runtime`; the child keeps running.
  - A failed build leaves the running child untouched, logs the failing step and the tail of its output, and is retried on the next new commit. A crashed child is restarted on the next poll, only from a tree that built.
  - Your checkout is fast-forwarded (`git merge --ff-only origin/<base_branch>`, i.e. `git pull --ff-only` after the fetch) only when it is on the base branch and `git status --porcelain` is empty; otherwise the log says why it was skipped (not on base, dirty, or ff failed). The updater never checks out, stashes, resets or switches branches in it.
  - Enable: `"plugins": { "updater": "git-worktree", ... }`, or no `plugins` object. Secrets: none (git uses your usual credentials for `fetch`). Settings: `repo.base_branch`, `state_dir`, `poll_interval_ms`, `run_timeout_ms`; `git` and `npm` on `PATH`.
  - Behaviour change: `dev` runs `origin/<base_branch>`, not your working tree. Uncommitted edits, local branches and commits merged locally but not pushed never run under `dev` until they are pushed and merged.
- `none`: `NoneUpdater`. `dev` runs controller + worker in place, from the checkout it was started in, exactly as before the updater existed. No git or process calls.
  - Enable: `"plugins": { "updater": "none", ... }`. Secrets: none.

Switch back / turn it off: `"plugins": { "updater": "none" }` (add the guards too if you write a `plugins` object, see above). The supervisor itself reads `plugins.updater`, `repo.base_branch`, `poll_interval_ms` and `run_timeout_ms` from the checkout it was started in; restart `dev` after changing them.

## KeepAwake

What it does: keeps the host from idle-sleeping while a job runs. The worker holds it right after it claims a run and releases it when the run is done, whether the run succeeded or failed. It is never held while the worker is idle, so the machine can sleep between jobs. Staying awake is best effort: if the hold fails, the worker logs a warning and runs the job anyway.

Plugins:

- `caffeinate`: `CaffeinateKeepAwake`. While held, runs `caffeinate -i -s -w <worker pid>` (macOS): `-i` prevents idle sleep, `-s` prevents system sleep on AC power, `-w` ends caffeinate when the worker process exits, so a crash cannot leave the machine awake. Release kills it.
  - Enable: `"plugins": { "awake": "caffeinate", ... }`, or leave `awake` out on macOS. Secrets: none. Settings: the `caffeinate` executable on `PATH` (it ships with macOS at `/usr/bin/caffeinate`).
  - Startup failure: if `caffeinate` is selected (explicitly or by the macOS default) and there is no `caffeinate` executable on `PATH`, `build()` fails at startup with an error naming `plugins.awake`, `caffeinate` and the `none` alternative.
- `none`: `NoKeepAwake`. Does nothing; the host's own power settings decide.
  - Enable: `"plugins": { "awake": "none", ... }`, or leave `awake` out on any OS other than macOS. Secrets: none.

Platform default: with no `plugins.awake` key, the factory picks `caffeinate` when `process.platform` is `darwin` and `none` everywhere else. The checked-in `factory.config.json` has no `awake` key, so the platform decides.

Turn on / off: set `plugins.awake` to `caffeinate` (on) or `none` (off); delete the key to go back to the platform default.

**Closing the laptop lid still sleeps a Mac.** `caffeinate` only stops idle and system sleep; macOS sleeps on lid close regardless (unless an external display, power and keyboard are attached). Keep the lid open while jobs run. A worker that sleeps anyway recovers through the lease rules in `docs/design.md` §5 (host sleep).

Linux and Windows plugins do not exist yet.
