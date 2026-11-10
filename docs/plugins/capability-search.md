# CapabilitySearch

What it does: finds docs, skills, tools and MCP servers for a task (design §7, progressive disclosure). `build()` creates the selected plugin and passes it to the worker. For triage the worker searches with the work item's problem; for implement, review and resolve, with the problem plus the done criteria. The top 8 results are appended to the agent's prompt as a `## Available docs (index)` section, one line each: path, name and snippet.

Before the index, every prompt (triage, implement, review, resolve) gets the packs' rules and learnings (since 2026-11-11, issue #490; design 07-self-improvement.md): each layer's `rules/*.md` in full and its `learnings.md` entries without a `status: retired` line, at most 8000 characters together, best effort. This is not a plugin: it runs whichever capability plugin is selected. Agents read the full text of a path with the `Read` tool they already have. No results means no section, so the prompt is exactly as without a search. A failed search logs a warning and the run goes on without an index.

Finding a doc is not permission: the index changes nothing about tools, `deny_paths`, writable paths or tool grants. An agent can Read a listed path only where it could already read it.

Plugins:

- `list-all`: `ListAllCapabilitySearch`. Returns the first N entries of a list of capabilities.
  - Enable: `"plugins": { "capability": "list-all", ... }` (the fallback: also what you get when the key is left out). Secrets: none.
  - **Not wired in yet:** nothing fills its list (`build()` passes an empty one), so it always returns nothing and agents get no index section. Prompts are the same as before the index existed.
- `bm25`: `Bm25CapabilitySearch` (`src/impl/capability/bm25-capability-search.ts`). BM25 ranking over the repo's markdown.
  - Indexes: `*.md` files under `docs/` and `skills/` below the code root (the runtime copy under the `git-worktree` updater), and under every other pack layer's `skills/` (design 11-packs.md; id: the absolute path). Skipped: `prompts/` (already the system prompt), `node_modules/`, dot-directories, symlinks, every `learnings.md` (learnings reach a prompt only through the rules and learnings section, which leaves retired entries out), and anything outside those roots. A file under `skills/` has kind `skill`; the rest have kind `doc`. The id is the repo-relative path.
  - Each entry keeps the name (YAML frontmatter `name`, else the first `#` heading, else the file name), the other headings, the first paragraph after the title and the full body. An Agent Skills `skills/<name>/SKILL.md` names itself in its frontmatter; other frontmatter fields are ignored. Tokens are lowercased runs of letters and digits. A term in the name or a heading counts 3 times (a fixed boost), so a heading match ranks above the same term in body text only.
  - Snippet: the frontmatter `description` (its terms count as body text), else the first paragraph after the title, on one line, at most 200 characters, ending in `…` when cut.
  - Index size in the prompt: 8 results (fixed).
  - Rebuild: the index is built at startup, and every search rebuilds it when an indexed file's mtime or size changes or a file is added or removed. It is a per-process cache of the files; nothing is stored or shared, so replicas need no coordination.
  - Enable: `"plugins": { "capability": "bm25", ... }` (the checked-in default). Secrets: none.

The checked-in `factory.config.json` selects `bm25` (since 2026-11-07), so every agent prompt gets the doc index. Solo and enterprise get the same default: each process builds the index from its own checkout and shares nothing.

Switch with the `plugins.capability` key:

```jsonc
// factory.config.json: the checked-in default, the doc index on
"plugins": { ..., "capability": "bm25" }
```

Switch back / disable: `"capability": "list-all"` (or leave the key out: `list-all` is the registry default for a config without it). Agents then get no index section again.

## History

- 2026-11-11 (issue #490): before, the `bm25` index read only the code root's `docs/` and `skills/` (pack layers' skills were not passed to it), indexed `learnings.md` like any doc, and named a skill by its first `#` heading; no rules or learnings reached a prompt.
- 2026-11-07: the checked-in default changed from `list-all` (no doc index in any prompt) to `bm25`; `list-all` stays as the fallback.
