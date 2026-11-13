// The owner's CLIs print text, not JSON (checked 2026-11-12): these read the texts the agents-home plugin needs.
// `evolve pending` lists what waits for a verdict; `evolve show <C-id>` gives a class's draft (the owner's sample,
// 2026-11-13); `<home>/private/tacit/rules.md` holds the promoted rules, and a promote adds one block to it.

import type { TacitDraft, TacitPendingEntry, TacitPromotion, TacitRule } from "../../interfaces/tacit-ledger.js";

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
