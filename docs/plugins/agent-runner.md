# AgentRunner

What it does: runs one tool-using agent loop in a sandbox and returns its structured output and transcript. A runner reports a usage or rate limit as `status: "rate_limited"` (with `reset_at` if it knows it), never as a plain failure, so the factory pauses instead of spending an attempt.

Plugins:

- `claude-code`: `ClaudeCodeRunner` (`claude -p`), with a per-run HOME and a factory-owned `CLAUDE_CONFIG_DIR` under `<state_dir>/agents`, and the harness deny rules of architecture §5.
  - Enable: `"plugins": { "runner": "claude-code", ... }`.
  - Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) from the `SecretStore`, passed to the harness only. Settings: `models` (a model name for each of `cheap`, `standard` and `strong`, all three required; shipped: `haiku`, `sonnet`, `opus`), `run_timeout_ms`; the `claude` CLI on `PATH`. Which class each run uses is `model_by` (design §4), not a plugin setting.
  - Rate limits: a Claude result with `api_error_status: 429` (usage or rate limit) is reported as the general `rate_limited` status, with `reset_at` when the message gives a reset time (an `|<epoch>` suffix, or `resets 12:10pm (Area/City)`). The worker then pauses every claim until that time, or for `retry_max_ms` when there is none (design §5 Restarts). All Claude CLI text parsing stays in this runner.

A new runner reuses the shared tools in `src/core/tools` (`Read`, `Glob`, `Grep`, `Write`, `Edit`, `Bash` as `ToolSpec`s, with `guardPolicy`) instead of implementing its own file tools and deny rules, so it gets the file guards for free (architecture §5). `tests/helpers/scripted-runner.ts` is a test-only example, selected only with `withPlugin(REGISTRY, "runner", ...)` in tests and never in the registry.

Switch back / disable: `"runner": "claude-code"`. There is no "off".

## History

No earlier decision is recorded for this topic.
