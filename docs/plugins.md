# Plugins

Every infrastructure interface has one or more **named plugins** (design D6). `factory.config.json` picks one
name per interface. Each plugin describes itself in a `*.plugin.ts` descriptor file beside its implementation
under `src/impl/`; the descriptors are the only non-test code that constructs these implementations. At startup
the loader in `src/plugins.ts` discovers them and fills the registry (the discovered registry, since 2026-11-01).
`src/compose.ts` (`build()`), the setup/doctor commands and the G6 canary all resolve plugins through that
registry, so whatever config selects is what runs and what the canary tests.

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
| SourceAdapter | `plugins.source` (a name, or a list of names; see SourceAdapter) | `github-issues` | no |
| SharedStorage | `plugins.storage` | `fs` | no |
| CapabilitySearch | `plugins.capability` | `list-all` (`bm25` available) | no |
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
- **Unknown config keys are rejected at load**, at every level of `factory.config.json` (top level, `store` for its `type`, `repo`, `dials`, each `floors[i]`, `models`, `agent_git_identity`, `ui`, `stats`, `plugins`): one error lists every unknown key with its path and the valid keys, and adds `did you mean "…"?` when a valid key is within edit distance 2. `npm run factory -- doctor` prints each as a FAIL line and exits 1.
- **Guards cannot be disabled.** For `secrets`, `egress` and `broker`, leaving the key out of a `plugins` object, or setting it to `null`, `false`, `""`, `"none"` or anything that is not a registered name, fails startup with an error that the plugin is a guard and points to `docs/architecture.md` §5. You can switch a guard to another registered plugin; you cannot turn it off.

To switch back to the defaults, set the key back to the default name above, or delete the whole `plugins` object. There is no loading from external packages: a plugin is a descriptor file in this repository.

### The discovered registry (changed 2026-11-01)

Before 2026-11-01, `src/plugins.ts` imported every implementation and listed every plugin by hand, and `tests/plugins.test.ts` repeated that list and its count, so every new plugin edited the same lines. Now:

- **One descriptor per plugin.** `src/impl/<area>/<name>.plugin.ts`, beside the implementation, default-exports `definePlugin({ kind, name, create, secrets?, default? })` from `src/plugin-api.ts`. `kind` is the interface's short name (`store`, `sandbox`, … `awake`); `name` is what config selects and must be unique within the kind (the same name under two kinds is fine); `create` gets the kind's typed context. Shared helpers live in modules without the `.plugin` suffix (for example `src/impl/claude/claude-shared.ts`).
- **Discovery.** At startup `src/plugins.ts` finds every `*.plugin.js` under the built `dist/impl/` (`*.plugin.ts` under `src/impl/` when run from source, as in tests; `*.d.ts` and source maps are ignored), sorts them by path, imports each one and registers it. `REGISTRY` is filled by top-level await. `src/plugins.ts` names no plugin and imports no implementation; only a new interface (a row in its kind table) edits it.
- **Defaults** come from the descriptors: `default: true` makes a plugin its kind's default on every platform no other plugin claims; `default: { platforms: ["darwin"] }` makes it the default on those platforms only (`awake`: `caffeinate` on `darwin`, `none` with `default: true` elsewhere). `store` and `auth` plugins take no default: their top-level keys always pick one.
- **Startup fails**, naming the file(s), when a descriptor has no default export or an unknown `kind`; when two plugins of one kind share a name (the error names the kind, the name and both files); when a non-guard `plugins` kind has no `default: true`, or two plugins claim the default for the same platform (the error names the kind and the files); when a guard kind has no plugin at all; or when a guard plugin is named `none` or `""`.
- **Stale builds.** `npm run build` (also run by `npm run factory` and `npm run setup`) empties `dist/` before `tsc`, so a deleted descriptor leaves no `*.plugin.js` behind to be registered.

**Adding an implementation:** in the same change, add the implementation and its `*.plugin.ts` descriptor beside it, and its section below. No central file and no test list changes: `tests/plugins.test.ts` runs its property tests over every discovered descriptor, and fails if a registered name is missing from this file.

**Declared secrets.** Each descriptor lists the secret names its plugin reads, each with a one-line purpose (`secrets` in the `*.plugin.ts` file; `withPlugin` takes the same list as an optional last argument). A name is checked by `secretName()`: upper-case letters, digits and `_`, starting with a letter. The secret set is the union of the names the **selected** plugins declare (`declaredSecretNames`): the `SecretStore` loads, returns and scans exactly those, so switching a plugin in config changes the set with no code edit (for example `store.type` `sqlite` drops `MYSQL_PASSWORD`). Any other key in the secret file, a plain setting such as `MYSQL_HOST` or a secret no selected plugin declares, is never returned and never scanned. A declared secret missing from the file does not stop startup; `npm run factory -- doctor` reports it as FAIL and `npm run setup` asks for it. Declarations that share a `oneOf` label are alternatives (the model credential: `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`). Each plugin's **Secrets:** line below lists exactly its declared names; `tests/secret-names.test.ts` fails when they drift, and checks that `.env.example` lists every name the default selection declares.

