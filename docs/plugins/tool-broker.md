# ToolBroker

What it does: guard **G2**. Credentialed actions (push a branch, open a PR, comment) run in the worker process, outside the sandbox; the broker attaches the credential, checks the caller still holds its lease (fencing), pushes only to factory branches and egress-scans what it sends.

Both brokers run the same trusted-git checks before a branch leaves a run folder (`src/impl/broker/trusted-git.ts`): the lease, the branch prefix, the trusted base from the factory repo (never the run folder), a run folder whose `.git` is its own, no run-folder git config key that could run a program (`untrusted_git_config`), and the egress scan of the branch's commit messages, its diff and every `.env.example` in its tree (`egress_blocked`). The GitHub broker also takes the push URL from the factory repo's `origin`.

Plugins:

- `github`: `GitHubToolBroker`.
  - Enable: `"plugins": { "broker": "github", ... }`, or no `plugins` object.
  - Secrets: none of its own; the push uses the token from `GitHubCredentials`. Settings: `branch_prefix`, `repo`.
- `local`: `LocalToolBroker` (since 2026-11-07), the solo default with no GitHub plugin (design `05-sources.md`, Local startup).
  - Enable: `"plugins": { "broker": "local", ... }`. Selecting it with no other GitHub plugin (no `github-issues` source, no forge) is the local path: no GitHub credential, no origin fetch, no PR.
  - Secrets: none. Settings: `branch_prefix`, `repo.path`, `repo.base_branch`.
  - Tools: `git.store_branch` (every run's push and `factory session finish`, RFC 0015 M7; content `forge: false`). It writes the run's HEAD to the local branch `refs/heads/<branch>` of the factory repo with git's local transport, never to a remote and never forced; the scanned diff starts at the factory repo's local `refs/heads/<base_branch>`. No `forge.preflight`: the worker skips the preflight's forge checks when the broker has no such tool. No broker comments on anything: a run's comments are thread entries that outbound delivers (RFC 0015 M7), and a local item's thread is its surface.

Tool names are forge-neutral (decision changed 2026-11-12, the github.* aliases removed; before: see History): the preflight is `forge.preflight` (`PREFLIGHT`, `src/interfaces/tool-broker.ts`), so core code names no forge. No broker knows a `github.*` name any more: a call to one is answered `unknown_tool`, like any name the broker does not list, and startup refuses `github.preflight` in `tool_grants` as a tool the broker does not list, naming `forge.preflight` among the valid read-only tools of the `github` broker.

Granted tools: each tool descriptor sets `read_only`, true only for a tool that changes nothing (`github` marks `forge.preflight` read-only; `git.store_branch` is not). A broker lists every tool it serves through `allTools()`. `tool_grants` in `factory.config.json` grants read-only tools to agent runs per run kind (`triage`, `implement`, `review`, `update`, `resolve`, `manual`), for example `{"tool_grants": {"triage": ["forge.preflight"]}}`; absent, no grants. Startup checks it when the broker is built and fails on an unknown run kind, an unknown tool or one that is not read-only, listing the valid names. Only a runner with `exposes_tools` (`claude-code`) can take grants. How the guards hold: `docs/architecture.md` §5.

Switch back: `"broker": "github"` (with the GitHub source, the enterprise setting). The local branches stay in the factory repo; nothing is pushed for them.

Why it cannot be disabled: without the broker the only way to push or comment would be to hand the agent a token, which G2 forbids (architecture §5). Config that selects no `ToolBroker` fails at startup.

## History

- **The github.* aliases removed** (2026-11-12, the forge rename, phase 4). Before: the old name `github.preflight` was an alias (`TOOL_ALIASES`, `forgeToolName`, `src/impl/broker/tool-alias.ts`): a broker ran it as `forge.preflight` and logged one warning per process naming both.
- **Forge-neutral tool names** (2026-11-09, the forge rename, phase 1). Before: the preflight was `github.preflight`, named in core code. The rename first covered four tools (2026-11-08, a local merge that never reached origin); after RFC 0015 moved pushes, PRs and comments to outbound, only the preflight was left to rename.
- **Trusted-git checks in one helper** (2026-11-07). Before: the run-folder, base and config checks and the branch scan lived inside the GitHub broker, the only broker.
- **Granted tools** (2026-11-07, issue #164). Before: no descriptor said whether a tool was read-only, and no tool could be granted to an agent run.
