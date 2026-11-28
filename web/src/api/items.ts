// GET /api/v1/items (the list, useItems, through the generated itemsList; design 09-api-registry) and
// GET /api/v1/items/:id (one item), with the merge helpers the Merge button uses.

import { useQuery } from "@tanstack/react-query";
import { t } from "../i18n/index.js";
import { POLL_MS, postJson } from "./client.js";
import { itemsList } from "./generated.js";
import type { HostSleepRow } from "./health.js";
import type { CommandReply, ItemCommand, ProposalView, ThreadEntry, WaitingSpec } from "./item-commands.js";
import { API } from "./routes.js";

export interface SourceRef {
  type: string;
  id: string;
  link: string;
}

/**
 * The local merge check of a ready-to-merge item (design §5 Merge check); null for any other item. `checking`:
 * no result yet for its current head. The shas and time say which base it was checked against, and when.
 */
export interface MergeCheckView {
  state: "mergeable" | "conflicts" | "checking";
  conflicts: string[];
  head_sha: string | null;
  base_sha: string | null;
  checked_at: string | null;
  /** The item page only: the check is older than the base's last commit, so the card offers Re-check. */
  recheck?: boolean;
}

/** Another ready-to-merge item whose stored changed files share these exact paths with a row's item. */
export interface ItemOverlap {
  id: string;
  title: string | null;
  /** Its source id: its short number names it when it has no title. */
  source_id: string;
  paths: string[];
}

/** One changed file of an item's branch; both counts null for a binary file. A withheld path reads as the withheld marker. */
export interface ChangedFile {
  path: string;
  added: number | null;
  removed: number | null;
}

/**
 * GET /api/v1/items/:id/changes: the files the item's head changes against the base, and with `?path=` that file's
 * diff (`withheld`: `diff` is the withheld marker; `truncated`: cut at the server's limit).
 */
export interface ItemChanges {
  as_of: string;
  head_sha: string;
  base_sha: string | null;
  files: ChangedFile[];
  file?: { path: string; diff: string; withheld: boolean; truncated: boolean };
}

