# Settings catalog: runtime

The settings that `src/runtime/` reads; the index is [docs/settings.md](../settings.md).
Generated from the `*.setting.ts` files by `npm run settings:catalog`; do not edit by hand.
Direction: `tighten-only` keys may only be tightened by a lower level (owner → org → project → pack → user);
`review` keys change only by a reviewed PR to factory.config.json. Guards are never loosened.

| Key | Owner | Changed by | Scope | Direction | Class | Default | What it controls |
|---|---|---|---|---|---|---|---|
| `calendar` | runtime | runtime | global | free |  | `[]` | Calendar plugins the factory reads, in order, over the calendar key in factory.config.json. |
| `env` | runtime | review | global | free |  |  | Whether the factory runs locally or in the cloud. |
| `hooks` | runtime | review | global | tighten-only |  | `[]` | Hook names the owner enabled; a hook runs only when listed here. Empty: no hook runs. |
| `integrations` | runtime | runtime | global | free |  | `{}` | Which plugin each integration uses, over the plugins key in factory.config.json. |
| `plugins` | runtime | review | global | free |  |  | Which named implementation the factory uses for each interface. |
| `repo` | runtime | review | global | free |  |  | The repository the factory works on, its base branch and its install and test commands. |
| `tasks_add_key` | runtime | runtime | global | free |  | `"enter"` | Which key adds a task from the Tasks page quick-add field: enter or cmd-enter. |
| `tick_ms` | runtime | runtime | global | free |  | `2000` | How often the controller and the worker pool run their loop. |
| `tool_grants` | runtime | runtime | global | tighten-only |  | `{}` | Which read-only tools each role (run kind) may call; a role with no entry gets none. |
