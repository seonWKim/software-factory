import type { DoneCheck } from "../core/done-checks.js";
import type { Run, WorkItem } from "../core/types.js";

// The item page's About fields (docs/design/09-dashboard-item.md): the request, the approved spec, and the done-when
// checks (RFC 0024 WP3 phase 3), each done-when line with its check and its latest result, read from the item's
// done_checks and the newest implement run that stored results.

export type ItemCheckResult = "pass" | "fail" | "manual" | "not_run";

/** One done-when line as `item.checks` serves it. `output_tail`: the failed run's output, on a failed line only. */
export interface ItemCheckRow {
  line: string;
  check: { kind: "command" | "test" | "manual"; text: string };
  result: ItemCheckResult;
  output_tail: string | null;
}

const RESULTS: readonly string[] = ["pass", "fail", "manual", "not_run"];

/** The per-line results an implement run's outcome carries (succeeded data or failed outcome), or null when it has none. */
function storedResults(run: Run): { results: { line: string; result: ItemCheckResult }[]; tail: string | null } | null {
  const o = run.outcome;
  if (!o) return null;
  const raw = o.status === "succeeded" ? o.data.done_checks : (o as { done_checks?: unknown }).done_checks;
  if (!Array.isArray(raw)) return null;
  const results = raw.flatMap((r: unknown) => {
    const e = r as { line?: unknown; result?: unknown } | null;
    return e && typeof e.line === "string" && typeof e.result === "string" && RESULTS.includes(e.result) ? [{ line: e.line, result: e.result as ItemCheckResult }] : [];
  });
  const tail = o.status === "failed" && typeof o.output_tail === "string" && o.output_tail !== "" ? o.output_tail : null;
  return { results, tail };
}

/**
 * The item's `checks`: null when it has no done_checks (triaged before them). Else one row per check in order: a manual
 * line is `manual`; any other line takes the result the newest implement run stored for it (by place, when that run's
 * line there is the same text), else `not_run`. A failed line carries that run's output tail. Each text passes `text`.
 */
export async function itemChecks(checks: readonly DoneCheck[] | null, runs: readonly Run[], text: (v: string, outcome?: boolean) => Promise<string>): Promise<ItemCheckRow[] | null> {
  if (!checks) return null;
  const newest = [...runs]
    .filter((r) => r.kind === "implement")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(storedResults)
    .find((s) => s !== null) ?? null;
  const rows: ItemCheckRow[] = [];
  for (const [i, c] of checks.entries()) {
    const stored = newest?.results[i]?.line === c.line ? newest.results[i]!.result : null;
    const result: ItemCheckResult = "manual" in c ? "manual" : stored === "pass" || stored === "fail" ? stored : "not_run";
    const check = "manual" in c ? { kind: "manual" as const, text: c.reason } : "test_file" in c ? { kind: "test" as const, text: c.test_file } : { kind: "command" as const, text: c.command };
    rows.push({
      line: await text(c.line),
      check: { kind: check.kind, text: await text(check.text) },
      result,
      output_tail: result === "fail" && newest?.tail ? await text(newest.tail, true) : null,
    });
  }
  return rows;
}

type Text = (v: string | null, channel?: "run_outcome") => Promise<string | null>;

/**
 * The request: the first paragraph of the intake text's body. Every intake stores `${title}\n\n${body}`, so the stored
 * title is dropped when the text starts with it (then a blank line, or the end); null when nothing is left or the
 * paragraph is the title itself.
 */
export function requestOf(it: Pick<WorkItem, "title" | "issue_text">): string | null {
  const full = it.issue_text?.trim();
  if (!full) return null;
  const title = it.title?.trim() ?? "";
  let rest = full;
  if (title && full.startsWith(title)) {
    const after = full.slice(title.length);
    if (after === "" || /^[ \t]*\n[ \t]*\n/.test(after)) rest = after;
  }
  const first = rest.trim().split(/\n[ \t]*\n/)[0]?.trim() ?? "";
  return first === "" || first === title ? null : first;
}

/**
 * About's fields on GET /api/v1/items/:id: the request (the body's first paragraph), the spec once approved (done_criteria
 * set), and the checks; each text withheld on its own, an output tail on the run_outcome channel.
 */
export async function aboutFields(it: WorkItem, runs: readonly Run[], text: Text) {
  return {
    request: await text(requestOf(it)),
    spec: it.done_criteria && { problem: (await text(it.problem))!, desired_output: await text(it.desired_output), done_criteria: await Promise.all(it.done_criteria.map(async (d) => (await text(d))!)) },
    checks: await itemChecks(it.done_checks, runs, async (v, outcome) => (await text(v, outcome ? "run_outcome" : undefined))!),
  };
}
