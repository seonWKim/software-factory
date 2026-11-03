# ToolBroker

What it does: guard **G2**. Credentialed actions (push a branch, open a PR, comment) run in the worker process, outside the sandbox; the broker attaches the credential, checks the caller still holds its lease (fencing), pushes only to factory branches and egress-scans what it sends.

Plugins:

- `github`: `GitHubToolBroker`.
  - Enable: `"plugins": { "broker": "github", ... }`, or no `plugins` object.
  - Secrets: none of its own; the push uses the token from `GitHubCredentials`. Settings: `branch_prefix`, `repo`.

Switch back: `"broker": "github"`.

Why it cannot be disabled: without the broker the only way to push or comment would be to hand the agent a token, which G2 forbids (architecture §5). Config that selects no `ToolBroker` fails at startup.

## History

No earlier decision is recorded for this topic.
