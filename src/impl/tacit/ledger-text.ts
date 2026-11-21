// The owner's CLIs print text, not JSON (checked 2026-11-12): these read the texts the agents-home plugin needs.
// `evolve pending` lists what waits for a verdict; `evolve show <id>` gives one entry's detail (its form is assumed,
// docs/plugins/tacit-ledger.md) and a class's draft (the owner's sample, 2026-11-13); `<home>/private/tacit/rules.md`
// holds the promoted rules, a promote adds one block to it and a retire removes one.

import type {
  TacitApplied, TacitAppliedRule, TacitDraft, TacitEntryDetail, TacitEvidence, TacitOpenPushback, TacitPendingEntry, TacitPromotion, TacitRule,
} from "../../interfaces/tacit-ledger.js";

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
      // A repeated field line is added after the earlier one, on its own line.
      field = FIELD_KEY[f[1] as keyof typeof FIELD_KEY];
      const value = afterColon(f[2]!);
      fields[field] = fields[field] === undefined ? value : `${fields[field]}\n${value}`;
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
 * absent; a repeated field line is added after the earlier one, on a new line); any other block is kept as raw text. The non-empty lines under `## 다른 곳에 인코딩된 규칙` are `elsewhere`, as
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
  const b = ruleBlock(text, id);
  return b === null ? null : [...b.lines.slice(0, b.at), ...b.lines.slice(b.end)].join("");
}

/** `text` as lines that keep their line ends, and the block of `id`: its heading line `at` up to `end` (the next `#` heading, or the end); null with no `## <id>` heading. */
function ruleBlock(text: string, id: string): { lines: string[]; at: number; end: number } | null {
  const lines = text.split(/(?<=\n)/);
  const at = lines.findIndex((l) => RULE_HEADING.exec(l.trim())?.[1] === id);
  if (at < 0) return null;
  const next = lines.findIndex((l, i) => i > at && l.trim().startsWith("#"));
  return { lines, at, end: next < 0 ? lines.length : next };
}

/** The `예외` label a block gets when it has none (the one `withRuleBlock` writes). */
const EXCEPTION_LABEL = "- 예외 (이럴 땐 override):";

/** A value's lines, each with its runs of space as one space; empty lines dropped. */
const valueLines = (v: string): string[] => v.split(/\r?\n/).map(oneLine).filter((l) => l !== "");

/**
 * `text` with the block of `id` edited: its heading line becomes `## <id> <wording>`, and its `기본값` and `예외` lines
 * (each with its indented continuation lines) become one line per line of the new value, under the label the first
 * such line had (a repeated line is dropped, its value now in the first). A block with no `예외` line gets one after
 * its `기본값` lines. Its `근거` and `범위` lines and every other byte stay as they were. Null when the file has no
 * `## <id>` heading.
 */
export function withEditedBlock(text: string, id: string, rule: TacitPromotion): string | null {
  const b = ruleBlock(text, id);
  if (b === null) return null;
  const end = (l: string) => /\r?\n$/.exec(l)?.[0] ?? "";
  const nl = end(b.lines[b.at]!) || "\n";
  const values = { 기본값: valueLines(rule.default), 예외: valueLines(rule.exception) };
  const out = [`## ${id} ${oneLine(rule.wording)}${end(b.lines[b.at]!)}`];
  const done = { 기본값: false, 예외: false };
  let afterDefault = -1;
  let skipping = false;
  for (const l of b.lines.slice(b.at + 1, b.end)) {
    const f = RULE_FIELD.exec(l.trim());
    const key = f?.[1] === "기본값" || f?.[1] === "예외" ? f[1] : null;
    if (key !== null) {
      skipping = true;
      if (done[key]) continue;
      done[key] = true;
      // The line's own label (indent, dash, word and any note) up to its colon.
      const word = l.indexOf(key);
      const colon = l.slice(word).search(/[:：]/);
      const label = colon < 0 ? `${l.slice(0, word + key.length)}:` : l.slice(0, word + colon + 1);
      out.push(values[key].map((v) => `${label} ${v}`).join(nl) + end(l));
      if (key === "기본값") afterDefault = out.length;
      continue;
    }
    if (skipping && l.trim() !== "" && /^\s/.test(l)) continue;
    skipping = false;
    out.push(l);
  }
  /** Adds `lines` after `out[at - 1]`; the last line of the file (no line end) moves its end-of-file to the new line. */
  const insert = (at: number, lines: string[]) => {
    const tail = end(out[at - 1]!);
    if (tail === "") out[at - 1] += nl;
    out.splice(at, 0, lines.join(nl) + (tail === "" ? "" : nl));
  };
  if (!done.기본값) {
    insert(1, values.기본값.map((v) => `- 기본값: ${v}`));
    afterDefault = 2;
  }
  if (!done.예외) insert(afterDefault, values.예외.map((v) => `${EXCEPTION_LABEL} ${v}`));
  return [...b.lines.slice(0, b.at), ...out, ...b.lines.slice(b.end)].join("");
}

