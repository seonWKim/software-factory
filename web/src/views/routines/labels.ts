import type { RoutineCadenceKind, RoutineRow } from "../../api.js";
import { type MessageKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";

// The catalog key of each routine word, written out so each key stays a quoted literal in the source.

export const CADENCE_TEXT: Record<RoutineCadenceKind, MessageKey> = {
  interval: "routines.cadence.interval",
  daily: "routines.cadence.daily",
  weekly: "routines.cadence.weekly",
  cron: "routines.cadence.cron",
};

/** What a routine repeats on in the form: a cadence kind, or the merge trigger. */
export type RepeatKind = RoutineCadenceKind | "merge";

export const REPEAT_CHOICE: Record<RepeatKind, MessageKey> = {
  interval: "routines.form.repeats.interval",
  daily: "routines.form.repeats.daily",
  weekly: "routines.form.repeats.weekly",
  cron: "routines.form.repeats.cron",
  merge: "routines.form.repeats.merge",
};

export const SPEC_HELP: Record<RoutineCadenceKind, MessageKey> = {
  interval: "routines.form.specHelp.interval",
  daily: "routines.form.specHelp.daily",
  weekly: "routines.form.specHelp.weekly",
  cron: "routines.form.specHelp.cron",
};

const DAY_TEXT: Record<string, MessageKey> = {
  mon: "routines.day.mon",
  tue: "routines.day.tue",
  wed: "routines.day.wed",
  thu: "routines.day.thu",
  fri: "routines.day.fri",
  sat: "routines.day.sat",
  sun: "routines.day.sun",
};
const WEEK = Object.keys(DAY_TEXT);

/** "Every 4 hours" for 240: minutes in the largest unit that divides them evenly; null when the spec is not whole minutes. */
function everyText(spec: string): string | null {
  if (!/^\d+$/.test(spec.trim()) || Number(spec) < 1) return null;
  const minutes = Number(spec);
  if (minutes % 1440 === 0) return minutes === 1440 ? t("routines.every.day") : t("routines.every.days", { n: minutes / 1440 });
  if (minutes % 60 === 0) return minutes === 60 ? t("routines.every.hour") : t("routines.every.hours", { n: minutes / 60 });
  return minutes === 1 ? t("routines.every.minute") : t("routines.every.minutes", { n: minutes });
}

/** "Weekly on Mon and Fri at 09:00" for "mon,fri 09:00", days in week order; null when the spec is not days and a time. */
function weeklyText(spec: string): string | null {
  const m = /^([a-z,]+)\s+(\d{2}:\d{2})$/i.exec(spec.trim());
  const days = m?.[1]!.toLowerCase().split(",");
  if (!m || !days!.every((d) => d in DAY_TEXT)) return null;
  const names = WEEK.filter((d) => days!.includes(d)).map((d) => t(DAY_TEXT[d]!));
  const list = names.length === 1 ? names[0]! : t("routines.days.and", { first: names.slice(0, -1).join(t("routines.days.comma")), last: names.at(-1)! });
  return t("routines.weeklyAt", { days: list, time: m[2]! });
}

/** What a routine repeats on, in plain words: "Every 4 hours", "Weekly on Mon and Fri at 09:00", "On merge". A spec the words cannot read shows as written. */
export function repeatsText(schedule: RoutineRow["schedule"]): string {
  if (schedule === null) return t("routines.onMerge");
  const { kind, spec } = schedule;
  const words = kind === "interval" ? everyText(spec) : kind === "weekly" ? weeklyText(spec) : null;
  return words ?? t(CADENCE_TEXT[kind], { spec });
}
