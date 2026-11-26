# Settings catalog: inbound

The settings that `src/inbound/` reads; the index is [docs/settings.md](../settings.md).
Generated from the `*.setting.ts` files by `npm run settings:catalog`; do not edit by hand.
Direction: `tighten-only` keys may only be tightened by a lower level (owner → org → project → pack → user);
`review` keys change only by a reviewed PR to factory.config.json. Guards are never loosened.

| Key | Owner | Changed by | Scope | Direction | Class | Default | What it controls |
|---|---|---|---|---|---|---|---|
| `intake_label` | inbound | runtime | global | free |  |  | Label that takes a forge issue in as a new work item; an open item keeps the label it has. |
| `poll_interval_ms` | inbound | runtime | global | free |  | `30000` | How often the factory polls the forge for new work items and comments. |
