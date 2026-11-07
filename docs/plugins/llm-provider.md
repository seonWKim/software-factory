# LLMProvider

What it does: single model calls without tools (for example classification). Refuses `prod` data.

Plugins:

- `claude-cli`: `ClaudeCliLLMProvider`, one turn through the Claude Code CLI on the subscription login (D2).
  - Enable: `"plugins": { "llm": "claude-cli", ... }`.
  - Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`). Settings: `models` (`cheap`, `standard`, `strong`); the `claude` CLI on `PATH`.
- `openai-compatible`: `OpenAICompatibleLLMProvider`, one request to any OpenAI-style chat completions endpoint (`POST <base_url>/chat/completions`) through the shared client in `src/impl/openai/`. Not a default: it is picked only by its name in `plugins.llm`.
  - Enable: `"plugins": { "llm": "openai-compatible", ... }` and an `openai_compatible` block, e.g. `"openai_compatible": { "base_url": "https://api.example.com/v1", "models": { "cheap": "...", "standard": "...", "strong": "..." } }` (https, or plain http only for localhost, 127.0.0.1, [::1]).
  - Secrets: `OPENAI_COMPATIBLE_API_KEY`
  - Read through the SecretStore on each call (sent as a Bearer token), never from the environment. Without the `openai_compatible` block the plugin still builds; every call returns `stop_reason` `error` naming the missing block.
  - An `output_schema` is sent as `response_format` `json_schema` with `strict: true`, and the provider checks the reply against it itself (not JSON, or not matching: `error`). The shared client gives no finish reason and no cost: `stop_reason` is `end` on any 2xx reply (never `max_tokens`) and `cost_usd` is always null. Usage comes from `prompt_tokens` and `completion_tokens`. No retries, streaming or tool calls; an HTTP error, a 429 or a network failure is `error`.
  - Switch back: `"llm": "claude-cli"`.

Fallback chain (design 2026-11-07, `docs/design/08-plugins.md`): list several providers, tried in order.

- Enable: `"plugins": { "llm": ["claude-cli", "openai-compatible"], ... }`, with each member's settings and secrets as above; `npm run setup` and `doctor` cover every member.
- A call goes to the next provider when one throws or answers `stop_reason` `error` with no output. `end`, `refused` and `max_tokens` are answers and are returned as they are. The answer names its provider in `served_by`; usage is summed over the providers tried. If every provider fails, the call throws (or returns the last `error` answer) with each failure listed.
- `llm-check` checks the chain as one provider: it passes when any member answers.
- Switch back: a single name again, e.g. `"llm": "claude-cli"` (a list of one is the same).

Smoke-test with `npm run factory -- llm-check` (`--model standard` or `--model strong` for the other classes): it builds the configured provider through the registry (`Plugins.llm()`) and makes two small real calls, one plain and one with an output schema, every printed line egress-scanned first. `npm run factory -- doctor --llm` runs the same check as one doctor line; plain `doctor` makes no model call. No factory workflow step calls the provider.

Switch back / disable: `"llm": "claude-cli"`.

## History

- **Fallback chain** (2026-11-07). Before: `plugins.llm` took one name only.
