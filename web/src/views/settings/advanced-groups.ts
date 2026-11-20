import type { MessageKey } from "../../i18n/en.js";

/** The Advanced tab's groups, in the order the page shows them; "developers" is the collapsed one (design 09-dashboard-settings). */
export const ADVANCED_GROUPS = [
  { id: "retries", title: "settings.groupRetries" },
  { id: "limits", title: "settings.groupLimits" },
  { id: "models", title: "settings.groupModels" },
  { id: "notices", title: "settings.notices" },
  { id: "developers", title: "settings.groupDevelopers" },
] as const satisfies readonly { id: string; title: MessageKey }[];

export type AdvancedGroupId = (typeof ADVANCED_GROUPS)[number]["id"];

/**
 * Each settable key's group. A key not named here falls to Limits, so a new key still shows; the group test in
 * tests/ui-settings-page.test.tsx fails until the key is listed once, in the group it belongs to.
 */
export const GROUP_KEYS: Readonly<Record<AdvancedGroupId, readonly string[]>> = {
  retries: ["max_attempts", "max_loops", "max_restart", "retry_base_ms", "retry_max_ms", "auth_pause_ms"],
  limits: [
    "max_diff_lines", "max_diff_files", "run_timeout_ms", "first_output_ms", "stall_ms", "probe_interval_ms", "workers",
    "spend.daily_budget_usd", "spend.weekly_budget_usd", "alarm_repeat_count", "alarm_window_minutes", "alarm_restart_count",
    "mode", "auto_merge_max_tier", "phases_auto_approve", "standing_approvals.threshold", "hold_policy", "auto_grant_test_paths",
    "test_globs", "tool_grants", "intake_label", "conflict_hotspot_threshold",
  ],
  models: ["models", "model_by", "message_style"],
  notices: ["notice_kinds", "quiet_hours", "notify_channels", "integrations", "calendar"],
  developers: ["lease_ms", "heartbeat_ms", "hotspot_weight", "mechanical_weight", "max_coordination_cost", "tick_ms", "poll_interval_ms"],
};

/** The group a key sits in. */
export function groupOf(key: string): AdvancedGroupId {
  return ADVANCED_GROUPS.find((g) => GROUP_KEYS[g.id].includes(key))?.id ?? "limits";
}

/** A catalog `applies` text as one of the owner's three phrases (design 09-dashboard-settings); the catalog's own text is not shown. */
const APPLIES_WORDS: Readonly<Record<string, MessageKey>> = {
  "the next load of the Tasks page": "settings.appliesNow",
  "the next model call": "settings.appliesNow",
  "the next tick": "settings.appliesMinute",
  "the worker pool's next tick": "settings.appliesMinute",
  "the next tick (the controller's next sync)": "settings.appliesMinute",
  "the next tick, and the next Rules page request": "settings.appliesMinute",
  "the next alarm step (each poll)": "settings.appliesMinute",
  "the next notifications pass (each poll)": "settings.appliesMinute",
  "the next stall pause or probe": "settings.appliesMinute",
  "the next forge auth pause": "settings.appliesMinute",
  "the controller's next decision": "settings.appliesMinute",
  "the controller's next needs-human stop": "settings.appliesMinute",
  "the controller's next spec approval": "settings.appliesMinute",
  "the controller's next spec approval or merge": "settings.appliesMinute",
  "the controller's next merge": "settings.appliesMinute",
};

/** The phrase for a catalog `applies` text; anything else (a run, a claim, an item) starts with the next task. */
export function appliesKey(applies: string | null): MessageKey {
  return (applies !== null && APPLIES_WORDS[applies]) || "settings.appliesTask";
}
