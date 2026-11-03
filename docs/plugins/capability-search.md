# CapabilitySearch

What it does: finds docs, skills, tools and MCP servers for a task (design §7, progressive disclosure). `build()` creates the selected plugin and passes it to the worker. For triage the worker searches with the work item's problem; for implement and review, with the problem plus the done criteria. The top 8 results are appended to the agent's prompt as a `## Available docs (index)` section, one line each: path, name and snippet. Agents read the full text of a path with the `Read` tool they already have. No results means no section, so the prompt is exactly as without a search. A failed search logs a warning and the run goes on without an index.

Finding a doc is not permission: the index changes nothing about tools, `deny_paths`, writable paths or tool grants. An agent can Read a listed path only where it could already read it.

Plugins:

- `list-all`: `ListAllCapabilitySearch`. Returns the first N entries of a list of capabilities.
  - Enable: `"plugins": { "capability": "list-all", ... }` (the checked-in default). Secrets: none.
  - **Not wired in yet:** nothing fills its list (`build()` passes an empty one), so it always returns nothing and agents get no index section. Prompts are the same as before the index existed.
- `bm25`: `Bm25CapabilitySearch` (`src/impl/capability/bm25-capability-search.ts`). BM25 ranking over the repo's markdown.
  - Indexes: `*.md` files under `docs/` and `skills/` below the code root (the runtime copy under the `git-worktree` updater). Skipped: `prompts/` (already the system prompt), `node_modules/`, dot-directories, symlinks, and anything outside those two roots. A file under `skills/` has kind `skill`; the rest have kind `doc`. The id is the repo-relative path.
  - Each entry keeps the name (first `#` heading, else the file name), the other headings, the first paragraph after the title and the full body. Tokens are lowercased runs of letters and digits. A term in the name or a heading counts 3 times (a fixed boost), so a heading match ranks above the same term in body text only.
  - Snippet: the first paragraph after the title on one line, at most 200 characters, ending in `…` when cut.
  - Index size in the prompt: 8 results (fixed).
  - Rebuild: the index is built at startup, and every search rebuilds it when an indexed file's mtime or size changes or a file is added or removed. It is a per-process cache of the files; nothing is stored or shared, so replicas need no coordination.
  - Enable: `"plugins": { "capability": "bm25", ... }`. Secrets: none.

Switch with the `plugins.capability` key:

```jsonc
// factory.config.json: turn the doc index on
"plugins": { ..., "capability": "bm25" }
```

Switch back / disable: `"capability": "list-all"` (or leave the key out: `list-all` is the default). Agents then get no index section again.

## History

No earlier decision is recorded for this topic.
