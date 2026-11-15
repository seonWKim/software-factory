---
name: import-plugins
description: Import the skills and MCP servers from the user-level Claude Code and Codex configs into the factory with `factory plugins import`.
---

# Import plugins from Claude Code and Codex

Use `factory plugins import` to make the factory see the skills and MCP servers a user keeps in their user-level
Claude Code and Codex configs. It reads only these files under the home folder:

- Claude Code: `~/.claude.json` (its top-level `mcpServers`) and `~/.claude/skills/<name>/SKILL.md`.
- Codex: `~/.codex/config.toml` (its `[mcp_servers.<name>]` tables) and `~/.codex/skills/<name>/SKILL.md`.

Project-level `.mcp.json` files are not read.

## Commands

- `factory plugins import --dry-run`: lists each item it finds as `found <kind> <name> from <source>` and writes
  nothing (no store row, no file, no state folder). Run this first.
- `factory plugins import`: stores what it finds. Each MCP server becomes a `pending` pack entry of kind `mcp_server`
  with its env key names only, never an env value. Each skill becomes a reference: its source, name, path and the
  SHA-256 of the file, never its text. A second run prints `already added …` and stores nothing new.

## Flags

- `--kind skill|mcp_server|all`: only that kind. Default `all`.
- `--from claude|codex`: only that source. Default both.

Both take `--flag value` or `--flag=value`. An unknown flag or value prints the usage and exits 1.

## What to expect

- A missing config file finds nothing from it; the command still exits 0.
- A config that does not parse stops that source with one error naming the file, stores nothing from it, and the
  command exits 1. The error never quotes the file.
- An MCP server that fails the pack scans (egress, credential leak, tool poisoning) is printed as `refused …` with the
  rules and is not stored; the command exits 1.
- Nothing is started, approved or granted. An imported MCP server stays `pending` until the owner runs
  `factory pack approve mcp_server <name>`.

Never copy an env value or a secret from these configs into a prompt, a log, a comment or a file. Report env keys
by name only.
