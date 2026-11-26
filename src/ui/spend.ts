// GET /api/v1/spend?from=&to= (design 06-spend): cost, tokens and runs per UTC day and per work item over a range
// of UTC days, from the stored run outcomes (src/core/spend.ts). Read-only: server.ts answers 405 to any other
// method. Runs with no stored cost are counted apart as `unknown`, never added as 0. Item titles pass the
// Withholder, as on every other route; so do the titles of each day's top items (at most 3, by known cost). Chat
// turns' spend is answered apart, as `chat` (design 04-chat-agent). Store reads only: one range read of runs, one of
// chat turns, one read per item shown.

import { DAY_MS, SPEND_MAX_DAYS, readSpend, utcDay, weekStart } from "../core/spend.js";
import type { WorkItemId } from "../core/types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";

/** Days the range covers when the query names none: the last 30, today included. */
export const SPEND_DEFAULT_DAYS = 30;
/** The most items one answer lists, by cost; the totals cover them all. */
export const SPEND_ITEMS_CAP = 200;

export interface SpendCtx {
  store: Pick<FactoryStore, "listRunsFinishedBetween" | "listChatSpendBetween" | "getWorkItem">;
  /** The value, or the withheld marker. */
  text(value: string): Promise<string>;
  now: Date;
  /** The live daily and weekly budgets in dollars; null: none set. */
  budgets: { daily_usd: number | null; weekly_usd: number | null };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A UTC day as written (YYYY-MM-DD) that names a real date, else null. */
const dayOf = (v: string): string | null => (DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`)) && utcDay(Date.parse(`${v}T00:00:00.000Z`)) === v ? v : null);

/** Answers one GET: 200 with the spend, or 400 for a bad `from` or `to`. */
export async function spend(c: SpendCtx, params: URLSearchParams): Promise<{ status: number; value: unknown }> {
  const now = c.now.getTime();
  const to = params.get("to") ? dayOf(params.get("to")!) : utcDay(now);
  const from = params.get("from") ? dayOf(params.get("from")!) : to && utcDay(Date.parse(`${to}T00:00:00.000Z`) - (SPEND_DEFAULT_DAYS - 1) * DAY_MS);
  if (!from || !to) return { status: 400, value: { error: "from and to must be UTC days, YYYY-MM-DD." } };
  const span = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
  if (span < 1 || span > SPEND_MAX_DAYS) return { status: 400, value: { error: `from must be on or before to, at most ${SPEND_MAX_DAYS} days apart.` } };

  const s = await readSpend(c.store, from, to);
  // One read per item, shared by the table and the days' top items.
  const titles = new Map<WorkItemId, string | null>();
  const titleOf = async (id: WorkItemId): Promise<string | null> => {
    if (!titles.has(id)) {
      const title = (await c.store.getWorkItem(id))?.title;
      titles.set(id, title ? await c.text(title) : null);
    }
    return titles.get(id)!;
  };
  const items = [];
  for (const it of s.items.slice(0, SPEND_ITEMS_CAP)) items.push({ ...it, title: await titleOf(it.work_item_id) });
  const days = [];
  for (const d of s.days) {
    const top = [];
    for (const it of d.top) top.push({ work_item_id: it.work_item_id, title: await titleOf(it.work_item_id), cost_usd: it.cost_usd });
    days.push({ ...d, top });
  }
  return {
    status: 200,
    value: { as_of: c.now.toISOString(), today: utcDay(now), week_start: utcDay(weekStart(now)), budgets: c.budgets, ...s, days, items, items_total: s.items.length },
  };
}
