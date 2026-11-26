# Settings catalog: state

The settings that `src/state/` reads; the index is [docs/settings.md](../settings.md).
Generated from the `*.setting.ts` files by `npm run settings:catalog`; do not edit by hand.
Direction: `tighten-only` keys may only be tightened by a lower level (owner → org → project → pack → user);
`review` keys change only by a reviewed PR to factory.config.json. Guards are never loosened.

| Key | Owner | Changed by | Scope | Direction | Class | Default | What it controls |
|---|---|---|---|---|---|---|---|
| `store` | state | review | global | free |  |  | Where the factory keeps its state: the store's driver and location. |
