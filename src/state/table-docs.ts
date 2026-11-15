// What each store table State declares holds, one line each: the migration bookkeeping and the extension packs.
// `legacy_` copies get no line: no code reads them, and the contract migration drops them (design 10-event-driven).
// Read by the Data page (src/ui/data.ts, design 09-dashboard-app); checked by tests/data-table-docs.test.ts.

export const TABLE_DOCS: Readonly<Record<string, string>> = {
  schema_migrations: "The numbered baseline schema steps applied to this store.",
  ext_packs_entries: "Extension packs (tools and skills) added to the factory, with their approval status.",
  ext_packs_approvals: "Every approval or refusal of an extension pack, by whom and when.",
  ext_skill_refs: "Skills found in the user-level Claude Code and Codex configs: source, name, path and SHA-256, never the text.",
};
