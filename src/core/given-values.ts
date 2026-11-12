import type { TriageOutput } from "./outputs.js";

// Given values (design 04-agents.md, 2026-11-12): the exact values a request states, which a spec must keep verbatim.
// The kinds checked: hex colours, code spans and table cells. A pure check; the controller holds a spec that drops one.

/** A fenced code block (``` or ~~~): its text is skipped for code spans and tables, and scanned for hex colours only. */
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm;
/** `#` and 3, 4, 6 or 8 hex digits, not inside a word. */
const HEX = /(?<![\w&#])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const CODE_SPAN = /`([^`\n]+)`/g;
/** A table's separator row: `|---|:--:|`, the leading and trailing pipes optional. */
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

/**
 * `#123` and `#5700` are as likely issue numbers as colours: a hex value of 3 or 4 decimal digits counts only when a
 * table cell or code span holds it.
 */
const isColour = (h: string): boolean => h.length > 5 || /[a-f]/i.test(h.slice(1));

/** The cells of one table row: split on unescaped pipes, the outer pipes dropped, backticks and emphasis stripped. */
function cells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").replace(/`/g, "").replace(/^\*{1,2}|\*{1,2}$/g, "").trim());
}

/** Every table cell of the markdown text: a header row, its separator row, and the body rows with a pipe below it. */
function tableCells(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!SEPARATOR.test(lines[i]!) || !lines[i - 1]!.includes("|")) continue;
    out.push(...cells(lines[i - 1]!));
    for (let j = i + 1; j < lines.length && lines[j]!.includes("|"); j++) out.push(...cells(lines[j]!));
  }
  return out;
}

/**
 * The answer syntax of a spec's decisions (`N: <answer>`, `1: <answer>`, `N: answer`): a request that quotes it
 * states no value. Defined here, since src/core cannot import the parser in src/shared/command-notes.ts.
 */
const ANSWER_SYNTAX = /^(?:\d+|N)\s*:\s*(?:<answer>|answer)$/i;

/** The request's given values in the order they appear, each once: hex colours, code spans, table cells. */
export function givenValues(request: string): string[] {
  const prose = request.replace(FENCE, "");
  const found = [
    ...[...request.matchAll(HEX)].map((m) => m[0]).filter(isColour),
    ...[...prose.matchAll(CODE_SPAN)].map((m) => m[1]!.trim()),
    ...tableCells(prose),
  ].filter((v) => v !== "" && !ANSWER_SYNTAX.test(v));
  return [...new Set(found)];
}

/** Whitespace runs as one space, so a value wrapped over two lines still matches. */
const squash = (t: string): string => t.replace(/\s+/g, " ");

/**
 * The request's given values the spec text does not hold verbatim, in request order. A hex colour matches in any
 * letter case (`#1A2B3C` is `#1a2b3c`); every other value matches exactly. Empty when the request has none.
 */
export function missingValues(request: string, spec: string): string[] {
  const text = squash(spec);
  const lower = text.toLowerCase();
  return givenValues(request).filter((v) => (/^#[0-9a-f]+$/i.test(v) ? !lower.includes(v.toLowerCase()) : !text.includes(squash(v))));
}

/** A stored owner answer the spec does not hold: its decision number and its text. */
export interface MissingAnswer {
  n: number;
  answer: string;
}

/**
 * The owner's stored answers (decision N's answer at index N-1; null: none given) the spec text does not hold, in
 * order. The whole answer must appear, letter case and whitespace runs ignored; no fuzzy match.
 */
export function missingAnswers(answers: readonly (string | null)[], spec: string): MissingAnswer[] {
  const text = squash(spec).toLowerCase();
  return answers.flatMap((a, i) => (a === null || a.trim() === "" || text.includes(squash(a.trim()).toLowerCase()) ? [] : [{ n: i + 1, answer: a }]));
}

/**
 * The spec text the implementer gets (the stored fields and the decisions), the text a given value must appear in.
 * `decisions: false` leaves the decisions out: an owner answer counts only where the spec states it, not where a
 * re-written spec asks the question again with the answer as an option.
 */
export function specText(spec: TriageOutput, o: { decisions?: boolean } = {}): string {
  return [
    spec.problem,
    ...spec.done_criteria,
    spec.desired_output,
    spec.scope,
    ...(spec.in_scope ?? []),
    ...(spec.out_of_scope ?? []),
    ...(o.decisions === false ? [] : spec.decisions ?? []),
    ...spec.allowed_paths,
    ...spec.files_to_change,
  ].join("\n");
}