## FactoryStore

What it does: the factory's state (work items, runs, state changes, handoffs, leases). Every transition is a conditional update, so any number of controllers and workers can share it (architecture §4). The logic exists once in `SqlFactoryStore`; a backend is a `SqlDriver`.

Plugins:

- `mysql`: `SqlFactoryStore` over `MysqlDriver`. Any number of processes on any hosts. Selected by the checked-in config.
  - Enable: `"store": { "type": "mysql", "host": "localhost", "port": 3306, "database": "software_factory", "user": "factory" }`.
  - Secrets: `MYSQL_PASSWORD` in the secret file (`npm run setup` creates the database, the user and the password). Settings: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER` in the secret file override the `store` block per machine (`docs/setup.md`).
  - Schema: numbered step files in `migrations/mysql/` (README there), run only by `npm run migrate` (`-- --status` lists pending steps, `-- --dry-run` shows what would run). Opening the store never applies a step: while steps are pending, startup refuses (`dev`, `worker`, `controller`, `status`, `ui`, `golden add` exit non-zero with "run `npm run migrate`") and `doctor` shows a FAIL line. A new database needs `npm run migrate` once after `npm run setup` creates it.
- `sqlite`: `SqlFactoryStore` over `SqliteDriver`, file at `<state_dir>/db/factory.db`. One machine. Used when there is no `store` block.
  - Enable: `"store": { "type": "sqlite" }`. Secrets: none. Builds the latest schema when opened; it has no step files, and `npm run migrate` exits non-zero on it.

Switch back / disable: set `store.type` to the other name. A store cannot be disabled: the factory has no state without one.

## AuthProvider

What it does: resolves an external identity to a principal and decides whether it may act (submit work, approve, reject, retry). Deny by default.

Plugins:

- `github`: `GitHubAuthProvider`. Approvals need write permission on the repository.
  - Enable: `"auth": "github"` (top level). Secrets: none of its own; it calls GitHub through the shared client, whose credential comes from `GitHubCredentials`.
- `none`: `NoAuthProvider`. Allows everything; local development only.
  - Enable: `"auth": "none"`. Secrets: none.

Switch back / disable: set `auth` to `github`. `none` is the "no checks" choice; there is no way to run without an `AuthProvider`.

## SecretStore

What it does: guard **G1**. Loads secrets in the worker/controller process only and hands out opaque values; it also gives the egress scanner the values to look for. Agents never get it.

Plugins:

- `env-file`: `EnvFileSecretStore`. Reads `${XDG_CONFIG_HOME:-~/.config}/software-factory/.env` (or `SOFTWARE_FACTORY_SECRETS_FILE`), lazily, once.
  - Enable: `"plugins": { "secrets": "env-file", ... }`, or no `plugins` object.
  - Loads only the names the selected plugins declare (see "Declared secrets" above); every other key in the file is ignored.
  - Secrets: none of its own; it holds the ones the other selected plugins declare (`docs/setup.md`). Settings: none.

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
  - Secrets: none of its own; the push uses the token from `GitHubCredentials`. Settings: `branch_prefix`, `repo`.

Switch back: `"broker": "github"`.

Why it cannot be disabled: without the broker the only way to push or comment would be to hand the agent a token, which G2 forbids (architecture §5). Config that selects no `ToolBroker` fails at startup.

## Sandbox

What it does: where an agent run happens: create a workspace for a branch, run commands in it, destroy it.


`updateBase(repo, base_ref)` is trusted like `create`: it fetches `origin` in the factory repo and returns its `origin/<base_ref>` commit. Sync before push copies that commit into the clone from the factory repo, never from the clone's own remote.

Plugins:

- `noop`: `NoOpSandbox`. One clone of the factory repo per run, in its own folder under `worktrees_dir` on the host, no OS isolation (design §5: keep it on test environments only).
  - The clone has its own git folder inside the run folder, not a worktree sharing the owner's `.git`: branches, index, `HEAD`, refs and config an agent changes there never reach the factory repo, and the run gets no writable path outside its folder (architecture §5). Objects are borrowed from the factory repo through an alternates link, not copied; the agent can still read them.
  - `core.hooksPath` points to `<worktrees_dir>/.empty-hooks`, an empty, read-only folder outside every run folder, so a hook the agent puts in the clone's `.git/hooks` never runs. Creation refuses if that folder is not empty.
  - The handle's `base_sha` is the factory repo's `origin/<base>`, resolved before any agent runs; the worker's gates and the broker diff from the factory repo's commit, not the run folder's ref. The clone's `origin` names the real remote for reading only: the broker pushes to the factory repo's remote.
  - `destroy` removes the run folder. Nothing is registered in the factory repo, so `git worktree list` there has no entry for it; a second destroy is a no-op.
  - Risk: if the factory repo runs `git gc --prune` during a run and drops an object only a clone still needs, that clone can break. Runs are short, so this is accepted.
  - Enable: `"plugins": { "sandbox": "noop", ... }`. Secrets: none. Settings: `worktrees_dir`.

Switch back / disable: `"sandbox": "noop"`. There is no "off": runs need a workspace.

## AgentRunner

What it does: runs one tool-using agent loop in a sandbox and returns its structured output and transcript. A runner reports a usage or rate limit as `status: "rate_limited"` (with `reset_at` if it knows it), never as a plain failure, so the factory pauses instead of spending an attempt.

Plugins:

- `claude-code`: `ClaudeCodeRunner` (`claude -p`), with a per-run HOME and a factory-owned `CLAUDE_CONFIG_DIR` under `<state_dir>/agents`, and the harness deny rules of architecture §5.
  - Enable: `"plugins": { "runner": "claude-code", ... }`.
  - Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) from the `SecretStore`, passed to the harness only. Settings: `models`, `run_timeout_ms`; the `claude` CLI on `PATH`.
  - Rate limits: a Claude result with `api_error_status: 429` (usage or rate limit) is reported as the general `rate_limited` status, with `reset_at` when the message gives a reset time (an `|<epoch>` suffix, or `resets 12:10pm (Area/City)`). The worker then pauses every claim until that time, or for `retry_max_ms` when there is none (design §5 Restarts). All Claude CLI text parsing stays in this runner.

A new runner reuses the shared tools in `src/core/tools` (`Read`, `Glob`, `Grep`, `Write`, `Edit`, `Bash` as `ToolSpec`s, with `guardPolicy`) instead of implementing its own file tools and deny rules, so it gets the file guards for free (architecture §5). `tests/helpers/scripted-runner.ts` is a test-only example, selected only with `withPlugin(REGISTRY, "runner", ...)` in tests and never in the registry.

Switch back / disable: `"runner": "claude-code"`. There is no "off".

## LLMProvider

What it does: single model calls without tools (for example classification). Refuses `prod` data.

Plugins:

- `claude-cli`: `ClaudeCliLLMProvider`, one turn through the Claude Code CLI on the subscription login (D2).
  - Enable: `"plugins": { "llm": "claude-cli", ... }`.
  - Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`). Settings: `models`; the `claude` CLI on `PATH`.

