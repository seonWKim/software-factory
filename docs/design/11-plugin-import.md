# 11. Plugin import: skills and MCP servers from Claude Code and Codex user configs

- **`factory plugins import` finds the skills and MCP servers in the user-level Claude Code and Codex configs and stores them as skill references and pending pack entries, with no env value anywhere (new decision, 2026-11-15, phase 1 of 3 of local-84b269e4-38be-439c-983e-10f9675881fa).** Before, the factory could not see the skills and MCP servers a user keeps in those configs. CLI only in this phase: no dashboard change.
  - **Command.** `factory plugins import [--dry-run] [--kind skill|mcp_server|all] [--from claude|codex]` (`src/cli/handlers/plugins/plugins.command.ts`). `--kind` defaults to `all`, `--from` to both sources; each limits the scan to its kind or source. `--kind=x` and `--kind x` both work. An unknown flag or value prints the usage and exits 1.
  - **What is read** (`src/import/scan.ts`, reads only), under the OS home folder:
    - Claude Code: `~/.claude.json`, its top-level `mcpServers` (user scope only; the `projects` entries and project `.mcp.json` files are not read), and `~/.claude/skills/<name>/SKILL.md`.
    - Codex: `~/.codex/config.toml`, its `[mcp_servers.<name>]` tables, and `~/.codex/skills/<name>/SKILL.md`. The TOML is read by a small reader in `src/import/toml.ts` (no new dependency).
  - **No env value leaves the scanner.** An MCP server's stored descriptor is built from an allow-list: `name`, `description` ("Imported from the … user config"), `source`, and, when present, `type`, `command`, `args` (a list of strings) and `url` with its user, password, query and fragment removed. `env_keys` holds the key names of `env`, and Codex's `env_vars` and `bearer_token_env_var` names; `header_keys` holds the key names of `headers`, `http_headers` and `env_http_headers`. Every other field is dropped. A parse error names the file, and the TOML line number, never the text there.
  - **Dry run.** `--dry-run` prints one `found <kind> <name> from <source>` line per item and `dry run: N found, nothing stored`. It never loads the config's store: no store row, no file and no state folder is written.
  - **MCP servers** go through the three scans `factory pack add` runs (`scanDescriptor`, 11-packs.md), then `PackEntriesStore.insert` as a `pending` `ext_packs_entries` row of kind `mcp_server`, `credential_name` null, `module_hash` null, `description_hash` the descriptor-only hash. A refused server is named with its rules and not stored; the command then exits 1.
  - **Skills** go to `ext_skill_refs` (migration `src/state/migrations/20261115T1200-state-ext-skill-refs`, additive): `id`, `source` (`claude` | `codex`), `name` (the folder name), `path` (the absolute SKILL.md path), `sha256` (of the file's bytes), `added_by`, `created_at`, unique on (`source`, `path`, `sha256`). The file's text is never stored. A changed file is a new row.
  - **Idempotent.** Both inserts skip a row already stored (the ID follows from the unique key), so a second run prints `already added …` for each item and stores nothing new; a second worker makes the same rows.
  - **Missing or malformed configs.** A missing config file finds no MCP servers from that source and exits 0. A config that does not parse stops its whole source (its skills too) with one error line naming the file; nothing from that source is stored, the other source still runs, and the command exits 1.
  - **added_by:** the CLI identity (`cli_user`, else git `user.email`, else the OS user, else `anonymous`), as `factory pack add`.
  - **Nothing is started, approved or granted** in this phase: each imported MCP server stays `pending` until the owner runs `factory pack approve`.
  - **Owner answers (binding, kept verbatim):**
    1. Imported MCP servers that name env keys: may the factory pass the referenced secret values to the server process? Answer: keep not_started until a later change (the default, accepted).
    2. Where are imported skill references stored? Answer: a new store table ext_skill_refs (the default, accepted).
    3. Does the Tools tab start an approved imported MCP server to list its tools? Answer: yes, once in the worker with an empty env (the default, accepted).
    The answers to 1 and 3 apply to later phases.
  - **Architecture ratchet.** The command imports `src/import/` (a legacy folder), which adds two `component-imports-legacy` lines for `cli/handlers/plugins/plugins.command.ts` to `tests/architecture/known-violations/dependency-direction.json`; that change needs the owner's merge.
  - **Not done:** `args` are stored as found, so a secret written into an argument (not into `env`) is caught only by the egress and credential-leak scans; the dashboard; listing or using the imported skill references.
  - Tests: `tests/import-plugins.test.ts` (dry run, idempotency, the sentinel env value in both formats, the skill reference, the filters, missing and malformed configs, the TOML reader).

## History

- **New topic file** (2026-11-15). No earlier decision: the factory did not read Claude Code or Codex configs.
