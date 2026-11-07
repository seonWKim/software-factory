# ToolBroker

What it does: guard **G2**. Credentialed actions (push a branch, open a PR, comment) run in the worker process, outside the sandbox; the broker attaches the credential, checks the caller still holds its lease (fencing), pushes only to factory branches and egress-scans what it sends.

Plugins:

- `github`: `GitHubToolBroker`.
  - Enable: `"plugins": { "broker": "github", ... }`, or no `plugins` object.
  - Secrets: none of its own; the push uses the token from `GitHubCredentials`. Settings: `branch_prefix`, `repo`.

Merge (decision changed 2026-11-08, issue #246): the `github` broker module also holds the bot's merge, `mergePullRequest` (`src/impl/broker/github-tool-broker.ts`): one `PUT /repos/<owner>/<name>/pulls/<n>/merge` with `sha` = the reviewed head, so GitHub merges only that head, and GitHub's own merge commit subject (no item text is sent, so nothing needs a scan). GitHub's 405 (`merge_refused`) and 409 (`head_changed`) are results in fixed words, never GitHub's text; a 401/403 is `forge_auth`; anything else throws. It is not a listed tool: no agent run may merge, tools are fenced by a run's lease and the merge is the controller's after its re-checks, so `allTools()` is unchanged and `tool_grants` can never name it. The `github` forge's `mergePr` calls it (docs/plugins/forge.md). Changing it needs a human merge, like every change to the factory's own tools.

Granted tools: each tool descriptor sets `read_only`, true only for a tool that changes nothing (`github` marks `github.preflight` read-only; `github.push_branch`, `github.open_pr` and `github.comment` are not). A broker lists every tool it serves through `allTools()`. `tool_grants` in `factory.config.json` grants read-only tools to agent runs per run kind (`triage`, `implement`, `review`, `update`, `resolve`, `manual`), for example `{"tool_grants": {"triage": ["github.preflight"]}}`; absent, no grants. Startup checks it when the broker is built and fails on an unknown run kind, an unknown tool or one that is not read-only, listing the valid names. Only a runner with `exposes_tools` (`claude-code`) can take grants. How the guards hold: `docs/architecture.md` §5.

Switch back: `"broker": "github"`.

Why it cannot be disabled: without the broker the only way to push or comment would be to hand the agent a token, which G2 forbids (architecture §5). Config that selects no `ToolBroker` fails at startup.

## History

- **Merge** (decision changed 2026-11-08, issue #246). Before: the broker could push, open a PR and comment, never merge; only a person on GitHub merged.

- **Granted tools** (2026-11-07, issue #164). Before: no descriptor said whether a tool was read-only, and no tool could be granted to an agent run.
