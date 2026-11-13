// What each store table Identity declares holds, one line each, and what a column means where its name does not
// say (key `table.column`). Read by the Data page (src/ui/data.ts, design 09-dashboard-app); checked by
// tests/data-table-docs.test.ts.

export const TABLE_DOCS: Readonly<Record<string, string>> = {
  authz_audit: "Every authorization decision: who asked for which action on what, and the answer.",
  identity_link_codes: "One-time codes that link a chat or forge account to a factory user; only a hash of each is kept.",
  identity_owner: "The factory's one owner: the user id that claimed it, and when.",
  identity_passports: "Passports (signed identity chains) issued to processes and users; only a hash of each token is kept.",
  identity_profiles: "Display names by user id, only to show on pages.",
  identity_revocations: "Passports revoked before they expire, and why.",
  identity_user_links: "Which account at which provider is which factory user.",
};