/** `- T-0201 2026-11-20 — "words"`: one row of `tacit show --active --unclustered` (assumed form). */
const PUSHBACK_ROW = /^-\s+(T-[0-9A-Za-z_-]+)(?:\s+(.*))?$/;

/**
 * `tacit show --active --unclustered` as pushbacks (its form is assumed, docs/plugins/tacit-ledger.md): each
 * `- <T-id> <YYYY-MM-DD>? — "<the owner's words>"` row is one, its words unquoted (a row with no dash: the rest of
 * the line). Headings and blank lines are skipped. Text with other lines and no row throws: the form is not the one
 * read here, and the page says the list could not be read.
 */
export function parsePushbacks(text: string): TacitOpenPushback[] {
  const out: TacitOpenPushback[] = [];
  let other = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = PUSHBACK_ROW.exec(line);
    if (!m) {
      other = true;
      continue;
    }
    // The space before the dash is the one incidentRow looks for when the row gives no date.
    const row = incidentRow(` ${m[2] ?? ""}`);
    const words = row.quote ?? row.ref ?? "";
    out.push({ id: m[1]!, pushback: words, ...(row.date !== undefined ? { date: row.date } : {}) });
  }
  if (out.length === 0 && other) throw new Error("tacit show printed no pushback row (- T-<id> <date> — \"<words>\")");
  return out;
}

/** `- 기본값: …`, `근본 원인: …`, `kind: …`: a detail field line, with or without the list dash; the value follows the colon. */
const SHOW_FIELD =
  /^(?:-\s*)?(기본값|default|예외|exceptions?|범위|scope|근본\s*원인|root[ _]reason|kind|target|설명|요약|description|summary|현재|current|before|변경|proposed|after)\s*[:：](.*)$/i;
type ShowKey = "default" | "exceptions" | "scope" | "root_reason" | "kind" | "target" | "description" | "current" | "proposed";
const SHOW_KEY: Record<string, ShowKey> = {
  기본값: "default", default: "default", 예외: "exceptions", exception: "exceptions", exceptions: "exceptions", 범위: "scope", scope: "scope",
  "근본 원인": "root_reason", 근본원인: "root_reason", "root reason": "root_reason", kind: "kind", target: "target",
  설명: "description", 요약: "description", description: "description", summary: "description",
  현재: "current", current: "current", before: "current", 변경: "proposed", proposed: "proposed", after: "proposed",
};
/** `## incidents 3`: the incidents' heading, with how many came up. */
const INCIDENTS_HEADING = /^#{1,4}\s+incidents?\b(?:\s*\(?(\d+)\)?)?/i;
/** `- T-12 2026-11-03 — "keep the flag"`: the owner's words after an incident row's dash. */
const INCIDENT_WORDS = /\s—\s+(.+)$/;
/** An incident row's day: `2026-11-03`, alone or in brackets. */
const INCIDENT_DATE = /[([]?\b(\d{4}-\d{2}-\d{2})\b[)\]]?/;
/** `  proposal: …`, `  근본 원인: …`, `  date: …`: an indented line under an incident row. */
const INCIDENT_FIELD = /^(?:-\s*)?(제안|proposal|agent proposal|근본\s*원인|root[ _]reason|날짜|date)\s*[:：](.*)$/i;
const INCIDENT_KEY: Record<string, "proposal" | "root_reason" | "date"> = {
  제안: "proposal", proposal: "proposal", "agent proposal": "proposal", "근본 원인": "root_reason", 근본원인: "root_reason", "root reason": "root_reason",
  날짜: "date", date: "date",
};
/** A field's key as SHOW_KEY and INCIDENT_KEY spell it: lower case, one space for runs of space or underscore. */
const keyOf = (word: string): string => word.toLowerCase().replace(/[\s_]+/g, " ");

