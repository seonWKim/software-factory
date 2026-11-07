# AgentRunner

What it does: runs one tool-using agent loop in a sandbox and returns its structured output and transcript. A runner reports a usage or rate limit as `status: "rate_limited"` (with `reset_at` if it knows it), never as a plain failure, so the factory pauses instead of spending an attempt.

Plugins:

- `claude-code`: `ClaudeCodeRunner` (`claude -p`), with a per-run HOME and a factory-owned `CLAUDE_CONFIG_DIR` under `<state_dir>/agents`, and the harness deny rules of architecture §5.
  - Enable: `"plugins": { "runner": "claude-code", ... }`.
  - Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) from the `SecretStore`, passed to the harness only. Settings: `models` (a model name for each of `cheap`, `standard` and `strong`, all three required; shipped: `haiku`, `sonnet`, `opus`), `run_timeout_ms`; the `claude` CLI on `PATH`. Which class each run uses is `model_by` (design §4), not a plugin setting.
  - Granted tools (`exposes_tools`): a run with `tool_grants` gets one MCP server, `factory_tools`, a bridge that forwards each call over a private Unix socket to the worker process, which checks the grant and the lease, calls the broker and scans the result. Other runners refuse a run with grants.
  - Rate limits: a Claude result with `api_error_status: 429` (usage or rate limit) is reported as the general `rate_limited` status, with `reset_at` when the message gives a reset time (an `|<epoch>` suffix, or `resets 12:10pm (Area/City)`). The worker then pauses every claim until that time, or for `retry_max_ms` when there is none (design §5 Restarts). All Claude CLI text parsing stays in this runner.

- `openai-compatible`: `OpenAICompatibleRunner`, its own chat-completions tool loop against any OpenAI-style endpoint, through the shared client in `src/impl/openai/` (no vendor SDK, no harness). Not a default: chosen by name only.
  - Enable: `"plugins": { "runner": "openai-compatible", ... }` and the `openai_compatible` block, the same one the `openai-compatible` LLM uses: `"openai_compatible": { "base_url": "https://api.example.com/v1", "models": { "cheap": "...", "standard": "...", "strong": "..." } }` (plain http only for localhost). The run's model class picks the model name.
  - Secrets: `OPENAI_COMPATIBLE_API_KEY` from the `SecretStore`, read by the runner once per run and passed only to the chat client as a Bearer token. It is scrubbed from the prompt, every request body, the transcript and every tool result, and never reaches a tool's environment.
  - Tools: the request lists exactly `spec.tools`, by name, in spec order. Each call runs through the shared tool (`ToolSpec.run` with `guardPolicy`), so a Read of a `.env` file or outside the workdir, or a Write or Edit outside `writable_paths` or under `deny_paths`, comes back to the model as a refusal and the run goes on. A tool the spec does not offer is refused the same way.
  - Bash: offered when the spec offers it, but every call is refused before it runs. Bash is not path-checked and no sandbox denies reads at OS level yet (`noop` only), so a shell could read the secret file or the G6 canary. Implement and review runs therefore work without a shell (no `npm test` by the agent; the worker's own checks still run).
  - Granted tools: none (`exposes_tools` false). A run with `tool_grants` fails with `toolsNotExposedMessage` and makes no model call.
  - Limits and results: at most 25 tool rounds; a model still asking for tools after that ends `failed` (`agent_failed`). `timeout_ms` ends the run `timed_out` and the caller's AbortSignal ends it `aborted`; both cancel the in-flight request. HTTP 429 is `rate_limited`, with `reset_at` from Retry-After when it gives one; any other error is `failed`. No request is retried. A final answer that is not JSON (one surrounding code fence is allowed) or does not match `output_schema` is returned `completed` with no output, so the worker records `invalid_output`. `usage` sums input and output tokens over every call, `usage.model` is the model the response reports, `cost_usd` is null. No stall detection (`stall_ms` is ignored).
  - Switch back: `"runner": "claude-code"` (the default).

A new runner reuses the shared tools in `src/core/tools` (`Read`, `Glob`, `Grep`, `Write`, `Edit`, `Bash` as `ToolSpec`s, with `guardPolicy`) instead of implementing its own file tools and deny rules, so it gets the file guards for free (architecture §5). `tests/helpers/scripted-runner.ts` is a test-only example, selected only with `withPlugin(REGISTRY, "runner", ...)` in tests and never in the registry.

Switch back / disable: `"runner": "claude-code"`. There is no "off".

## History

- **Runners** (2026-11-07, issue #194): added `openai-compatible`, with Bash refused per call. Before: `claude-code` was the only runner.
- **Granted tools** (2026-11-07, issue #164). Before: the runner threw on any run with grants.