Smoke-test with `npm run factory -- llm-check` (`--model strong` for the strong class): it builds the configured provider through the registry (`Plugins.llm()`) and makes two small real calls, one plain and one with an output schema, every printed line egress-scanned first. `npm run factory -- doctor --llm` runs the same check as one doctor line; plain `doctor` makes no model call. No factory workflow step calls the provider.

Switch back / disable: `"llm": "claude-cli"`.

## SourceAdapter

What it does: intake. Brings in new work items and commands from a source, and posts comments back. `SourceAdapter` is a union on `intake` (docs/architecture.md, Intake):

- `intake: "poll"` (`PollSource`): `poll(cursor)` returns events and the next cursor; the controller calls it every `poll_interval_ms`.
- `intake: "stream"` (`StreamSource`): `subscribe(signal)` returns an `AsyncIterable<PushedEvent>`, for sources that push events as they happen (e.g. Slack Socket Mode).

Both kinds have `postComment`, `markSeen` and `setStatus`.

Plugins:

- `github-issues`: `GitHubIssueSource`. Issues with the intake label on the configured repository, their comments and pull requests, and commits on the base branch (`repo.base_branch`; one extra API call per poll, for revert tracking, design §6).
  - `setStatus(source, status, pr_number)`: shows one of eight statuses (`triaging`, `needs_approval`, `implementing`, `in_review`, `ready_to_merge`, `needs_human`, `done`, `rejected`) as a label. `pr_number` null labels the issue; non-null labels that PR instead (PRs share the issue labels API), so the controller calls it once for the issue and once for the PR. Each call creates the label if missing (a 422 `already_exists` counts as success), adds it, and removes the other seven fixed names; a 404 on removal counts as success, and no other label is touched, including other labels under the prefix. Idempotent and best effort: the controller logs a failure as a warning and the transition stands. Names, colours and descriptions live in one table in `src/impl/source/github-issue-source.ts`. Uses the existing Issues read/write permission; no new scope.
  - Enable: `"plugins": { "source": "github-issues", ... }`.
  - Secrets: none of its own (the shared client's `GitHubCredentials`). Settings: `repo` (including `base_branch`), `intake_label`, `branch_prefix`, `poll_interval_ms`, `status_label_prefix` (optional, default `"sf: "`; labels are the prefix plus e.g. `needs approval`. Changing it leaves labels under the old prefix in place).

Other sources may implement `setStatus` as a no-op.

**Several sources (changed 2026-11-01; before: `plugins.source` took one name and every comment, 👀, status and close went through that one adapter).** `plugins.source` takes one name or a list of names:

- `"source": "github-issues"` and `"source": ["github-issues"]` select the same thing as always.
- `"source": ["github-issues", "<other>"]` runs both. The factory builds one adapter per name. Each poll source has its own cursor (`intake:<source type>`) and each stream source its own listener and inbox cursor (`inbox:<source type>`). Each source's intake step runs on its own, so a source that fails (a poll that throws) does not stop the others in the same tick; its cursor simply does not move.
- Fails at startup, naming `plugins.source`: an empty list, an unknown name, the same name twice, two entries that build the same source type, or several entries with none of type `github_issue`. PR merge, close and unmergeable events come only from `github-issues`, so without it factory PRs would never close their items. One non-GitHub source alone is still accepted.
- **Per-item routing.** The controller sends each item's `postComment`, `markSeen`, `setStatus` and `closeIssue` to the adapter whose `type` matches the item's source type, so replies go back where the item came from. A command's reply goes to the source the command came from.
- **PRs stay on GitHub.** `setStatus` for a PR (non-null `pr_number`) goes to the `github_issue` adapter, whatever the item's own source. (With only one non-GitHub source configured, it goes to that source, as before.)
- An item whose source type is no longer listed keeps its state: its comment, 👀, status and close calls log the warning `no source adapter for the item's source type; skipped` and do nothing.
- Commands (`/approve`, `/revise`, `/help`, unknown commands, plain comments) from any source run the same command table, the same `AuthProvider` permission check and the same replies.
- Secrets: the union of what every listed source declares.

**Writing a stream source plugin.** Implement `StreamSource` (`src/interfaces/source-adapter.ts`) with `readonly intake = "stream"` and a `type` from `SourceType`:

- `subscribe(signal)` opens **one** connection and yields a `PushedEvent` per event: the `SourceEvent`, a `dedupe_key` that is unique within the source and the same on every redelivery of that event (e.g. Slack's `envelope_id`, or better the event id), and `ack()`. The iterable completes when the connection ends and throws when it fails. Stop and complete once `signal` aborts. Do not reconnect inside `subscribe`: the listener does that, with backoff, by calling it again.
- `ack()` tells the source the event is safe. The listener calls it only after the event is committed to the store inbox, so do not ack on receipt. An event that was never acked must come back on a later connection; that is what makes a crash lose nothing.
- Do not keep state another replica would need. Only the replica holding the source's listener lease calls `subscribe`; every replica's controller handles the events from the inbox, through the same `handleEvent` as polled events, so the source's `postComment`, `markSeen` and `setStatus` are called from whichever replica handles the event.
- Credentials (e.g. a Socket Mode app token) are read by the plugin from the `SecretStore` passed in its factory context, as `github-issues` does through `GitHubClient`, never put in events or logs.
- Register it in `src/plugins.ts` under `source` with its section here, as for any plugin. Settings: `lease_ms` and `heartbeat_ms` (the listener lease reuses them), `inbox_retention_days` (optional, default 14, a positive integer or startup fails: inbox rows older than this that every reader has passed are deleted).

`fake-stream` (`FakeStreamSource`, source type `slack_thread`) is **test-only**: it lives in `tests/helpers/fakes.ts`, is added with `withPlugin` through `fakeStreamRegistry()` in tests only, and is not in `REGISTRY`, so config cannot select it.

`fake-slack-poll` (`FakeSlackPollSource`, a poll source of type `slack_thread`) is **test-only** in the same way, through `fakeSlackPollRegistry()`; tests use it as the second source next to GitHub.

Switch back / disable: `"source": "github-issues"` (or drop the other names from the list). There is no "off".

## SharedStorage

What it does: blobs shared between processes (transcripts, logs, the read-only shared pool), under keys.

Plugins:

- `fs`: `FsSharedStorage`, files under `<state_dir>/storage` (a deny path for agents).
  - Enable: `"plugins": { "storage": "fs", ... }`. Secrets: none. Settings: `state_dir`.

Switch back / disable: `"storage": "fs"`.

## CapabilitySearch

What it does: finds docs, skills, tools and MCP servers for a task (design §7, progressive disclosure). `build()` creates the selected plugin and passes it to the worker. For triage the worker searches with the work item's problem; for implement and review, with the problem plus the done criteria. The top 8 results are appended to the agent's prompt as a `## Available docs (index)` section, one line each: path, name and snippet. Agents read the full text of a path with the `Read` tool they already have. No results means no section, so the prompt is exactly as without a search. A failed search logs a warning and the run goes on without an index.

Finding a doc is not permission: the index changes nothing about tools, `deny_paths`, writable paths or tool grants. An agent can Read a listed path only where it could already read it.

Plugins:

- `list-all`: `ListAllCapabilitySearch`. Returns the first N entries of a list of capabilities.
  - Enable: `"plugins": { "capability": "list-all", ... }` (the checked-in default). Secrets: none.
  - **Not wired in yet:** nothing fills its list (`build()` passes an empty one), so it always returns nothing and agents get no index section. Prompts are the same as before the index existed.
- `bm25`: `Bm25CapabilitySearch` (`src/impl/capability/bm25-capability-search.ts`). BM25 ranking over the repo's markdown.
  - Indexes: `*.md` files under `docs/` and `skills/` below the code root (the runtime copy under the `git-worktree` updater). Skipped: `prompts/` (already the system prompt), `node_modules/`, dot-directories, symlinks, and anything outside those two roots. A file under `skills/` has kind `skill`; the rest have kind `doc`. The id is the repo-relative path.
  - Each entry keeps the name (first `#` heading, else the file name), the other headings, the first paragraph after the title and the full body. Tokens are lowercased runs of letters and digits. A term in the name or a heading counts 3 times (a fixed boost), so a heading match ranks above the same term in body text only.
  - Snippet: the first paragraph after the title on one line, at most 200 characters, ending in `…` when cut.
  - Index size in the prompt: 8 results (fixed).
  - Rebuild: the index is built at startup, and every search rebuilds it when an indexed file's mtime or size changes or a file is added or removed. It is a per-process cache of the files; nothing is stored or shared, so replicas need no coordination.
  - Enable: `"plugins": { "capability": "bm25", ... }`. Secrets: none.

Switch with the `plugins.capability` key:

```jsonc
// factory.config.json: turn the doc index on
"plugins": { ..., "capability": "bm25" }
```

Switch back / disable: `"capability": "list-all"` (or leave the key out: `list-all` is the default). Agents then get no index section again.

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

The `git-worktree` updater also writes `<state_dir>/supervisor.json` (what it is doing: running, building, draining, restarting, build_failed, crashed with the child's error, stopped) for the status page's banner. `none` writes nothing, and the page then shows no banner state beyond "stopped".

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

## GitHubCredentials

What it does: supplies the token for every GitHub call: the shared REST client (issues, comments, labels, PRs) and the broker's `git push`. Only those two tool implementations call it; the token never reaches an agent, a prompt, a log or the store (guards G1–G2).

Plugins:

- `token`: `TokenCredentials`. A personal access token from the secret file, used as is. GitHub shows every write as the token's owner.
  - Enable: `"plugins": { "github_auth": "token", ... }`, or no `github_auth` key.
  - Secrets: `GITHUB_TOKEN` (fine-grained, this repository only; `docs/setup.md`).
- `app`: `AppCredentials`. Acts as the GitHub App's bot. It signs a JWT (RS256, 9 minutes) with the App's key, looks up the App's installation on `repo`, and exchanges the JWT for an installation token limited to that one repository. The token is cached until 5 minutes before it expires (GitHub gives one hour); concurrent callers share one mint.
  - Enable: `"plugins": { "github_auth": "app", ... }`. The App must be installed on the repository with Contents, Issues and Pull requests read and write.
  - Secrets: `GITHUB_APP_ID`. Settings: the App's private key in `github-app.pem`, next to the secret file (`~/.config/software-factory/`), read only when a token is minted. A missing ID or unreadable key is a FAIL in `npm run factory -- doctor`.

Turn on / off: set `plugins.github_auth` to `app` (bot) or `token` (your account); delete the key to go back to `token`.
