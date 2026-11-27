// A waiting proposal's preview for its Rules page row (design 09-dashboard-rules-waiting): the first changed lines of
// its current and proposed text (the excerpt behind "Why and where") and its one-line gist, both read through
// `TacitLedger.show` once per waiting proposal by GET /api/v1/rules (rules-api.ts) and passed through `text` (the
// Withholder).

import type { TacitEntryDetail, TacitLedger } from "../interfaces/tacit-ledger.js";

/** The most lines and characters of each side a proposal's row shows before it is opened. */
const EXCERPT_LINES = 3;
const EXCERPT_CHARS = 200;

/** A waiting proposal's before and after lines for its row; a side the ledger does not give is absent. */
export type Excerpt = { before?: string; after?: string };

/** The first changed lines of one side: what stays after the lines both sides share at the start and the end, cut to the row's limits. */
function changedLines(own: string[], other: string[]): string {
  let start = 0;
  while (start < own.length && start < other.length && own[start] === other[start]) start++;
  let end = 0;
  while (end < own.length - start && end < other.length - start && own[own.length - 1 - end] === other[other.length - 1 - end]) end++;
  return own.slice(start, own.length - end).slice(0, EXCERPT_LINES).join("\n").slice(0, EXCERPT_CHARS);
}

/** The most characters of a proposal's gist line. */
const GIST_CHARS = 160;

/**
 * A waiting proposal's one-line gist for its row (2026-11-27): the first line it adds (the first changed line of its
 * proposed text), else the first line of its prose change, its description or its root reason; a leading list or heading
 * mark is dropped and it is cut to GIST_CHARS. Null when the ledger gives none of them.
 */
function gistOf(detail: TacitEntryDetail | null, added: string): string | null {
  const first = (v: string | undefined) => (v ?? "").split("\n").map((l) => l.replace(/^\s*(?:[-*+]|\d+\.|#+)\s+/, "").trim()).find((l) => l !== "");
  const line = first(added) ?? first(detail?.change) ?? first(detail?.description) ?? first(detail?.root_reason);
  return line === undefined ? null : line.slice(0, GIST_CHARS);
}

/**
 * The excerpt of proposal `id` from `TacitLedger.show` (its current and proposed lines), each side through `text`,
 * null when the ledger gives neither side; and its gist (gistOf) through `text`. A ledger with no `show`, or a failed
 * one, gives neither: the row then shows no excerpt and no gist.
 */
export async function previewOf(tacit: TacitLedger, id: string, text: (v: string) => Promise<string>): Promise<{ excerpt: Excerpt | null; gist: string | null }> {
  let detail: TacitEntryDetail | null = null;
  try {
    detail = (await tacit.show?.(id)) ?? null;
  } catch {
    return { excerpt: null, gist: null };
  }
  const lines = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : v.split("\n"));
  const before = lines(detail?.current);
  const after = lines(detail?.proposed);
  const out: Excerpt = {};
  const b = before === null ? "" : changedLines(before, after ?? []);
  const a = after === null ? "" : changedLines(after, before ?? []);
  if (b.trim() !== "") out.before = await text(b);
  if (a.trim() !== "") out.after = await text(a);
  const gist = gistOf(detail, a);
  return { excerpt: out.before === undefined && out.after === undefined ? null : out, gist: gist === null ? null : await text(gist) };
}