/** `"words"` or `“words”` as `words`. */
function unquote(s: string): string {
  const m = /^["“'‘](.*)["”'’]$/.exec(s.trim());
  return (m ? m[1]! : s).trim();
}

/** One incident row (after its `- `) as evidence: its reference and date before the dash, its quoted words after it. */
function incidentRow(rest: string): { -readonly [K in keyof TacitEvidence]: TacitEvidence[K] } {
  const words = INCIDENT_WORDS.exec(rest);
  const quoted = words === null && /^["“]/.test(rest);
  const head = words !== null ? rest.slice(0, words.index) : quoted ? "" : rest;
  const date = INCIDENT_DATE.exec(head);
  const ref = (date === null ? head : head.replace(date[0], " ")).replace(/\s+/g, " ").trim();
  const quote = unquote(words?.[1] ?? (quoted ? rest : ""));
  return { ...(ref !== "" ? { ref } : {}), ...(date !== null ? { date: date[1]! } : {}), ...(quote !== "" ? { quote } : {}) };
}

/** Newest first by date; an undated row after every dated one, each group in the ledger's order. */
const newestFirst = (a: TacitEvidence, b: TacitEvidence): number => (b.date ?? "").localeCompare(a.date ?? "");

/**
 * `evolve show <id>` as the entry's detail. Field lines (`기본값`, `예외`, `범위`, `근본 원인`, `설명`, `현재`, `변경`, or
 * `default`, `exceptions`, `scope`, `root reason`, `kind`, `target`, `description`, `current`, `proposed`) give their
 * value; an indented line under one continues it. Each `- ` row under an `## incidents <n>` heading is one incident:
 * `- <ref> <YYYY-MM-DD>? — "<the owner's words>"`, and its indented `proposal:` / `제안:`, `root reason:` / `근본 원인:`
 * and `date:` lines; the rows are `evidence`, newest first. The count is the heading's number, else the rows. A field
 * the text lacks is absent; an empty text is null.
 */
export function parseShow(id: string, text: string): TacitEntryDetail | null {
  if (text.trim() === "") return null;
  const fields: Partial<Record<ShowKey, string>> = {};
  let field: ShowKey | null = null;
  let incidents: { count: number | null; rows: { -readonly [K in keyof TacitEvidence]: TacitEvidence[K] }[] } | null = null;
  let row: { -readonly [K in keyof TacitEvidence]: TacitEvidence[K] } | null = null;
  let inIncidents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      field = null;
      row = null;
      const h = INCIDENTS_HEADING.exec(line);
      inIncidents = h !== null;
      if (h) incidents = { count: h[1] === undefined ? null : Number(h[1]), rows: [] };
      continue;
    }
    // An indented field line under an incident row belongs to that incident.
    const sub = row !== null && /^\s/.test(raw) ? INCIDENT_FIELD.exec(line) : null;
    if (row !== null && sub) {
      const key = INCIDENT_KEY[keyOf(sub[1]!)]!;
      const value = sub[2]!.trim();
      if (key === "date") {
        const d = INCIDENT_DATE.exec(value)?.[1];
        if (d !== undefined) row.date = d;
      } else if (value !== "") {
        row[key] = value;
      }
      continue;
    }
    const f = SHOW_FIELD.exec(line);
    if (f) {
      row = null;
      field = SHOW_KEY[keyOf(f[1]!)] ?? null;
      if (field) fields[field] = f[2]!.trim();
      continue;
    }
    if (field !== null && line !== "" && /^\s/.test(raw)) {
      fields[field] = fields[field] ? `${fields[field]}\n${line}` : line;
      continue;
    }
    field = null;
    if (!inIncidents || incidents === null || !line.startsWith("- ")) continue;
    row = incidentRow(line.slice(2).trim());
    incidents.rows.push(row);
  }
  const out: { -readonly [K in keyof TacitEntryDetail]: TacitEntryDetail[K] } = { id };
  for (const [k, v] of Object.entries(fields) as [ShowKey, string][]) if (v !== "") out[k] = v;
  if (incidents) {
    out.incidents = incidents.count ?? incidents.rows.length;
    const evidence = incidents.rows.filter((r) => Object.keys(r).length > 0);
    if (evidence.length > 0) out.evidence = [...evidence].sort(newestFirst);
  }
  return out;
}
