# Settings catalog

Generated from the `*.setting.ts` files by `npm run settings:catalog`; do not edit by hand.
Direction: `tighten-only` keys may only be tightened by a lower level (owner → org → project → pack → user);
`review` keys change only by a reviewed PR to factory.config.json. Guards are never loosened.

One page per owner component, with a row per setting that component reads:

- [controller](settings/controller.md)
- [guards](settings/guards.md)
- [inbound](settings/inbound.md)
- [outbound](settings/outbound.md)
- [runtime](settings/runtime.md)
- [state](settings/state.md)
- [worker](settings/worker.md)
