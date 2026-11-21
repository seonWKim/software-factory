// The one state table (design 09-status-page): every item, run and worker state the pages show, with its label, its
// group, its tone, its sort order and its main action verb. Pure, no imports: the server (src/ui) and the web app
// (web/src) both read it, so a state reads the same on every page and in the API (`state_label`).

/** A pill's colour: one of the pill tokens, or neutral (web/src/components/ui/badge.tsx draws it). */
export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

/** The five groups the Work filters show, in their tab order. */
export const STATE_GROUPS = ["needs", "active", "waiting", "problem", "finished"] as const;
export type StateGroup = (typeof STATE_GROUPS)[number];

export const GROUP_LABELS: Readonly<Record<StateGroup, string>> = {
  needs: "Needs you",
  active: "Active",
  waiting: "Waiting",
  problem: "Problem",
  finished: "Finished",
};

export interface StateInfo {
  label: string;
  group: StateGroup;
  tone: Tone;
  /** Display order: rows and tabs sort by it, lowest first. */
  sort: number;
  /** The verb of the state's main action. */
  action: string;
}

export const STATES = {
  ready_to_merge: { label: "Ready to merge", group: "needs", tone: "ok", sort: 1, action: "Merge" },
  needs_approval: { label: "Needs approval", group: "needs", tone: "warn", sort: 2, action: "Approve" },
  needs_you: { label: "Needs you", group: "needs", tone: "bad", sort: 3, action: "Answer" },
  needs_triage: { label: "Needs triage", group: "waiting", tone: "warn", sort: 4, action: "Answer" },
  failed: { label: "Failed", group: "problem", tone: "bad", sort: 5, action: "Review" },
  stuck: { label: "Stuck", group: "problem", tone: "bad", sort: 6, action: "Review" },
  running: { label: "Running", group: "active", tone: "info", sort: 7, action: "Open" },
  queued: { label: "Queued", group: "active", tone: "neutral", sort: 8, action: "Open" },
  draining: { label: "Draining", group: "active", tone: "info", sort: 9, action: "Open" },
  held: { label: "Held", group: "waiting", tone: "neutral", sort: 10, action: "Open" },
  blocked_by_task: { label: "Blocked by another task", group: "waiting", tone: "neutral", sort: 11, action: "Open" },
  merged: { label: "Merged", group: "finished", tone: "ok", sort: 12, action: "Open" },
  closed: { label: "Closed", group: "finished", tone: "neutral", sort: 13, action: "Open" },
  rejected: { label: "Rejected", group: "finished", tone: "neutral", sort: 14, action: "Open" },
  succeeded: { label: "Succeeded", group: "finished", tone: "ok", sort: 15, action: "Open" },
  cancelled: { label: "Cancelled", group: "finished", tone: "neutral", sort: 16, action: "Open" },
} as const satisfies Record<string, StateInfo>;

export type StateKey = keyof typeof STATES;

/** Every state key in sort order. */
export const STATE_KEYS: readonly StateKey[] = (Object.keys(STATES) as StateKey[]).sort((a, b) => STATES[a].sort - STATES[b].sort);

/** The states only a run or a worker has: never a work item's, so never a Work filter. */
const NOT_ITEM = ["draining", "succeeded", "cancelled"] as const;
export type ItemState = Exclude<StateKey, (typeof NOT_ITEM)[number]>;

/** A work item's states in sort order: the levels the ranking gives (src/ui/priority.ts levelOf). */
export const ITEM_STATES: readonly ItemState[] = STATE_KEYS.filter((k): k is ItemState => !(NOT_ITEM as readonly string[]).includes(k));

export const isState = (key: string): key is StateKey => Object.hasOwn(STATES, key);
export const isGroup = (value: string): value is StateGroup => (STATE_GROUPS as readonly string[]).includes(value);

/** The state's label; an unknown key as words (underscores to spaces); none as "". */
export const stateLabel = (key: string | null | undefined): string => (!key ? "" : isState(key) ? STATES[key].label : key.replaceAll("_", " "));

/** The state's tone; an unknown or missing key is neutral. */
export const stateTone = (key: string | null | undefined): Tone => (key && isState(key) ? STATES[key].tone : "neutral");

export const groupOf = (key: string): StateGroup | undefined => (isState(key) ? STATES[key].group : undefined);

/** A group's item states in sort order. */
export const groupStates = (group: StateGroup): ItemState[] => ITEM_STATES.filter((k) => STATES[k].group === group);

/**
 * Whether a state passes a Work state filter: a group (`needs`, `active`, `waiting`, `problem`, `finished`) holds its
 * states, `closed` holds every Finished state (the older links' value, from before closed split into merged, closed
 * and rejected), any other value is one state.
 */
export function inStateFilter(state: string, filter: string): boolean {
  if (filter === "closed") return groupOf(state) === "finished";
  return isGroup(filter) ? groupOf(state) === filter : state === filter;
}

/** Whether a Work state filter asks for Finished rows, which the list hides otherwise. */
export const filterShowsFinished = (filter: string | null | undefined): boolean => !!filter && (filter === "finished" || groupOf(filter) === "finished");
