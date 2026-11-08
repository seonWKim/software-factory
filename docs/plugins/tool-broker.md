# ToolBroker

What it does: guard **G2**. Credentialed actions (push a branch, open a PR, comment) run in the worker process, outside the sandbox; the broker attaches the credential, checks the caller still holds its lease (fencing), pushes only to factory branches and egress-scans what it sends.

Tool names (since 2026-11-08): the brokers serve `forge.*` tools, named for the forge, not one vendor. The GitHub broker serves `forge.push_branch`, `forge.open_change`, `forge.comment` and `forge.preflight`; the local broker serves `forge.push_branch` only. Each old `github.*` name is an alias that runs the same code with the same arguments, results and error codes: `github.push_branch` → `forge.push_branch`, `github.open_pr` → `forge.open_change`, `github.comment` → `forge.comment`, `github.preflight` → `forge.preflight` (the table `TOOL_ALIASES` in `src/interfaces/tool-broker.ts`). A call by an alias logs one warning per alias per process naming both names. No `allTools()` lists an alias. The worker still calls the `github.*` names and finds optional tools by them (`hasTool` maps an alias to its `forge.*` tool); its calls move to `forge.*` in the next phase, and the aliases are removed after that.

Both brokers run the same trusted-git checks before a branch leaves a run folder (`src/impl/broker/trusted-git.ts`): the lease, the branch prefix, the trusted base from the factory repo (never the run folder), a run folder whose `.git` is its own, no run-folder git config key that could run a program (`untrusted_git_config`), and the egress scan of the branch's commit messages, its diff and every `.env.example` in its tree (`egress_blocked`). The GitHub broker also takes the push URL from the factory repo's `origin`.

Plugins:

- `github`: `GitHubToolBroker`.
  - Enable: `"plugins": { "broker": "github", ... }`, or no `plugins` object.
  - Secrets: none of its own; the push uses the token from `GitHubCredentials`. Settings: `branch_prefix`, `repo`.
- `local`: `LocalToolBroker` (since 2026-11-07), the solo default with no GitHub plugin (design `05-sources.md`, Local startup).
  - Enable: `"plugins": { "broker": "local", ... }`. Selecting it with no other GitHub plugin (no `github-issues` source, no `github` auth, no `github-permission` grant, no forge) is the local path: no GitHub credential, no origin fetch, no PR.
  - Secrets: none. Settings: `branch_prefix`, `repo.path`, `repo.base_branch`.
  - Tools: `forge.push_branch` only (its alias `github.push_branch` runs it too). It writes the run's HEAD to the local branch `refs/heads/<branch>` of the factory repo with git's local transport, never to a remote and never forced; the scanned diff starts at the factory repo's local `refs/heads/<base_branch>`. No `forge.open_change`, `forge.preflight` or `forge.comment` (their aliases answer `unknown_tool`): the worker skips the PR, the preflight's forge checks and PR comments when the broker has no such tool, and a local item's messages are its thread.

Granted tools: each tool descriptor sets `read_only`, true only for a tool that changes nothing (`github` marks `forge.preflight` read-only; `forge.push_branch`, `forge.open_change` and `forge.comment` are not). A broker lists every tool it serves through `allTools()`. `tool_grants` in `factory.config.json` grants read-only tools to agent runs per run kind (`triage`, `implement`, `review`, `update`, `resolve`, `manual`), for example `{"tool_grants": {"triage": ["forge.preflight"]}}`; absent, no grants. Startup checks it when the broker is built and fails on an unknown run kind, an unknown tool or one that is not read-only, listing the valid names. A `github.*` alias is refused in `tool_grants`, with the `forge.*` name to grant instead (for example `grant "forge.preflight" instead`): a grant names the tool, never an alias. Only a runner with `exposes_tools` (`claude-code`) can take grants. How the guards hold: `docs/architecture.md` §5.

Switch back: `"broker": "github"` (with the GitHub source and auth, the enterprise setting). The local branches stay in the factory repo; nothing is pushed for them.

Why it cannot be disabled: without the broker the only way to push or comment would be to hand the agent a token, which G2 forbids (architecture §5). Config that selects no `ToolBroker` fails at startup.

## History

- **Tool names `forge.*`** (2026-11-08, phase 1 of the forge rename). Before: both brokers named their tools `github.*` (`github.push_branch`, `github.open_pr`, `github.comment`, `github.preflight`), also the local broker, which talks to no GitHub. Changed so a tool's name says what it does on any forge; the `github.*` names stay as aliases until the worker's calls move (next phase), then are removed.

- **Trusted-git checks in one helper** (2026-11-07). Before: the run-folder, base and config checks and the branch scan lived inside the GitHub broker, the only broker.
- **Granted tools** (2026-11-07, issue #164). Before: no descriptor said whether a tool was read-only, and no tool could be granted to an agent run.
