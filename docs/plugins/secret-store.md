# SecretStore

What it does: guard **G1**. Loads secrets in the worker/controller process only and hands out opaque values; it also gives the egress scanner the values to look for. Agents never get it.

Plugins:

- `env-file`: `EnvFileSecretStore`. Reads `${XDG_CONFIG_HOME:-~/.config}/software-factory/.env` (or `SOFTWARE_FACTORY_SECRETS_FILE`), lazily. It reads the file again, at most once per 5 s (`RELOAD_MS`), when a declared name has no value or the last read failed, so a credential added with `npm run setup` while the factory runs is found with no restart (decision changed 2026-11-21, design 05-restart-pauses.md). Every value any read loaded stays in `valuesForScan`.
  - Enable: `"plugins": { "secrets": "env-file", ... }`, or no `plugins` object.
  - Loads only the names the selected plugins declare (see "Declared secrets" in [selection.md](selection.md)); every other key in the file is ignored.
  - Secrets: none of its own; it holds the ones the other selected plugins declare (`docs/setup.md`). Settings: none.

Switch back: `"secrets": "env-file"`.

Why it cannot be disabled: without a `SecretStore` nothing keeps credentials out of the agent's environment (G1), and the egress scanner has no secret values to look for (G5). Architecture §5 layers G1–G6 so that one failure is not a leak; removing a layer breaks that. Config that selects no `SecretStore` fails at startup.

## History

- **Read once per process** (until 2026-11-21). Before: the file was read once, on first use; a value added later, or a file created later, was seen only after a restart.
