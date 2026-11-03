# Clock

What it does: the time source. Injected so tests control time.

Plugins:

- `system`: `SystemClock`, the host's clock.
  - Enable: `"plugins": { "clock": "system", ... }`. Secrets: none.

`FakeClock` is test-only and not registered; tests pass it to `build()` directly. Switch back / disable: `"clock": "system"`.

## History

No earlier decision is recorded for this topic.
