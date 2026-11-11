// The Merges section of the status page (design 09-status-page): a digest of the stored per-merge evaluations of
// the last MERGE_DAYS days and the newest merges, from one store read (design 06-measurement). No sync plugin is
// read, so a GitHub, Slack or Jira outage leaves it as it is. Titles go through the Withholder.

import { ALL_VERDICT_KINDS, type MergeEvaluation, digestMerges } from "../core/merge-evaluation.js";
import type { Timestamp } from "../core/types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { esc, facts, table } from "./html.js";
import type { Withholder } from "./withhold.js";

/** Days the digest covers, counted back from now. */
export const MERGE_DAYS = 7;
/** Merges listed under the digest, newest first. */
const MERGE_ROWS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export async function mergesSection(store: FactoryStore, w: Withholder, now: Date): Promise<string> {
  const since = new Date(now.getTime() - MERGE_DAYS * DAY_MS).toISOString() as Timestamp;
  const merges = await store.listMergeEvaluations(since);
  const head = `<section id="merges"><h2>Merges (last ${MERGE_DAYS} days)</h2>`;
  if (merges.length === 0) {
    return `${head}<p class="muted">No merge in the last ${MERGE_DAYS} days. Merges from before evaluations were stored are not counted.</p></section>`;
  }
  const d = digestMerges(merges);
  const digest = facts([
    ["merged", esc(d.merged)],
    ["reverted", esc(d.reverted)],
    ["fixed forward", esc(d.fixed_forward)],
    ...ALL_VERDICT_KINDS.map((k): [string, string] => [`verdicts: ${k}`, esc(d.verdicts[k])]),
    ["tokens", esc(d.tokens)],
  ]);
  const rows = await Promise.all(merges.slice(-MERGE_ROWS).reverse().map(async (m) => ({ cells: await cells(m, w) })));
  return `${head}${digest}${table(["item", "merged at", "tier", "tokens", "after the merge", "verdicts"], rows)}</section>`;
}

async function cells(m: MergeEvaluation, w: Withholder): Promise<string[]> {
  const title = await w.text(m.title, { max: 120, fallback: m.work_item_id });
  const after = [m.reverted > 0 ? "reverted" : "", m.fixed_forward > 0 ? "fixed forward" : ""].filter(Boolean).join(", ");
  const verdicts = ALL_VERDICT_KINDS.filter((k) => m.verdicts[k] > 0).map((k) => `${k} ${m.verdicts[k]}`).join(", ");
  return [
    `<a href="/items/${esc(encodeURIComponent(m.work_item_id))}">${title}</a>`,
    `<time>${esc(m.merged_at)}</time>`,
    esc(m.tier ?? "none"),
    esc(m.token_cost),
    after ? esc(after) : `<span class="muted">nothing yet</span>`,
    verdicts ? esc(verdicts) : `<span class="muted">none</span>`,
  ];
}
