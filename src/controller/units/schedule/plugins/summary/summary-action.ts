// The summary action (design 08-schedules-actions): each fired occurrence reads both time settings
// (`summary_morning_time`, `summary_evening_time`, HH:MM in the machine's zone), finds the latest summary slot at or
// before its own time, and posts that slot's summary once: built from store reads with fixed wording (no model call),
// egress-scanned, then posted as one outbound delivery keyed `summary:<local date>:<morning|evening>`, so a second run
// of the slot posts nothing new. A window with nothing to report posts nothing. A finding posts and stores nothing.
// With the chat channel down, the run still stores the summary on its run row and ends normally.

import type { ScheduleActionRoute, SummaryDeps, SummarySlotName, SummaryWindow } from "../ports.js";

/** A summary slot: its name, local date (`YYYY-MM-DD`) and time. */
export interface SummarySlot { name: SummarySlotName; date: string; at: Date }

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The slots of the local days `from` to `to` days from `at`'s, oldest first. */
function slots(at: Date, times: { morning: string; evening: string }, from: number, to: number): SummarySlot[] {
  const out: SummarySlot[] = [];
  for (let day = from; day <= to; day++) {
    for (const name of ["morning", "evening"] as const) {
      const [h, m] = times[name].split(":").map(Number);
      const t = new Date(at.getFullYear(), at.getMonth(), at.getDate() + day, h, m);
      out.push({ name, date: localDate(t), at: t });
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The latest slot at or before `at`, and the slot before it (where its window starts). */
export function dueSummarySlot(at: Date, times: { morning: string; evening: string }): { slot: SummarySlot; since: Date } {
  const past = slots(at, times, -2, 0).filter((s) => s.at.getTime() <= at.getTime());
  const slot = past[past.length - 1]!;
  const before = past.filter((s) => s.at.getTime() < slot.at.getTime());
  return { slot, since: before[before.length - 1]!.at };
}

/** When the next summary is due after `now`: the first slot after it, from the settings as they are now. */
export const nextSummaryAt = (now: Date, times: { morning: string; evening: string }): SummarySlot =>
  slots(now, times, 0, 1).find((s) => s.at.getTime() > now.getTime())!;

/** The outbound key of a slot: one post per slot. */
export const summaryKey = (s: Pick<SummarySlot, "name" | "date">): string => `summary:${s.date}:${s.name}`;

/** The summary route over `deps` (compose binds them to the store, the scanner, the live settings and the owner's chat). */
export const summaryAction = (deps: SummaryDeps): ScheduleActionRoute => async (schedule, occurrence_at, ports) => {
  const { slot, since } = dueSummarySlot(new Date(occurrence_at), await deps.times());
  const label = `the ${slot.name} summary of ${slot.date}`;
  const window: SummaryWindow = { slot: slot.name, since: since.toISOString(), until: slot.at.toISOString(), exclude_schedule: schedule.id };
  const summary = await deps.build(window);
  const done = (output: string) => ports.record({ output, tokens: 0, cost_usd: null });
  if (summary === null) return done(`nothing to report for ${label}: nothing posted`);
  const findings = await deps.scan(summary.text);
  if (findings.length > 0) throw new Error(`${label} not posted: the leak scanner flagged it (${findings.join(", ")})`);
  let posted: boolean;
  try {
    posted = (await deps.post({ key: summaryKey(slot), text: summary.text, buttons: summary.buttons })).created;
  } catch {
    return done(`${summary.text}\n\n(not posted yet: the owner's chat channel did not take it; the next run tries again)`);
  }
  return done(posted ? summary.text : `already posted ${label}: nothing new posted`);
};
