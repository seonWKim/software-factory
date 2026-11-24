import type { RoutineCadenceKind } from "../../api.js";
import { type MessageKey } from "../../i18n/en.js";

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
