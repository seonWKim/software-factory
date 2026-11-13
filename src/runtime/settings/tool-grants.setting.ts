// Design 08-settings (2026-11-13, Capabilities): the per-role tool grants change at runtime (`factory settings set
// tool_grants <json>`, or the Settings page). Tighten-only: a grant a role did not have is a loosening, so it needs
// approve_merge (the 2026-11-09 rule); removing a grant needs none. The worker reads the grants in force at its claim.

import { defineSetting } from "../../shared/setting.js";

/** Each `run kind → tool` pair a grant map gives. */
function pairs(v: unknown): string[] {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([kind, names]) => (Array.isArray(names) ? names.map((n) => `${kind} → ${String(n)}`) : []));
}

export default defineSetting({
  key: "tool_grants",
  owner: "runtime",
  type: "object",
  default: {},
  description: "Which read-only tools each role (run kind) may call; a role with no entry gets none.",
  applies: "the next run that starts",
  direction: "tighten-only",
  // Fewer grants is tighter: a value that grants a pair the value above it does not is looser.
  tighter: (value, than) => {
    const above = new Set(pairs(than));
    const added = pairs(value).find((p) => !above.has(p));
    return added === undefined ? null : `tool_grants grants ${added}, which the value in force does not`;
  },
  changed_by: "runtime",
  scope: "global",
});
