// What each store table State declares holds, one line each: the migration bookkeeping, the extension packs, the chat messages, the chat spend and the chat turns.
// `legacy_` copies get no line: no code reads them, and the contract migration drops them (design 10-event-driven).
// Read by the Data page (src/ui/data.ts, design 09-dashboard-app); checked by tests/data-table-docs.test.ts.

export const TABLE_DOCS: Readonly<Record<string, string>> = {
  schema_migrations: "The numbered baseline schema steps applied to this store.",
  ext_packs_entries: "Extension pack tools and MCP servers, with their approval status; an imported MCP server is a pointer to its source file, never a copy.",
  ext_packs_approvals: "Every approval or refusal of an extension pack, by whom and when.",
  ext_skill_refs: "Skills and commands imported from Claude Code and Codex, one per source and path: kind, name, path and SHA-256, never the text.",
  ext_mcp_tool_lists: "Tool names of approved imported MCP servers, listed once per description by a worker; never descriptions or error text.",
  controller_chat_messages: "Every message of a chat session, one per session and seq: its role, text, the tool calls it asked for (JSON) and the tool call a tool result answers.",
  controller_chat_spend: "The spend of every chat turn and coordinator cycle, one per turn id, with its session and kind (chat or coordinator): its UTC day, its known cost in dollars (empty when unknown) and its tokens.",
  controller_chat_turns: "Every chat turn the dashboard sent, one per turn id, with its session: running at its start, then answered, refused or failed, the reason when refused or failed, and when it started and ended.",
  ext_skill_versions: "Every version of an imported skill, one per changed folder hash: the skill folder's hash, its full SKILL.md text, its source and when the import saw it.",
};
