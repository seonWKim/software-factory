
/** What a line reads of one row of the dashboard's list (`ListRow` in ui/list.ts). */
export interface StatusRow {
  item: { id: string; title: string | null; blocked_reason: string | null };
  label: string;
}

/** The 8 hex characters after `wi_` (as `shortItemId` in core/local-cli.ts, which a feature may not import); any other ID as it is. */
const shortId = (id: string): string => /^wi_([0-9a-f]{8})/.exec(id)?.[1] ?? id;

/** One line per item: its short ID, title, the dashboard's state words, and the blocked reason in words when there is one. */
export function statusLines(rows: readonly StatusRow[]): string[] {
  if (rows.length === 0) return ["no work items"];
  return rows.map(({ item, label }) => {
    const reason = item.blocked_reason?.replaceAll("_", " ");
    return `${shortId(item.id)}  ${item.title || "(no title)"}  ${reason ? `${label}: ${reason}` : label}`;
  });
}
