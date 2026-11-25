import { type MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";

// What a timed cadence repeats on, in plain words. The one formatter for the Schedules page's Repeats
// column (design 09-dashboard-schedules); its words are the shared `repeats.*` catalog keys.

/** A timed cadence as the API sends it: a kind and its spec (minutes, "09:00", "mon,fri 09:00" or a cron rule). */
export interface Cadence {
  kind: "interval" | "daily" | "weekly" | "cron";
  spec: string;
}

// The catalog key of each word, written out so each key stays a quoted literal in the source.

/** A spec the plain words cannot read shows as written, after its kind. */
const AS_WRITTEN: Record<Cadence["kind"], MessageKey> = {
  interval: "repeats.asWritten.interval",
  daily: "repeats.asWritten.daily",
  weekly: "repeats.asWritten.weekly",
  cron: "repeats.asWritten.cron",
};

const DAY_TEXT: Record<string, MessageKey> = {
  mon: "repeats.day.mon",
  tue: "repeats.day.tue",
  wed: "repeats.day.wed",
  thu: "repeats.day.thu",
  fri: "repeats.day.fri",
  sat: "repeats.day.sat",
  sun: "repeats.day.sun",
};
const WEEK = Object.keys(DAY_TEXT);
const TIME = /^\d{2}:\d{2}$/;

/** "Every 4 hours" for 240: minutes in the largest unit that divides them evenly; null when the spec is not whole minutes. */
function everyText(spec: string): string | null {
  if (!/^\d+$/.test(spec.trim()) || Number(spec) < 1) return null;
  const minutes = Number(spec);
  if (minutes % 1440 === 0) return minutes === 1440 ? t("repeats.every.day") : t("repeats.every.days", { n: minutes / 1440 });
  if (minutes % 60 === 0) return minutes === 60 ? t("repeats.every.hour") : t("repeats.every.hours", { n: minutes / 60 });
  return minutes === 1 ? t("repeats.every.minute") : t("repeats.every.minutes", { n: minutes });
}

/** "Every day at 09:00" for "09:00"; null when the spec is not a time. */
function dailyText(spec: string): string | null {
  return TIME.test(spec.trim()) ? t("repeats.dailyAt", { time: spec.trim() }) : null;
}

/** "Weekly on Mon and Fri at 09:00" for "mon,fri 09:00", days in week order; null when the spec is not days and a time. */
function weeklyText(spec: string): string | null {
  const m = /^([a-z,]+)\s+(\d{2}:\d{2})$/i.exec(spec.trim());
  const days = m?.[1]!.toLowerCase().split(",");
  if (!m || !days!.every((d) => d in DAY_TEXT)) return null;
  const names = WEEK.filter((d) => days!.includes(d)).map((d) => t(DAY_TEXT[d]!));
  const list = names.length === 1 ? names[0]! : t("repeats.days.and", { first: names.slice(0, -1).join(t("repeats.days.comma")), last: names.at(-1)! });
  return t("repeats.weeklyAt", { days: list, time: m[2]! });
}

/** What a cadence repeats on, in plain words: "Every 4 hours", "Every day at 09:00", "Weekly on Mon and Fri at 09:00"; no cadence is a Check a page schedule on each merge. */
export function repeatsText(cadence: Cadence | null): string {
  if (cadence === null) return t("schedules.onMerge");
  const { kind, spec } = cadence;
  const words = kind === "interval" ? everyText(spec) : kind === "daily" ? dailyText(spec) : kind === "weekly" ? weeklyText(spec) : null;
  return words ?? t(AS_WRITTEN[kind], { spec });
}
