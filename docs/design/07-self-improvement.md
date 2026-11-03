# 7. Self-improvement

- Behavior changes only through what agents read or may do: all files in the factory-definition repo.
- Additive learnings: automatic. Prompt / gate / permission / tool changes: improver PR with replay evidence → human.
- Recurring failure class → hard fix (gate, permission), not a softer prompt.
- Progressive disclosure: index → body → references; `CapabilitySearch` (BM25, vector, hybrid) finds skills/tools/MCP. Finding ≠ permission.
  - **Doc index in the prompt (new decision, 2026-11-01):** the worker takes an optional `CapabilitySearch` and appends the top 8 results to the triage, implement and review prompts as a short index (path, name, ≤200-character snippet); agents read full text on demand with `Read`, which they already have. The index grants nothing: tools, `deny_paths` and grants are unchanged. BM25 comes first (`bm25` plugin: `*.md` under `docs/` and `skills/`, headings boosted, rebuilt from files when they change, per process); vector and hybrid stay later. `Capability.kind` gains `doc` for markdown docs (`skill` for `skills/`). The default stays `list-all`, which finds nothing, so prompts do not change until config selects `bm25`.

## History

- **Doc index in the prompt** (new decision, 2026-11-01). Before this, no agent received any capability list (`list-all` existed but nothing built it).
