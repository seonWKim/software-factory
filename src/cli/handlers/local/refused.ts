/** A stored thread entry, as the store lists it (`listItemMessages`). */
type Message = { seq: number; created_at: string; marker: string; body: string };

/** The marker the controller puts on its reply to a refused command, from any origin (CLI, dashboard, Slack, GitHub). */
const REFUSED_MARKER = "<!-- factory:refused:";

/** The section `factory task show` ends with. */
export const LAST_REFUSED = "Last refused command";

/**
 * `factory task show`'s last section (design 04-gate-commands, 2026-11-13): the item's latest refused command with its
 * reason, read from the refusal the controller stored in the item's thread; `(none)` when no command was refused.
 */
export function lastRefusedLines(messages: readonly Message[]): string[] {
  const last = messages.filter((m) => m.marker.startsWith(REFUSED_MARKER)).at(-1);
  if (!last) return ["", LAST_REFUSED, "  (none)"];
  return ["", LAST_REFUSED, `  [${last.seq}] ${last.created_at}`, ...last.body.split("\n").map((l) => `    ${l}`)];
}

/** The line after a stored item command: where its refusal shows, since the controller decides later. */
export function refusalHint(id: string): string {
  return `if the controller refuses it, \`factory task show ${id}\` lists the reason under "${LAST_REFUSED}"`;
}
