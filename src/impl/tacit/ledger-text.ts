// The owner's CLIs print text, not JSON (checked 2026-11-12): these read the two texts the agents-home plugin needs.
// `evolve pending` lists what waits for a verdict; `<home>/private/tacit/rules.md` holds the promoted rules.

import type { TacitPendingEntry, TacitRule } from "../../interfaces/tacit-ledger.js";

/** `## proposals (open) 1`, `## proposals (held) 0`, `## tacit Pending 1`, `## tacit Held 0`: the state word. */
const PENDING_HEADING = /^##\s+(?:proposals\s+\((open|held)\)|tacit\s+(pending|held))(?:\s|$)/i;
/** `- P-0007 [spec] src/core/foo.ts — Keep the flag`: the ID and the title after the dash. */
const PROPOSAL_ROW = /^-\s+(P-\S+)\s.*?\s—\s+(.+)$/;
/** `- C-012 keep existing CLI flags`: the ID and the title. */
const CLASS_ROW = /^-\s+(C-\S+)\s+(.+)$/;

/**
 * `evolve pending` as entries: each proposal row under `## proposals (open|held)` and each class row under
 * `## tacit Pending|Held`, with the heading's word (lower case) as its state. Rows under any other heading are skipped.
 */
export function parsePending(text: string): TacitPendingEntry[] {
  const out: TacitPendingEntry[] = [];
  let section: { row: RegExp; state: string } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      const h = PENDING_HEADING.exec(line);
      section = h === null ? null : h[1] !== undefined ? { row: PROPOSAL_ROW, state: h[1].toLowerCase() } : { row: CLASS_ROW, state: h[2]!.toLowerCase() };
      continue;
    }
    const m = section?.row.exec(line);
    if (section && m) out.push({ id: m[1]!, title: m[2]!.trim(), state: section.state });
  }
  return out;
}

/** `## C-012 keep existing CLI flags`: one promoted rule's section. */
const RULE_HEADING = /^##\s+(C-\S+)\s*(.*)$/;
/** `- 기본값: …`, `- 예외: …`, `- 범위: …`: a field line; the value follows the first colon. */
const RULE_FIELD = /^-\s*(기본값|예외|범위)(.*)$/;
const FIELD_KEY = { 기본값: "default", 예외: "exceptions", 범위: "scope" } as const;

/**
 * The rules file as rules: each `## C-xxx <name>` section gives its `기본값`, `예외` and `범위` values as written.
 * An indented line under a field continues it on a new line; any other line is skipped.
 */
export function parseRules(text: string): TacitRule[] {
  const out: TacitRule[] = [];
  let rule: { -readonly [K in keyof TacitRule]: TacitRule[K] } | null = null;
  let field: (typeof FIELD_KEY)[keyof typeof FIELD_KEY] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      field = null;
      if (!line.startsWith("## ")) continue;
      const h = RULE_HEADING.exec(line);
      rule = h ? { id: h[1]!, name: h[2]!.trim(), default: "", exceptions: "", scope: "" } : null;
      if (rule) out.push(rule);
      continue;
    }
    if (rule === null) continue;
    const f = RULE_FIELD.exec(line);
    if (f) {
      const rest = f[2]!;
      const colon = rest.search(/[:：]/);
      field = FIELD_KEY[f[1] as keyof typeof FIELD_KEY];
      rule[field] = (colon < 0 ? rest : rest.slice(colon + 1)).trim();
    } else if (field !== null && line !== "" && /^\s/.test(raw)) {
      rule[field] = rule[field] === "" ? line : `${rule[field]}\n${line}`;
    } else {
      field = null;
    }
  }
  return out;
}
