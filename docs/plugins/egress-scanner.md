# EgressScanner

What it does: the egress scanner, guard **G5**. Scans every agent output (commits, PR text, comments, handoff rows, run outcomes, logs, tool results) for known secret values and secret patterns before it leaves. A hit fails the run.

Plugins:

- `pattern`: `PatternEgressScanner`. Known values from the `SecretStore` (plus the G6 canary during a canary run) and secret patterns (GitHub tokens, Anthropic keys, AWS keys, private keys, the canary).
  - Enable: `"plugins": { "egress": "pattern", ... }`, or no `plugins` object. Secrets: none of its own; it reads values through the selected `SecretStore`.

Switch back: `"egress": "pattern"`.

Why it cannot be disabled: G5 is the last guard before a leak reaches GitHub or the store, and the G6 canary checks it. Architecture §5 requires every guard to stay on. Config that selects no `EgressScanner` fails at startup.

## History

No earlier decision is recorded for this topic.
