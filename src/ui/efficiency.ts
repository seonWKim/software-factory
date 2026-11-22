// GET /api/v1/efficiency (design 06-efficiency): finished items per hour, day and week, and each week's token and
// time figures per finished item, from src/core/efficiency.ts. Read-only: server.ts answers 405 to any other method.
// Store reads only (merge evaluations, items, runs, closed items); the titles of each week's listed items pass the
// Withholder, as on every other route. `merges` is the per-tier merge record and rule, the same as `factory stats`.

import { type EfficiencyStore, type ItemFigures, readEfficiency } from "../core/efficiency.js";
import { collectTierMerges } from "../core/stats.js";

export interface EfficiencyCtx {
  store: EfficiencyStore;
  /** The value, or the withheld marker. */
  text(value: string): Promise<string>;
  now: Date;
}

/** Answers one GET: 200 with the figures. */
export async function efficiency(c: EfficiencyCtx): Promise<{ status: number; value: unknown }> {
  const e = await readEfficiency(c.store, c.now);
  const titled = (list: readonly ItemFigures[]) => Promise.all(list.map(async (f) => ({ ...f, title: f.title ? await c.text(f.title) : null })));
  const week_figures = [];
  for (const w of e.week_figures) week_figures.push({ ...w, slowest: await titled(w.slowest), costliest: await titled(w.costliest) });
  const merges = await collectTierMerges(c.store);
  return { status: 200, value: { as_of: c.now.toISOString(), ...e, week_figures, merges } };
}
