# ToolBroker

What it does: guard **G2**. Credentialed actions (push a branch, open a PR, comment) run in the worker process, outside the sandbox; the broker attaches the credential, checks the caller still holds its lease (fencing), pushes only to factory branches and egress-scans what it sends.

Plugins:

- `github`: `GitHubToolBroker`.
  - Enable: `"plugins": { "broker": "github", ... }`, or no `plugins` object.
  - Secrets: none of its own; the push uses the token from `GitHubCredentials`. Settings: `branch_prefix`, `repo`.

Granted tools: each tool descriptor sets `read_only`, true only for a tool that changes nothing (`github` marks `github.preflight` read-only; `github.push_branch`, `github.open_pr` and `github.comment` are not). A broker lists every tool it serves through `allTools()`. `tool_grants` in `factory.config.json` grants read-only tools to agent runs per run kind (`triage`, `implement`, `review`, `update`, `resolve`, `manual`), for example `{"tool_grants": {"triage": ["github.preflight"]}}`; absent, no grants. Startup checks it when the broker is built and fails on an unknown run kind, an unknown tool or one that is not read-only, listing the valid names. Only a runner with `exposes_tools` (`claude-code`) can take grants. How the guards hold: `docs/architecture.md` §5.

Switch back: `"broker": "github"`.

Why it cannot be disabled: without the broker the only way to push or comment would be to hand the agent a token, which G2 forbids (architecture §5). Config that selects no `ToolBroker` fails at startup.

## History

- **Granted tools** (2026-11-07, issue #164). Before: no descriptor said whether a tool was read-only, and no tool could be granted to an agent run.
