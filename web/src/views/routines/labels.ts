import type { RoutineCadenceKind, RoutineRow } from "../../api.js";
import { repeatsText } from "../../lib/repeats.js";
import { type MessageKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";

// The catalog key of each routine word, written out so each key stays a quoted literal in the source.

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

/** What a routine repeats on, in plain words: "Every 4 hours", "Weekly on Mon and Fri at 09:00" (the shared formatter), "On merge". */
export function routineRepeats(schedule: RoutineRow["schedule"]): string {
  return schedule === null ? t("routines.onMerge") : repeatsText(schedule);
}
