import { shortItemId } from "../../../core/local-cli.js";
import type { ListRow } from "../../../ui/list.js";

/** One line per item: its short ID, title, the dashboard's state words, and the blocked reason in words when there is one. */
export function statusLines(rows: readonly ListRow[]): string[] {
  if (rows.length === 0) return ["no work items"];
  return rows.map(({ item, label }) => {
    const reason = item.blocked_reason?.replaceAll("_", " ");
    return `${shortItemId(item.id)}  ${item.title || "(no title)"}  ${reason ? `${label}: ${reason}` : label}`;
  });
}
