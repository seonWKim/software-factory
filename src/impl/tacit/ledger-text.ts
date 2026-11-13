// The owner's CLIs print text, not JSON (checked 2026-11-12): these read the texts the agents-home plugin needs.
// `evolve pending` lists what waits for a verdict; `evolve show <id>` gives one entry's detail (its form is assumed,
// docs/plugins/tacit-ledger.md) and a class's draft (the owner's sample, 2026-11-13); `<home>/private/tacit/rules.md`
// holds the promoted rules, a promote adds one block to it and a retire removes one.

import type { TacitApplied, TacitAppliedRule, TacitDraft, TacitEntryDetail, TacitPendingEntry, TacitPromotion, TacitRule } from "../../interfaces/tacit-ledger.js";

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

/** `- 근거: 인시던트 T-1, T-2 / 판정일 2026-11-13`: the evidence line of a promoted block. */
const EVIDENCE_LINE = /^-\s*근거\s*[:：]?(.*)$/;
const JUDGED_DATE = /판정일\s*[:：]?\s*(\d{4}-\d{2}-\d{2})/;

/** One `## ` block (not the encoded-elsewhere one) as an applied rule: it parses with a `C-` ID and a `기본값` line, else it is raw. */
function appliedRule(heading: string, body: readonly string[]): TacitAppliedRule {
  const raw = [heading, ...body].join("\n").trim();
  const h = RULE_HEADING.exec(heading);
  const fields: { default?: string; exceptions?: string; scope?: string; incidents?: string[]; judged?: string } = {};
  let field: "default" | "exceptions" | "scope" | null = null;
  for (const l of body) {
    const line = l.trim();
    const f = RULE_FIELD.exec(line);
    const e = EVIDENCE_LINE.exec(line);
    if (f) {
      field = FIELD_KEY[f[1] as keyof typeof FIELD_KEY];
      fields[field] = afterColon(f[2]!);
    } else if (e) {
      field = null;
      const text = e[1]!;
      const incidents = [...text.slice(0, JUDGED_DATE.exec(text)?.index ?? text.length).matchAll(INCIDENT_ID)].map((m) => m[0]);
      if (incidents.length > 0) fields.incidents = incidents;
      const judged = JUDGED_DATE.exec(text)?.[1];
      if (judged !== undefined) fields.judged = judged;
    } else if (field !== null && line !== "" && /^\s/.test(l)) {
      fields[field] = `${fields[field]}\n${line}`;
    } else {
      field = null;
    }
  }
  if (!h || fields.default === undefined) return { raw };
  return { id: h[1]!, name: h[2]!.trim(), ...fields };
}

/**
 * The whole rules file for the Applied group. Each `## ` block up to the next `#` heading is one rule: with a `C-` ID and
 * a `기본값` line it gives its `기본값`, `예외`, `범위` and the T- IDs and `판정일` of its `근거` line (a part it lacks is
 * absent); any other block is kept as raw text. The non-empty lines under `## 다른 곳에 인코딩된 규칙` are `elsewhere`, as
 * written. Lines inside a fenced code block (``` or ~~~) are skipped, so a format template in the file is no rule; an
 * unclosed fence runs to the end of the file.
 */
