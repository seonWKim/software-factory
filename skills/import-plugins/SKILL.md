---
name: import-plugins
description: Import the skills, commands and MCP servers Claude Code and Codex use into the factory with `factory plugins import`, as pointers.
---

# Import plugins from Claude Code and Codex

Use `factory plugins import` to make the factory see the skills, slash commands and MCP servers that Claude Code and
Codex use on this machine. Every item is stored as a pointer to the file it was found in, never a copy: a skill or
command as its path and SHA-256, an MCP server as its file, its key there and the SHA-256 of its allow-listed
descriptor. The factory reads the file again whenever it uses or shows the item.

## Sources

Each item carries its source label. A missing file or folder means that source holds nothing; it is not an error.

- `claude`: `~/.claude.json` (its top-level `mcpServers`) and `~/.claude/skills/<name>/SKILL.md`.
- `claude-command`: `~/.claude/commands/*.md`, stored as kind `command`.
- `claude-plugin:<name>`: each Claude Code plugin `~/.claude/settings.json` `enabledPlugins` turns on, at the install
  path `~/.claude/plugins/installed_plugins.json` gives it: its `skills/*/SKILL.md` and `.mcp.json`. A disabled plugin,
  or one only in the plugin cache, is not imported.
- `codex`: `~/.codex/config.toml` (its `[mcp_servers.<name>]` tables) and `~/.codex/skills/<name>/SKILL.md`.
- `project:<repo>`: the managed repo's `.mcp.json` and `.claude/skills/<name>/SKILL.md`.
- `claude-desktop`: `~/Library/Application Support/Claude/claude_desktop_config.json` `mcpServers` (macOS path only).
- `folder:<folder name>`: only with `--from <path>`, a folder laid out like a plugin: `skills/<name>/SKILL.md`,
  `commands/*.md` and `.mcp.json`.

## Commands

- `factory plugins import --dry-run`: lists each item it finds as `found <kind> <name> from <source>` and writes
  nothing (no store row, no file, no state folder). Run this first.
- `factory plugins import`: stores what it finds, as pointers. An MCP server becomes a `pending` entry: its env and
  header key names are in the hashed descriptor, never a value, and no command, args or URL is copied. A skill or
  command becomes a reference: its source, kind, name, path and the SHA-256 of the file, never its text.
- Run it again after a change: an edited file updates its row (`updated skill <name>`), an unchanged one prints
  `already added …`. A changed MCP server is pending again and needs a new approval.

## Flags

- `--kind skill|command|mcp_server|all`: only that kind. Default `all`.
- `--source claude|claude-command|claude-plugin|codex|project|claude-desktop`: only that source. Default all.
- `--from <path>`: scan only that folder, under the label `folder:<folder name>`.

Each takes `--flag value` or `--flag=value`. An unknown flag or value prints the usage and exits 1.

## What to expect

- The import never writes to a scanned file or folder.
- A config that does not parse stops that source with one error naming the file, stores nothing from it, and the
  command exits 1. The error never quotes the file.
- An MCP server that fails the pack scans (egress, credential leak, tool poisoning) is printed as `refused …` with the
  rules and is not stored; the command exits 1.
- Two sources with the same MCP server key: the later one is named `<key>@<source>`.
- An MCP server whose entry leaves its file shows as `missing`, and nothing runs it.
- Nothing is started, approved or granted. An imported MCP server stays `pending` until the owner runs
  `factory pack approve mcp_server <name>`.

Never copy an env value or a secret from these configs into a prompt, a log, a comment or a file. Report env keys
by name only.
