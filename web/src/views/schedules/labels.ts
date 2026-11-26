import type { ActionKind, CadenceKind, ScheduleRunRow, ScheduleSuggestionRow } from "../../api.js";
import { type MessageKey } from "../../i18n/en.js";

// The catalog key of each schedule word, written out so each key stays a quoted literal in the source.

export const CADENCE_CHOICE: Record<CadenceKind, MessageKey> = {
  interval: "schedules.form.cadence.interval",
  daily: "schedules.form.cadence.daily",
  weekly: "schedules.form.cadence.weekly",
  cron: "schedules.form.cadence.cron",
};

export const SPEC_HELP: Record<CadenceKind, MessageKey> = {
  interval: "schedules.form.specHelp.interval",
  daily: "schedules.form.specHelp.daily",
  weekly: "schedules.form.specHelp.weekly",
  cron: "schedules.form.specHelp.cron",
};

export const ACTION_TEXT: Record<ActionKind, MessageKey> = {
  build: "schedules.actionKind.build",
  agent: "schedules.actionKind.agent",
  feedback: "schedules.actionKind.feedback",
  check_page: "schedules.actionKind.checkPage",
  improve: "schedules.actionKind.improve",
  summary: "schedules.actionKind.summary",
};

/** What each action does, one sentence, for the detail Card and the line under a title that has no text of its own. */
export const ACTION_ABOUT: Record<ActionKind, MessageKey> = {
  build: "schedules.actionAbout.build",
  agent: "schedules.actionAbout.agent",
  feedback: "schedules.actionAbout.feedback",
  check_page: "schedules.actionAbout.checkPage",
  improve: "schedules.actionAbout.improve",
  summary: "schedules.actionAbout.summary",
};

/** The missed-time rule in the owner's words, by the rule it stores (`skip_when_busy` true is skip). */
export const MISSED_RULES = ["catch_up", "skip"] as const;
export type MissedRule = (typeof MISSED_RULES)[number];
export const MISSED_TEXT: Record<MissedRule, MessageKey> = {
  catch_up: "schedules.missed.catchUp",
  skip: "schedules.missed.skip",
};
export const missedOf = (skipWhenBusy: boolean): MissedRule => (skipWhenBusy ? "skip" : "catch_up");

export const OUTCOME_TEXT: Record<ScheduleRunRow["outcome"], MessageKey> = {
  fired: "schedules.outcome.fired",
  refused: "schedules.outcome.refused",
  skipped: "schedules.outcome.skipped",
  checkpoint: "schedules.outcome.checkpoint",
  rejected: "schedules.outcome.rejected",
};

export const SUGGESTION_STATE_TEXT: Record<ScheduleSuggestionRow["state"], MessageKey> = {
  pending: "schedules.suggestions.state.pending",
  accepted: "schedules.suggestions.state.accepted",
  dismissed: "schedules.suggestions.state.dismissed",
  snoozed: "schedules.suggestions.state.snoozed",
};

export const STATE_TEXT = {
  paused: "schedules.state.paused",
  running: "schedules.state.running",
  waiting: "schedules.state.waiting",
} as const satisfies Record<string, MessageKey>;