export function parseApplied(text: string): TacitApplied {
  const rules: TacitAppliedRule[] = [];
  const elsewhere: string[] = [];
  let block: { heading: string; body: string[] } | null = null;
  let inElsewhere = false;
  let fence: string | null = null;
  const flush = () => {
    if (block) rules.push(appliedRule(block.heading, block.body));
    block = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // A fenced block (``` or ~~~, closed by the same mark) is skipped whole; an unclosed one runs to the end.
    const mark = /^(```|~~~)/.exec(line)?.[1];
    if (fence !== null || mark !== undefined) {
      fence = fence === null ? mark! : line.startsWith(fence) ? null : fence;
      continue;
    }
    if (line.startsWith("#")) {
      flush();
      inElsewhere = line === ENCODED_ELSEWHERE_HEADING;
      if (line.startsWith("## ") && !inElsewhere) block = { heading: line, body: [] };
    } else if (inElsewhere) {
      if (line !== "") elsewhere.push(line);
    } else if (block) {
      block.body.push(raw);
    }
  }
  flush();
  return { rules, elsewhere };
}

/** `### C-040 <title>`: the draft's first heading names its class. */
const DRAFT_HEADING = /^###\s+(C-\S+)(?:\s|$)/;
/** `- 인시던트: …`, `- 초안: …`, `- 범위: …`: the draft's lines; the value follows the colon. */
const DRAFT_LINE = /^-\s*(인시던트|초안|범위)\s*[:：]\s*(.*)$/;
/** An incident ID on the `인시던트` line. */
const INCIDENT_ID = /\bT-[0-9A-Za-z_]+/g;
/** Where the 초안 line's default ends and its exception starts. */
const EXCEPTION_SPLIT = " / 예외: ";

/**
 * `evolve show <id>` as a draft: `### <id> <title>`, then `- 인시던트: <T-ids …>`, `- 초안: 기본값: <default> / 예외:
 * <exception>` and `- 범위: <scope>`, before the `# incidents` and `# verdicts` sections. Any part missing (or empty,
 * or a heading naming another class): a string saying which, and no draft.
 */
export function parseDraft(id: string, text: string): TacitDraft | string {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const at = lines.findIndex((l) => DRAFT_HEADING.test(l));
  if (at < 0 || DRAFT_HEADING.exec(lines[at]!)![1] !== id) return `no "### ${id}" heading`;
  const values: Record<string, string> = {};
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith("#")) break;
    const m = DRAFT_LINE.exec(line);
    if (m && values[m[1]!] === undefined) values[m[1]!] = m[2]!.trim();
  }
  const incidents = [...(values["인시던트"] ?? "").matchAll(INCIDENT_ID)].map((m) => m[0]);
  if (incidents.length === 0) return "no incident IDs on a \"- 인시던트:\" line";
  const draft = values["초안"] ?? "";
  const split = draft.indexOf(EXCEPTION_SPLIT);
  if (split < 0) return `no "- 초안:" line with "${EXCEPTION_SPLIT.trim()}"`;
  const dflt = draft.slice(0, split).replace(/^기본값\s*[:：]\s*/, "").trim();
  const exception = draft.slice(split + EXCEPTION_SPLIT.length).trim();
  if (dflt === "" || exception === "") return "an empty default or exception on the \"- 초안:\" line";
  const scope = values["범위"] ?? "";
  if (scope === "") return "no \"- 범위:\" line";
  return { default: dflt, exception, incidents, scope };
}

/** The heading a promoted block goes immediately before, in the owner's rules file. */
export const ENCODED_ELSEWHERE_HEADING = "## 다른 곳에 인코딩된 규칙";

const ENCODED_ELSEWHERE = new RegExp(`^${ENCODED_ELSEWHERE_HEADING}[ \\t]*\\r?$`, "m");

/** Whether `text` has the `## 다른 곳에 인코딩된 규칙` heading a promoted block goes before. */
export function hasEncodedElsewhere(text: string): boolean {
  return ENCODED_ELSEWHERE.test(text);
}

/** One line: a value's line breaks and runs of space become one space, so it cannot start a line of its own. */
const oneLine = (v: string): string => v.replace(/\s+/g, " ").trim();

/** Whether `text` already has a `## <id>` heading. */
export function hasRuleHeading(text: string, id: string): boolean {
  return text.split(/\r?\n/).some((l) => RULE_HEADING.exec(l.trim())?.[1] === id);
}

/**
 * `text` with the promoted block for `id` immediately before the `## 다른 곳에 인코딩된 규칙` heading, followed by a
 * blank line; null when the file has no such heading.
 */
export function withRuleBlock(text: string, id: string, rule: TacitPromotion, draft: TacitDraft, judged: string): string | null {
  const m = ENCODED_ELSEWHERE.exec(text);
  if (m === null) return null;
  const block = [
    `## ${id} ${oneLine(rule.wording)}`,
    `- 기본값: ${oneLine(rule.default)}`,
    `- 예외 (이럴 땐 override): ${oneLine(rule.exception)}`,
    `- 근거: 인시던트 ${draft.incidents.join(", ")} / 판정일 ${judged}`,
    `- 범위: ${oneLine(draft.scope)}`,
  ].join("\n");
  return `${text.slice(0, m.index)}${block}\n\n${text.slice(m.index)}`;
}

/**
 * `text` without the block for `id`: its `## <id>` heading line up to the next `#` heading (or the end), blank lines
 * included, so it undoes `withRuleBlock`; every other byte as it was. Null when the file has no `## <id>` heading.
 */
export function withoutRuleBlock(text: string, id: string): string | null {
  const lines = text.split(/(?<=\n)/);
  const at = lines.findIndex((l) => RULE_HEADING.exec(l.trim())?.[1] === id);
  if (at < 0) return null;
  const next = lines.findIndex((l, i) => i > at && l.trim().startsWith("#"));
  return [...lines.slice(0, at), ...(next < 0 ? [] : lines.slice(next))].join("");
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