/** POST Re-check: the item's stored merge check is removed; the card reads checking until the controller checks again. */
export async function postRecheck(token: string, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(API.mergeRecheck(id), token, {});
  return r.ok ? { ok: true } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** The short label shown next to a ready-to-merge item's state. */
export function mergeCheckLabel(m: MergeCheckView): string {
  if (m.state === "mergeable") return t("api.mergeable");
  if (m.state === "checking") return t("api.checking");
  return t(m.conflicts.length === 1 ? "api.conflictsOne" : "api.conflictsMany", { count: m.conflicts.length });
}

/**
 * Whether the Merge button is enabled (design §9), from the item API's `merge`: else `reason` says why, e.g. not
 * waiting for a merge, merge check running, N conflicting files, no sandbox that can merge, no forge selected.
 */
export interface MergeReadiness {
  enabled: boolean;
  reason: string | null;
}

/** The `merge` reason of an item that is not waiting for a merge (src/ui/commands.ts NOT_WAITING). */
const NOT_WAITING = "not waiting for a merge";

/** Whether to draw the Merge button, enabled or with its reason: for an item waiting for its merge only. */
export function showsMerge(m: MergeReadiness | null | undefined): m is MergeReadiness {
  return !!m && (m.enabled || m.reason !== NOT_WAITING);
}

/**
 * The `merge` reasons of an item whose Merge was pressed (src/core/request-transition.ts ROW_LABELS and
 * mergeQueuedLabel): the request path's answer ("Merging…"), its request stored and not handled yet ("Merge queued
 * (position N)"), the merge queue checking the merged result ("Checking build"). Merge is hidden for each: the button
 * reads the reason, disabled, and the Work row says it as the item's state.
 */
const IN_FLIGHT = /^(?:Merging…|Checking build|Merge queued \(position \d+\))$/;

/** Whether the item's Merge was pressed and its merge is under way: the button reads its reason, disabled. */
export function mergeInFlight(m: MergeReadiness | null | undefined): m is MergeReadiness & { reason: string } {
  return !!m && !m.enabled && IN_FLIGHT.test(m.reason ?? "");
}

/**
 * The merge queue's refusal of a Merge for an item it already holds (`enter` in
 * src/controller/units/merge-queue/merge-queue.unit.ts: "<id> is already in the merge queue (<state>)"): the merge is
 * under way, so the page says Merging… instead of an error.
 */
export const alreadyQueued = (refusal: string | null | undefined): boolean => !!refusal && / is already in the merge queue \(/.test(refusal);

/**
 * Why the item's last Merge did not land (design 09-dashboard-app): the refusal on its newest state change when that
 * change put it back at merge_pending (`merge_returned`: a conflict, a red check, the forge's refusal); else null.
 */
export function mergeReturned(detail: Pick<ItemDetail, "item" | "timeline"> | undefined): string | null {
  const newest = (detail?.timeline ?? []).reduce<ItemDetail["timeline"][number] | null>((a, c) => (a && a.version > c.version ? a : c), null);
  if (detail?.item.blocked_reason !== "merge_pending" || newest?.reason !== "merge_returned") return null;
  return newest.detail?.refusal ?? null;
}

/**
 * Why an item waits (design §9, issue #310): its reason code (one en.ts text each, `why.reason.<code>`, worded by
 * lib/format.ts whyText) with the values the text names, the open alarms said after it, who moves it next, and the
 * same-repo issue numbers it names as `#N`. `ref_url` + a number is that issue's URL; null: show the number without
 * a link. `holder_id`: the item that holds a held or deadlocked run, linked from its name.
 */
export interface Why {
  code: string;
  reason_code: string;
  params: Record<string, string | number>;
  alarms: string[];
  holder_id: string | null;
  next_actor: "human" | "factory" | "other_item" | "none";
  refs: number[];
  ref_url: string | null;
}

export interface ItemRow {
  id: string;
  source: SourceRef;
  title: string | null;
  /** The item's state on the pages: its level (src/ui/priority.ts levelOf over core/phase.ts phaseOf and its run), a key of src/shared/states.ts. */
  item_phase: string;
  /** The state table's label for `item_phase`, for API readers; the pages draw it with StatusBadge from `item_phase`. */
  state_label?: string;
  /** Why it waits, as a reason code (the same as `why.reason_code`). */
  reason_code: string;
  stage: string;
  tier: number | null;
  kind: string | null;
  blocked_on: string;
  blocked_reason: string | null;
  close_reason: string | null;
  run_status: string | null;
  /** The PR as the store keeps it: its ref (the number as text) and its link; null with no PR or no stored link. */
  change_ref: string | null;
  change_url: string | null;
  /** The source issue; null for an adopted PR. */
  issue?: { number: number; url: string } | null;
  since: string;
  updated_at: string;
  version: number;
  dependents: number;
  conflicts: { automatic: number; person: number };
  merge_check?: MergeCheckView | null;
  /** The Merge button: enabled, or disabled with the reason. */
  merge?: MergeReadiness;
  /**
   * What a Needs-you row says: the reason (src/ui/need.ts); absent for other rows; null when the why's text says it.
   * `anchor`: the item page's anchor of the newest factory thread entry (`msg-<seq>`), null when it has none.
   */
  need?: { reason: string | null; anchor?: string | null };
  /** An ask's rank reason ("Merge", "Blocks another item", "Waiting for you", "Held until 09:00") and whether it is held until `review_time`; absent on a row that asks nothing of a person. */
  rank_reason?: string;
  held?: boolean;
  /** A Needs-you row's buttons: the state-changing commands that apply now (not budget), each allowed or not for the viewer. */
  commands?: ItemCommand[];
  /** A ready-to-merge Needs-you row: the other ready items it shares changed files with (exact paths); empty for none. */
  overlaps?: ItemOverlap[];
  why?: Why;
  /** The split parent (null for any other item) and this item's place among its phases. */
  parent_id?: string | null;
  phase?: number | null;
  /** The issue number this item waits on, when it is exactly one (a held phase's previous phase, one dependency). */
  waiting_on_number?: number | null;
  /** The item's queued or running run; `position` is a queued run's place in the queue. */
  run?: { kind: string; status: string; attempt: number; worker_id: string | null; started_at: string | null; position: number | null } | null;
  /** The item's latest claim decision; `holder` is "#92", `holder_id` the holding item when it has one. */
  claim?: { decision: string; holder: string | null; holder_id: string | null; approved: boolean; cost: number; threshold: number } | null;
}

export interface Items {
  as_of: string;
  total: number;
  items: ItemRow[];
  facets: { state: Record<string, number>; allStates: number };
  /** Open items (stage not CLOSED) and running runs, defined once on the server: the same numbers as the overview's. */
  counts: { open: number; running: number };
}

/** One phase of a split parent, as the item API lists it. */
export interface PhaseRow {
  id: string;
  phase: number;
  title: string | null;
  stage: string;
  source: SourceRef;
}

/** One done-when line on the item page: its check and the newest implement run's result; `output_tail` on a failed line only. */
export interface ItemCheck {
  line: string;
  check: { kind: "command" | "test" | "manual"; text: string };
  result: "pass" | "fail" | "manual" | "not_run";
  output_tail: string | null;
}

export interface ItemDetail {
  as_of: string;
  item: {
    id: string;
    source: SourceRef;
    title: string | null;
    stage: string;
    close_reason: string | null;
    blocked_on: string;
    blocked_reason: string | null;
    tier: number | null;
    loop_count: number;
    restart_count: number;
    token_cost: number;
    change_ref: string | null;
    change_url: string | null;
    /** The posted spec comment; null before triage posts it. */
    spec_comment_url?: string | null;
    /** A phase of a split spec: its parent's id and its place in merge order; both null on any other item. */
    parent_id?: string | null;
    phase?: number | null;
    /** A split parent's phases in phase order; empty for any other item. */
    phases?: PhaseRow[];
    version: number;
    created_at: string;
    updated_at: string;
    merge_check?: MergeCheckView | null;
    /** The item has a branch the server can read: the page shows the Changes tab. */
    has_changes?: boolean;
    /** The Merge button: enabled, or disabled with the reason. */
    merge?: MergeReadiness;
    /** The item's phase on the pages (the list's `item_phase`) and its reason code. */
    item_phase: string;
    reason_code: string;
    why?: Why;
    /** The request's first paragraph; null without one. Withheld text is "[withheld: <rule>]". */
    request?: string | null;
    /** The approved spec, each text withheld on its own; null until the owner confirms it. */
    spec?: { problem: string; desired_output: string | null; done_criteria: string[] } | null;
    /** Each done-when line with its check and latest result; null (or absent) when the item has no checks. */
    checks?: ItemCheck[] | null;
  };
  timeline: {
    version: number;
    at: string;
    /** `name`: the stored display name of a person, when the server has one. */
    actor: { kind: string; id: string | null; name?: string | null };
    reason: string | null;
    changes: Record<string, { from: string | null; to: string | null }>;
    detail: Record<string, string | null> | null;
  }[];
  runs: {
    id: string;
    kind: string;
    status: string;
    attempt: number;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
    tokens: number | null;
    error: { code: string | null; detail: string | null } | null;
    /** One record per claim, in attempt order; the last one's worker is the run's worker. */
    attempts?: { attempt: number; worker_id: string | null }[];
    /** True while the run waits for a host test slot (the store's `waiting:` row); its status stays `running`. */
    waiting_for_slot?: boolean;
  }[];
  /** Host sleeps recorded during one of the item's runs, newest first. */
  sleeps?: HostSleepRow[];
  /** The item's thread (src/ui/thread.ts), owner commands included, oldest first; every body already through the Withholder. */
  thread?: ThreadEntry[];
  /** The commands that apply in the item's current state, each allowed or not for the viewer, in the order to show them. */
  commands?: ItemCommand[];
  /** A spec waiting for approval (or at the revision limit): its In short and its decisions; null for any other item. */
  spec?: WaitingSpec | null;
  /** The item's app command requests, oldest first; the note is never returned. */
  replies?: CommandReply[];
  /** The item's pending proposals (src/ui/commands.ts itemProposals), oldest first. */
  proposals?: ProposalView[];
  /** Run id → its stored transcript parts ("" is the main step); a run not listed has no transcript. */
  transcripts?: Record<string, string[]>;
}

/**
 * The items read, polled as useApi is; `project` keeps the work items built from that task project's tasks. Its key
 * starts with the items' key, so a command's reload of the items reloads it whatever the filter.
 */
export function useItems(project: string | null) {
  return useQuery({
    queryKey: project === null ? [API.items] : [API.items, "project", project],
    // The schema types nested objects as JSON objects (owner answer 3): the page's Items type holds their fields.
    queryFn: () => itemsList(project === null ? {} : { project }) as Promise<unknown> as Promise<Items>,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });
}
