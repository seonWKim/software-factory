// The owner's CLIs print text, not JSON (checked 2026-11-12): these read the three texts the agents-home plugin needs.
// `evolve pending` lists what waits for a verdict; `evolve show <id>` gives one entry's detail (its form is assumed,
// docs/plugins/tacit-ledger.md); `<home>/private/tacit/rules.md` holds the promoted rules.

import type { TacitEntryDetail, TacitPendingEntry, TacitRule } from "../../interfaces/tacit-ledger.js";

/** `## proposals (open) 1`, `## proposals (held) 0`, `## tacit Pending 1`, `## tacit Held 0`: the state word. */
const PENDING_HEADING = /^##\s+(?:proposals\s+\((open|held)\)|tacit\s+(pending|held))(?:\s|$)/i;
/** `- P-0007 [edit-asset] prompts/review.md — Keep the flag`: the ID, the kind, the target and the title after the dash. */
const PROPOSAL_ROW = /^-\s+(P-\S+)\s+(?:\[([^\]]*)\]\s*)?(.*?)\s*—\s+(.+)$/;
/** `- C-012 keep existing CLI flags`: the ID and the title. */
const CLASS_ROW = /^-\s+(C-\S+)\s+(.+)$/;

/**
 * `evolve pending` as entries: each proposal row under `## proposals (open|held)` and each class row under
 * `## tacit Pending|Held`, with the heading's word (lower case) as its state. A proposal keeps its kind and target
 * when the row has them. Rows under any other heading are skipped.
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
    if (!section || !m) continue;
    if (section.row === CLASS_ROW) {
      out.push({ id: m[1]!, title: m[2]!.trim(), state: section.state });
      continue;
    }
    const [kind, target] = [m[2]?.trim(), m[3]!.trim()];
    out.push({ id: m[1]!, title: m[4]!.trim(), state: section.state, ...(kind ? { kind } : {}), ...(target ? { target } : {}) });
  }
  return out;
}

/** `## C-012 keep existing CLI flags`: one promoted rule's section. */
const RULE_HEADING = /^##\s+(C-\S+)\s*(.*)$/;
/** `- 기본값: …`, `- 예외: …`, `- 범위: …`: a field line; the value follows the first colon. */
const RULE_FIELD = /^-\s*(기본값|예외|범위)(.*)$/;
const FIELD_KEY = { 기본값: "default", 예외: "exceptions", 범위: "scope" } as const;

/** A field line's value: what follows its first colon (ASCII or full width), else the whole rest, trimmed. */
function afterColon(rest: string): string {
  const colon = rest.search(/[:：]/);
  return (colon < 0 ? rest : rest.slice(colon + 1)).trim();
}

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
      field = FIELD_KEY[f[1] as keyof typeof FIELD_KEY];
      rule[field] = afterColon(f[2]!);
    } else if (field !== null && line !== "" && /^\s/.test(raw)) {
      rule[field] = rule[field] === "" ? line : `${rule[field]}\n${line}`;
    } else {
      field = null;
    }
  }
  return out;
}

/** `- 기본값: …`, `근본 원인: …`, `kind: …`: a detail field line, with or without the list dash; the value follows the colon. */
const SHOW_FIELD = /^(?:-\s*)?(기본값|default|예외|exceptions?|범위|scope|근본\s*원인|root[ _]reason|kind|target)\s*[:：](.*)$/i;
const SHOW_KEY: Record<string, "default" | "exceptions" | "scope" | "root_reason" | "kind" | "target"> = {
  기본값: "default", default: "default", 예외: "exceptions", exception: "exceptions", exceptions: "exceptions", 범위: "scope", scope: "scope",
  "근본 원인": "root_reason", 근본원인: "root_reason", "root reason": "root_reason", kind: "kind", target: "target",
};
/** `## incidents 3`: the incidents' heading, with how many came up. */
const INCIDENTS_HEADING = /^#{1,4}\s+incidents?\b(?:\s*\(?(\d+)\)?)?/i;
/** `- wi_12 — "keep the flag"`: the owner's words after an incident row's dash. */
const INCIDENT_WORDS = /\s—\s+(.+)$/;

/** `"words"` or `“words”` as `words`. */
function unquote(s: string): string {
  const m = /^["“'‘](.*)["”'’]$/.exec(s.trim());
  return (m ? m[1]! : s).trim();
}

/**
 * `evolve show <id>` as the entry's detail. Field lines (`기본값`, `예외`, `범위`, `근본 원인`, or `default`,
 * `exceptions`, `scope`, `root reason`, `kind`, `target`) give their value; an indented line under one continues it.
 * Each `- ` row under an `## incidents <n>` heading is one incident, its quoted words after the dash; the count is the
 * heading's number, else the rows. A field the text lacks is absent; an empty text is null.
 */
export function parseShow(id: string, text: string): TacitEntryDetail | null {
  if (text.trim() === "") return null;
  const fields: Partial<Record<(typeof SHOW_KEY)[string], string>> = {};
  let field: (typeof SHOW_KEY)[string] | null = null;
  let incidents: { count: number | null; rows: number; quotes: string[] } | null = null;
  let inIncidents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      field = null;
      const h = INCIDENTS_HEADING.exec(line);
      inIncidents = h !== null;
      if (h) incidents = { count: h[1] === undefined ? null : Number(h[1]), rows: 0, quotes: [] };
      continue;
    }
    const f = SHOW_FIELD.exec(line);
    if (f) {
      field = SHOW_KEY[f[1]!.toLowerCase().replace(/[\s_]+/g, " ")] ?? null;
      if (field) fields[field] = f[2]!.trim();
      continue;
    }
    if (field !== null && line !== "" && /^\s/.test(raw)) {
      fields[field] = fields[field] ? `${fields[field]}\n${line}` : line;
      continue;
    }
    field = null;
    if (!inIncidents || incidents === null || !line.startsWith("- ")) continue;
    // A row's words are what follows its dash, else the row itself when it is quoted; a bare reference has none.
    incidents.rows++;
    const rest = line.slice(2).trim();
    const words = INCIDENT_WORDS.exec(rest)?.[1] ?? (/^["“]/.test(rest) ? rest : "");
    if (unquote(words) !== "") incidents.quotes.push(unquote(words));
  }
  const out: { -readonly [K in keyof TacitEntryDetail]: TacitEntryDetail[K] } = { id };
  for (const [k, v] of Object.entries(fields) as [keyof typeof fields, string][]) if (v !== "") out[k] = v;
  if (incidents) {
    out.incidents = incidents.count ?? incidents.rows;
    if (incidents.quotes.length > 0) out.quotes = incidents.quotes;
  }
  return out;
}
