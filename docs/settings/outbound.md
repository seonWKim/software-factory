# Settings catalog: outbound

The settings that `src/outbound/` reads; the index is [docs/settings.md](../settings.md).
Generated from the `*.setting.ts` files by `npm run settings:catalog`; do not edit by hand.
Direction: `tighten-only` keys may only be tightened by a lower level (owner → org → project → pack → user);
`review` keys change only by a reviewed PR to factory.config.json. Guards are never loosened.

| Key | Owner | Changed by | Scope | Direction | Class | Default | What it controls |
|---|---|---|---|---|---|---|---|
| `outbound.batching` | outbound | review | global | free |  | `{}` | Per destination kind or `*`: batching mode (auto, commit, fixed), debounce, max_wait, max_messages. |
