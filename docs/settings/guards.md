# Settings catalog: guards

The settings that `src/guards/` reads; the index is [docs/settings.md](../settings.md).
Generated from the `*.setting.ts` files by `npm run settings:catalog`; do not edit by hand.
Direction: `tighten-only` keys may only be tightened by a lower level (owner → org → project → pack → user);
`review` keys change only by a reviewed PR to factory.config.json. Guards are never loosened.

| Key | Owner | Changed by | Scope | Direction | Class | Default | What it controls |
|---|---|---|---|---|---|---|---|
| `broker` | guards | review | global | tighten-only | guard |  | Which tool broker runs the forge actions agents ask for, such as a push. |
| `deny_paths` | guards | review | global | tighten-only | guard |  | Absolute paths that agent runs may never read. |
| `egress` | guards | review | global | tighten-only | guard |  | Which scanner checks outgoing text and withholds what looks like a secret. |
| `secrets` | guards | review | global | tighten-only | guard |  | Which secret store tools read credentials from; agents never see them. |
