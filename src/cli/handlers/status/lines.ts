
import { reasonWords } from "./reason-words.js";

/** What a line reads of one row of the dashboard's list (`ListRow` in ui/list.ts). */
export interface StatusRow {
  item: { id: string; title: string | null; blocked_reason: string | null };
  label: string;
  /** Why the item waits: a reason code and the values its sentence names (ui/why.ts). */
  why: { reason_code: string; params: Readonly<Record<string, string | number>> };
}

/** What the owner line reads: the dashboard's Needs-you count (needsYouCount) and the text of each system action (systemActions). */
export interface OwnerInput {
  count: number;
  actions: readonly string[];
}

/** The 8 hex characters after `wi_` (as `shortItemId` in core/local-cli.ts, which a feature may not import); any other ID as it is. */
const shortId = (id: string): string => /^wi_([0-9a-f]{8})/.exec(id)?.[1] ?? id;

/** The last line: what needs the owner (the dashboard's Needs you), or that nothing does. Items waiting are counted, the system actions named. */
export function ownerLine({ count, actions }: OwnerInput): string {
  if (count === 0) return "Nothing needs you";
  const items = count - actions.length;
  return `Needs you (${count}): ${[...actions, ...(items > 0 ? [`${items} work ${items === 1 ? "item" : "items"}`] : [])].join(", ")}`;
}

/** One line per item: its short ID, title, the dashboard's state words, and the blocked reason in the dashboard's words when there is one; then the owner line. */
export function statusLines(rows: readonly StatusRow[], owner: OwnerInput): string[] {
  const lines = rows.length === 0 ? ["no work items"] : rows.map(({ item, label, why }) => {
    const reason = item.blocked_reason ? reasonWords(why.reason_code, why.params) : null;
    return `${shortId(item.id)}  ${item.title || "(no title)"}  ${reason ? `${label}: ${reason}` : label}`;
  });
  return [...lines, ownerLine(owner)];
}
