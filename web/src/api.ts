// The app talks only to the JSON API under /api/v1 (design §9); nothing else is fetched. Its writes are
// POST /api/v1/settings (postSettings), POST /api/v1/items/:id/commands (postCommand), POST /api/v1/pauses/resume
// (postResume), POST /api/v1/standing (postStanding), POST /api/v1/rules/verdict (postRuleVerdict) and POST
// /api/v1/tasks/build (postTaskBuild), POST /api/v1/tasks (postTaskAdd) and the Tasks page's row actions under
// /api/v1/tasks (postTaskAction: edit, done, reopen (⌘Z and the Done tab), delete, sub, and schedule, the timeline's drop), the
// project dialog's POST /api/v1/projects (postProject) and POST /api/v1/tasks/project (postTaskProject) and POST /api/v1/data/ask
// (postDataAsk), each with the per-process CSRF token (from GET /api/v1/settings,
// /api/v1/session, /api/v1/pauses, /api/v1/standing, /api/v1/rules, /api/v1/tasks or /api/v1/data/tables) in x-csrf-token.

import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { t } from "./i18n/index.js";

/** The supervisor's status (the status page's banner); null when the factory is stopped. */
export interface FactoryState {
  state: string;
  rev: string | null;
  target_rev: string | null;
  child_pid: number | null;
  since: string;
  /** The effective `workers` setting (file, override or default, capped at max_workers), not the status file's value. */
  workers: number;
  workers_source: "override" | "file" | "default";
  error: string | null;
  pending: string[];
}

/** What the factory needs from the operator besides a work item (design §9), with the command that clears it. */
export interface SystemAction {
  code: "migration_pending" | "token_expiring" | "claim_pause" | "worker_pause" | "alarm" | "revision_mismatch";
  text: string;
  command: string;
  /** When it ends by itself, else null. */
  until: string | null;
  /** On the alarm of the auto-mode stop still in force: the banner shows when and why, and a button back to auto. */
  auto_stop?: AutoStop;
}

/** The last auto-mode stop while it is in force (design 03-risk): its alarm, when, and its cause code. */
export interface AutoStop {
  alert_id: string;
  at: string;
  /** `red_main`, `budget_checkpoint` or `failure_alert`. */
  cause: string;
}

/** `/api/v1/overview`: the page's numbers. */
export interface Overview {
  as_of: string;
  /** The revision the UI server's build was made from (its dist/ stamp); compared with WEB_REV. Null: unknown. */
  server_rev?: string | null;
  stages: Record<string, number>;
  /** Open items blocked on a person plus the system actions: "Needs you (N)". */
  needs_you: number;
  system_actions?: SystemAction[];
  running: number;
  queued: number;
  last_24h: { succeeded: number; failed: number; tokens: number };
  /** PRs recorded as merged with no work item in the last 7 days. */
  unreviewed_merges_7d?: number;
  /** Which plugins are in use: the tables show the Issue column only for "github". */
  plugins?: { issues: "github" | null };
  /** Absent when the server has no status function. */
  factory?: FactoryState | null;
}

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
 * Why an item waits (design §9, issue #310): one sentence, who moves it next, and the same-repo issue numbers
 * the sentence names as `#N`. `ref_url` + a number is that issue's URL; null: show the number without a link.
 */
export interface Why {
  code: string;
  text: string;
  next_actor: "human" | "factory" | "other_item" | "none";
  refs: number[];
  ref_url: string | null;
}

export interface ItemRow {
  id: string;
  source: SourceRef;
  title: string | null;
  level: string;
  badges: string[];
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
   * What a Needs-you row says: the reason (src/ui/need.ts); absent for other rows. `anchor`: the item page's anchor
   * of the newest factory thread entry (`msg-<seq>`), null when it has none.
   */
  need?: { reason: string; anchor?: string | null };
  /** A Needs-you row's buttons: the state-changing commands that apply now (not budget), each allowed or not for the viewer. */
  commands?: ItemCommand[];
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
}

export interface RunRow {
  id: string;
  status: string;
  kind: string;
  work_item_id: string;
  attempt: number;
  owner: string | null;
  heartbeat_at: string | null;
  started_at: string | null;
  lease_expires_at: string | null;
  created_at: string;
}

export interface QueueRow {
  position: number;
  id: string;
  kind: string;
  work_item_id: string;
  attempt: number;
  created_at: string;
  not_before: string | null;
  /** Why its item waits; null when the item is gone. */
  why?: Why | null;
}

/** One phase of a split parent, as the item API lists it. */
export interface PhaseRow {
  id: string;
  phase: number;
  title: string | null;
  stage: string;
  source: SourceRef;
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
    /** The Merge button: enabled, or disabled with the reason. */
    merge?: MergeReadiness;
    why?: Why;
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
 * One entry of an item's thread. `role` `owner` is anything the owner sent (a command, a verdict, a message from a
 * source): `author` is then the stored user ID (`unknown` when the entry stores none), `kind` a command's name,
 * `channel` the item's source type or `cli` / `app` (the dashboard) for a command.
 */
export interface ThreadEntry {
  seq: number;
  at: string;
  kind: string;
  author: string;
  role: "factory" | "owner";
  channel: string;
  /** The entry's id on the item page: `msg-<seq>`. */
  anchor: string;
  body: string;
}

/** One host sleep a worker saw (a wait that ended over 60 s late): ids, a time and a number only. */
export interface HostSleepRow {
  worker_id: string;
  woke_at: string;
  /** How late the wait ended, in ms. */
  gap_ms: number;
  run_id: string | null;
}

/** Which steps the transcript filter keeps (tool calls of that kind). */
export type StepFilter = "edits" | "commands" | "reads";

/** One step of a stored transcript; withheld text is "[withheld: <rule>]" and its tool is null. */
export interface TranscriptStep {
  id: string;
  kind: "text" | "tool_use" | "tool_result" | "result" | "system" | "error" | "plain" | "other" | "oversize";
  tool: string | null;
  text: string;
  is_error: boolean;
  withheld: boolean;
  truncated?: boolean;
}

/** One page of a run's stored transcript (GET /api/v1/items/<id>/runs/<run>/transcript). */
export interface TranscriptPage {
  run: {
    id: string;
    kind: string;
    status: string;
    attempt: number;
    started_at: string | null;
    finished_at: string | null;
    worker_id: string | null;
    outcome: { status: string; error_code: string | null; detail: string | null; summary: string | null } | null;
  };
  parts: string[];
  part: string;
  format: "stream-json" | "plain";
  size: number;
  mode: "forward" | "tail";
  filter: StepFilter | null;
  start: number;
  /** The next page's byte offset; null at the end (or for a tail page). */
  next: number | null;
  /** Steps before `start` exist (a tail page, or a later forward page). */
  earlier: boolean;
  steps: TranscriptStep[];
}

/** The item API's `spec` (issue #526): what the decision panel and the approve confirm step show. */
export interface WaitingSpec {
  in_short: string | null;
  decisions: SpecDecision[];
}

/** One decision of a waiting spec: a question with 2 to 4 options (or none), the proposed default and why triage asks. */
export interface SpecDecision {
  question: string;
  options: string[];
  default: string | null;
  reason: string | null;
  owner_only: boolean;
}

export interface ItemCommand {
  name: string;
  usage: string;
  description: string;
  /** Whether the viewer's grants allow it (approve_spec, as the controller checks it). */
  allowed: boolean;
  /** Why not, in the controller's refusal words; null when allowed. */
  reason: string | null;
}

/** A stored proposal with its pending commands, each as its typed line and the item it is for. */
export interface ProposalView {
  id: string;
  created_at: string;
  commands: { index: number; work_item_id: string; line: string }[];
}

/** One app command request: `handled_at` null while the controller has not applied or refused it. */
export interface CommandReply {
  seq: number;
  command: string | null;
  created_at: string;
  handled_at: string | null;
  refusal: string | null;
}

/**
 * A refusal as the page shows it (issue #528): plain text, the controller's backticks dropped. The stored text keeps
 * them, as GitHub, Slack and the CLI show it.
 */
export function plainRefusal(text: string): string {
  return text.replace(/`/g, "");
}

/** `/api/v1/session`: the token item commands send, whether commands are on, and who they act as. */
export interface Session {
  as_of: string;
  csrf_token: string;
  commands_enabled: boolean;
  /** The factory user commands act as: `ui.user_id`, else on loopback the CLI identity; null when off. */
  actor: string | null;
  actor_source: "config" | "environment" | null;
}

export type CommandResult = { ok: true; seq: number } | { ok: false; error: string };

export interface Health {
  checked_at: string;
  checks: { status: string; msg: string }[];
  /** The 10 newest host sleeps, newest first. */
  sleeps?: HostSleepRow[];
}

/** `/api/v1/unreviewed-merges`: PRs that merged with no work item, newest first. */
export interface UnreviewedMerges {
  as_of: string;
  merges: { project: string | null; change_ref: string; change_url: string | null; merge_sha: string | null; merged_by: string | null; recorded_at: string }[];
}

/** One settable key on the Settings page. Values are JSON text, as `factory settings set` takes them. */
export interface SettingRow {
  key: string;
  /** What the key controls, from the settings core module. */
  description: string;
  /** `text`: free text (message_style), shown as plain text and sent back as a JSON string. */
  kind: "number" | "boolean" | "models" | "json" | "mode" | "text";
  value: string;
  source: "override" | "file" | "default";
  file_value: string | null;
  default_value: string;
  applies_at: string;
  project_settable: boolean;
  projects: { project: string; value: string; source: "override" | "file" }[];
  /** workers only: the file's max_workers, and the cap when the stored value is above it. */
  max?: number;
  capped_at?: number | null;
}

/** `/api/v1/settings`. */
export interface SettingsView {
  as_of: string;
  /** Sent back in x-csrf-token on every write; a reload fetches a new one after a restart. */
  csrf_token: string;
  /** The configured repo's owner/name: the `project` a per-project write names. */
  repo: string;
  /** Its stored label; null: none stored, so per-project writes go through `factory settings`. */
  project: string | null;
  project_keys: string[];
  keys: SettingRow[];
  pr_only: { key: string; description: string }[];
  /** The typed form of the file-only keys (design 08-settings); null or absent: this server has no file writer. */
  file_keys?: FileKeysView | null;
  /** Each integration (design 08-settings): the plugin in force, and whether the `integrations` setting or the config chose it. Absent: none. */
  integrations?: IntegrationRow[];
  ignored: { key: string; project: string | null; value: string; reason: string }[];
  history: { seq: number; at: string; actor: string; key: string; project: string | null; old_value: string | null; new_value: string | null }[];
  /** The auto-mode stop still in force, which the Mode toggle shows; null or absent: none. */
  auto_stop?: AutoStop | null;
}

/**
 * One entry of the Settings page's Capabilities list (design 08-settings, 2026-11-13): a skill, a broker tool or a provider
 * entry. `id` names it (`runner:claude-code`); `last_used` is the newest stored run that used it, null when none did.
 */
export interface CapabilityRow {
  kind: "skill" | "tool" | "provider";
  id: string;
  name: string;
  /** A skill's folder, a tool's description, a provider's endpoint host; null when there is none. */
  detail: string | null;
  enabled: boolean;
  roles: string[];
  last_used: string | null;
  read_only?: boolean;
  /** A provider entry's model per class: the names `model_by` picks between. */
  models?: { class: string; model: string }[];
}

/** `/api/v1/settings/capabilities`. */
export interface CapabilitiesView {
  as_of: string;
  /** The roles a tool may be granted to (the `tool_grants` keys). */
  roles: string[];
  capabilities: CapabilityRow[];
}

/** One integration interface on the Settings page. `configured`: the plugin factory.config.json selects. */
export interface IntegrationRow {
  kind: string;
  interface: string;
  plugin: string;
  source: "setting" | "config";
  configured: string;
}

/** One key's value in factory.config.json as the server loaded it: JSON text, null when the file leaves it out. */
export interface FileKeyValue {
  key: string;
  value: string | null;
}

/** `file_keys` of `/api/v1/settings`: what the Settings page's typed form edits and shows. */
export interface FileKeysView {
  /** The file-only keys the page edits, each saved through the file writer onto a local branch. */
  editable: FileKeyValue[];
  /** The keys shown with their value and no control. */
  read_only: FileKeyValue[];
  /** Each interface under `plugins`: its registered plugin names, whether it is a guard, and the plugin in force. */
  plugins: { kind: string; interface: string; guard: boolean; names: string[]; selected: string | null }[];
}

export type SettingsWrite =
  | { action: "set"; key: string; value: string; project?: string }
  | { action: "reset"; key: string; project?: string }
  | { action: "edit-file"; key: string; value: string; confirm: boolean };

/** The answer to a write: the CLI's lines (an edit-file also with its filed item and branch), or its refusal. */
export type WriteResult = { ok: true; lines: string[]; filed?: { item: string; branch: string } } | { ok: false; error: string };

/** One store table: its line, owning component and column meanings (null and {} when no component describes it). */
export interface DataTableInfo {
  name: string;
  rows: number;
  columns: string[];
  hidden: string[];
  /** Absent from a server older than the table docs. */
  description?: string | null;
  owner?: string | null;
  column_docs?: Record<string, string>;
}

/** `/api/v1/data/tables`: every store table (design §9 Data page); `csrf_token` is null when the server has no Ask route. */
export interface DataTables {
  as_of: string;
  tables: DataTableInfo[];
  csrf_token: string | null;
}

/** POST /api/v1/data/ask's answer: the query and its result, the query and why it was refused, or a message alone. */
export type DataAskResult =
  | { ok: true; sql: string; columns: string[]; rows: DataCell[][]; truncated: boolean; answer: string | null }
  | { ok: false; sql: string | null; error: string };

/** `/api/v1/data/autonomy`: merged factory items with no person's push (design §6); `autonomy` null with none merged. */
export interface DataAutonomy {
  as_of: string;
  merged: number;
  with_push: number;
  autonomy: number | null;
}

/** A cell as the API returns it: hidden columns are "[hidden]", withheld text "[withheld: <rule>]". */
export type DataCell = string | number | null;

/** `/api/v1/data/tables/:name`: one page of a table's rows, newest first. */
export interface DataPageBody {
  as_of: string;
  table: string;
  columns: string[];
  hidden: string[];
  order_by: string[];
  filter: { column: string; value: string | null } | null;
  total: number;
  page: number;
  limit: number;
  rows: Record<string, DataCell>[];
  /** Run id → the work item that owns it, for the run ids in this page. */
  run_items: Record<string, string>;
}

/** One claim pause in effect (design §5 Restarts). `ends_at`: for model_stall, the next probe time. */
export interface PauseRow {
  name: string;
  ends_at: string;
  /** When a model stall began; absent for the pauses that have no start time. */
  since?: string | null;
}

/** `/api/v1/pauses`: the pauses in effect; `csrf_token` is null when the server has no resume route. */
export interface PausesView {
  pauses: PauseRow[];
  csrf_token: string | null;
}

/** One standing rule of `/api/v1/standing` (design 05-standing-approvals). `last_used_at`: null, not recorded yet. */
export interface StandingRuleRow {
  rule: string;
  gate: string;
  tier: number;
  threshold: number;
  enabled: boolean;
  set_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_used_at: string | null;
}

/** A proposal to turn a rule on that no one has answered yet. */
export interface StandingProposalRow {
  id: string;
  rule: string;
  run_length: number;
  threshold: number;
  created_at: string;
}

/** `/api/v1/standing`: the rules and the pending proposals; `csrf_token` is null when the server has no write route. */
export interface StandingView {
  as_of: string;
  csrf_token: string | null;
  rules: StandingRuleRow[];
  proposals: StandingProposalRow[];
}

/** One ledger entry waiting for the owner's verdict on the Rules page (issue #571). */
export interface RuleRow {
  /** `C-…` for a candidate class, `P-…` for a structure proposal. */
  id: string;
  title: string;
  /** `open`, `pending` or `held`: the ledger's heading it is listed under. */
  state: string;
  /** The decision of a ledger verdict newer than the pending view: judged already, no verdict offered. Null: not judged. */
  judged: string | null;
  /** A class's draft (`evolve show`), which prefills Promote; null for a proposal, a judged entry or a failed read. */
  draft: { default: string; exception: string; incidents: string[]; scope: string } | null;
  /** Why a class's draft could not be read (Promote is off then), or null. */
  draft_error: string | null;
  /** A proposal's kind (`promote-learning`, `edit-asset`, `new-asset`) and the asset it changes, when the ledger lists them. */
  kind?: string;
  target?: string;
}

/** One entry's detail from `/api/v1/rules/entry?id=`; a field the ledger did not print is absent. */
export interface RuleDetail {
  id: string;
  default?: string;
  exceptions?: string;
  kind?: string;
  target?: string;
  incidents?: number;
  quotes?: string[];
  root_reason?: string;
  scope?: string;
}

/**
 * `/api/v1/rules/entry?id=`: `detail` null when the ledger gave none; `error` a failed read, or null. `retire`: an
 * applied class's reasons to retire it ([] for none), null for any other entry (absent from an older server).
 */
export interface RuleEntryView {
  id: string;
  detail: RuleDetail | null;
  error: string | null;
  retire?: string[] | null;
}

/** One retired class from the ledger's retire verdicts: the owner's reason and the day (YYYY-MM-DD). */
export interface RetiredRule {
  id: string;
  reason: string;
  date: string;
}

/** One promoted block of the rules file (Applied group); a part it lacks is null, an unparsable block has only `raw`. */
export interface AppliedRule {
  id: string | null;
  name: string | null;
  default: string | null;
  exceptions: string | null;
  scope: string | null;
  incidents: string[] | null;
  judged: string | null;
  raw: string | null;
}

/**
 * `/api/v1/rules`: `enabled` false when the tacit ledger is off; `judge` is why the viewer cannot send a verdict (or,
 * with the ledger off, turn it on), or null; `error` is a failed ledger read, or null. With the ledger off, `home` is
 * the agents home and the CLI missing there (null: found), and `turn_on` the `integrations` value that turns it on,
 * sent through POST /api/v1/settings; null when the viewer may not or the home is not found.
 */
export interface RulesView {
  enabled: boolean;
  entries: RuleRow[];
  /** The rules file's blocks and encoded-elsewhere lines; null with the ledger off. */
  applied: { rules: AppliedRule[]; elsewhere: string[] } | null;
  /** The retired classes, newest first; null with the ledger off (absent from an older server). */
  retired?: RetiredRule[] | null;
  error: string | null;
  csrf_token: string | null;
  judge: string | null;
  home: { path: string; missing: string | null } | null;
  turn_on: string | null;
}

export type RuleVerdict = "promote" | "reject" | "hold" | "retire";

/** One open plain task on the Tasks page (design 02-tasks, issue #607). */
export interface TaskRow {
  id: string;
  title: string;
  /** A free `#label`, without the `#`. */
  list: string | null;
  priority: number | null;
  /** `YYYY-MM-DD`, or null. */
  due_date: string | null;
  due_time: string | null;
  /** How long it takes, in minutes; null: planned as 30 minutes (absent from an older server). */
  duration_minutes?: number | null;
  recurrence: string | null;
  /** The work item Build this made from it, or null. */
  work_item_id: string | null;
  /** The task this is a sub-task of (one level), or null. */
  parent_task_id?: string | null;
  /** The slugs of its active task projects (absent from an older server). */
  projects?: string[];
}

/** An active task project, as the Tasks page's switcher and project dialog list it. */
export interface ProjectChoice {
  slug: string;
  name: string;
}

/**
 * A stored calendar event placed on one day beside the tasks (design 02-tasks, calendar views). `time`: the local
 * `HH:MM` it starts that day ("00:00" when it began earlier); null for an all-day event.
 */
export interface EventRow {
  kind: "event";
  source: string;
  id: string;
  title: string;
  all_day: boolean;
  time: string | null;
}

/** One entry of a day in Today and Upcoming: a task, or an event. */
export type DayRow = TaskRow | EventRow;

export const isEventRow = (r: DayRow): r is EventRow => "kind" in r && r.kind === "event";

/**
 * One block on today's timeline (design 02-tasks, schedule a task): a timed task, drawn its duration (30 minutes when
 * none is stored), or a read-only timed event. `offset`: minutes after midnight it starts; `minutes`: how long it is
 * drawn. `id`: the task's ID, or `<source>:<id>` for an event.
 */
export interface TimelineRow {
  kind: "task" | "event";
  id: string;
  title: string;
  start: string;
  end: string;
  offset: number;
  minutes: number;
}

/** A calendar source's last sync: when it last succeeded (null: never) and whether its last read failed. */
export interface CalendarSync {
  source: string;
  synced_at: string | null;
  failed: boolean;
}

/**
 * `/api/v1/tasks`: the open tasks placed by due date at the server's local midnight, with the stored calendar events
 * in Today and Upcoming (all-day first, then timed tasks and events by time, then untimed tasks); `calendar`, each
 * source's last sync (absent from an older server); `csrf_token` and `can_build` for Build this (null and false when
 * the page has no commands actor).
 */
export interface TasksView {
  today_date: string;
  inbox: TaskRow[];
  today: { overdue: TaskRow[]; due: DayRow[] };
  upcoming: { date: string; tasks: DayRow[] }[];
  /** The List tab: every open task under its #list. */
  projects: { list: string | null; tasks: TaskRow[] }[];
  /** The active task projects, by slug (absent from an older server). */
  active_projects?: ProjectChoice[];
  /** Today's timed tasks and events, placed by the server (absent from an older server). */
  timeline?: TimelineRow[];
  calendar?: CalendarSync[];
  csrf_token: string | null;
  can_build: boolean;
}

/** One done task in the Done tab: a task row with the time it was done. */
export interface DoneRow extends TaskRow {
  done_at: string;
}

/**
 * `/api/v1/tasks/done`: the done tasks of 30 days, most recently done first, all lists in one list (the last 30 days, or
 * the 30 days before `?before=`). `older`: a task was done before them; `next_before`: Show older's `before`.
 */
export interface DoneView {
  tasks: DoneRow[];
  older: boolean;
  next_before: string;
}

declare const __FACTORY_REV__: string | null | undefined;

/** The git revision built into this app (Vite `define`, web/vite.config.ts); null in a test or a build without git. */
export const WEB_REV: string | null = typeof __FACTORY_REV__ === "string" ? __FACTORY_REV__ : null;

/** One live worker process of `/api/v1/workers` (`processes`). `slots` 0 is a draining process. */
export interface WorkerProcess {
  process_id: string;
  pid: number;
  host: string;
  slots: number;
  max_slots: number;
  busy: number;
  idle: number;
  started_at: string;
  reported_at: string;
  runs: { id: string; kind: string; work_item_id: string; worker_id: string; started_at: string | null }[];
}

/** `/api/v1/workers`. `processes_error` is set when the processes could not be read. */
export interface WorkersView {
  as_of: string;
  workers: { owner: string; running: number }[];
  processes?: WorkerProcess[];
  processes_error?: string;
}

/** `/api/v1/failures`: failed runs of a window grouped by error code. */
export interface FailureRun {
  id: string;
  work_item_id: string;
  kind: string;
  attempt: number;
  detail: string;
  worker: string | null;
  finished_at: string | null;
}
export interface FailureGroup {
  code: string;
  /** Plain words for a known code; null for an unknown one. */
  description: string | null;
  count: number;
  last_seen: string | null;
  items: number;
  runs: FailureRun[];
}
export interface Failures {
  as_of: string;
  window: "24h" | "7d";
  cap: number;
  total: number;
  capped: boolean;
  groups: FailureGroup[];
}

/** `/api/v1/spend`: cost and tokens of the agent runs per UTC day and per item. `unknown`: runs with no stored cost, never added as 0. */
export interface SpendTotals {
  cost_usd: number;
  tokens: number;
  runs: number;
  unknown: number;
}
export interface SpendDay extends SpendTotals { day: string }
export interface SpendItem extends SpendTotals {
  work_item_id: string;
  title: string | null;
  kinds: string[];
}
export interface SpendView {
  as_of: string;
  /** Today's UTC day and the Monday its week began (YYYY-MM-DD). */
  today: string;
  week_start: string;
  from: string;
  to: string;
  total: SpendTotals;
  days: SpendDay[];
  /** By cost, highest first; at most a cap of them, `items_total` in all. */
  items: SpendItem[];
  items_total: number;
}

export const API = {
  // The app's own revision goes along, so the server lists a mismatch in Needs you.
  overview: WEB_REV ? `/api/v1/overview?rev=${encodeURIComponent(WEB_REV)}` : "/api/v1/overview",
  items: "/api/v1/items",
  /** The items read, kept to the work items whose source task is in that task project when `project` is a slug. */
  itemsIn: (project: string | null) => (project === null ? "/api/v1/items" : `/api/v1/items?project=${encodeURIComponent(project)}`),
  item: (id: string) => `/api/v1/items/${encodeURIComponent(id)}`,
  itemCommands: (id: string) => `/api/v1/items/${encodeURIComponent(id)}/commands`,
  session: "/api/v1/session",
  transcript: (id: string, run: string, params: URLSearchParams) => {
    const q = params.toString();
    return `/api/v1/items/${encodeURIComponent(id)}/runs/${encodeURIComponent(run)}/transcript${q ? `?${q}` : ""}`;
  },
  runs: "/api/v1/runs",
  queue: "/api/v1/queue",
  workers: "/api/v1/workers",
  health: "/api/v1/health",
  failures: (window: string) => `/api/v1/failures?window=${window}`,
  spend: "/api/v1/spend",
  unreviewedMerges: "/api/v1/unreviewed-merges",
  settings: "/api/v1/settings",
  capabilities: "/api/v1/settings/capabilities",
  pauses: "/api/v1/pauses",
  resume: "/api/v1/pauses/resume",
  standing: "/api/v1/standing",
  rules: "/api/v1/rules",
  ruleVerdict: "/api/v1/rules/verdict",
  ruleEntry: (id: string) => `/api/v1/rules/entry?id=${encodeURIComponent(id)}`,
  tasks: "/api/v1/tasks",
  /** The open tasks' read, filtered to one task project's tasks when `project` is a slug. */
  tasksIn: (project: string | null) => (project === null ? "/api/v1/tasks" : `/api/v1/tasks?project=${encodeURIComponent(project)}`),
  projects: "/api/v1/projects",
  taskProject: "/api/v1/tasks/project",
  tasksDone: (before: string | null) => (before === null ? "/api/v1/tasks/done" : `/api/v1/tasks/done?before=${encodeURIComponent(before)}`),
  calendar: "/api/v1/calendar",
  calendarConnect: "/api/v1/calendar/connect",
  calendarDisconnect: "/api/v1/calendar/disconnect",
  taskBuild: "/api/v1/tasks/build",
  taskAction: (action: TaskAction) => `/api/v1/tasks/${action}`,
  dataTables: "/api/v1/data/tables",
  dataAutonomy: "/api/v1/data/autonomy",
  dataAsk: "/api/v1/data/ask",
  dataTable: (name: string, params: URLSearchParams) => {
    const q = params.toString();
    return `/api/v1/data/tables/${encodeURIComponent(name)}${q ? `?${q}` : ""}`;
  },
} as const;

/** Polling interval while the document is visible; TanStack Query stops it while the tab is hidden. */
export const POLL_MS = 3000;

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** One API read, polled every POLL_MS while the document is visible. */
export function useApi<T>(url: string, pollMs: number | false = POLL_MS) {
  return useQuery({
    queryKey: [url],
    queryFn: () => getJson<T>(url),
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
  });
}

/**
 * The items read, polled as useApi is; `project` keeps the work items built from that task project's tasks. Its key
 * starts with the items' key, so a command's reload of the items reloads it whatever the filter.
 */
export function useItems(project: string | null) {
  return useQuery({
    queryKey: project === null ? [API.items] : [API.items, "project", project],
    queryFn: () => getJson<Items>(API.itemsIn(project)),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/**
 * The open tasks' read, polled as useApi is; `project` filters it to that task project's tasks. Its key starts with the
 * tasks' key, so a row action's reload of the tasks reloads it whatever the filter.
 */
export function useTasks<T>(project: string | null) {
  const url = API.tasksIn(project);
  return useQuery({
    queryKey: [API.tasks, "open", project],
    queryFn: () => getJson<T>(url),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/**
 * The Done tab's read: the last 30 days, then a page per Show older. Its key starts with the tasks' key, so a row
 * action's reload of the tasks (a completion, a reopen) reloads it too. Not polled.
 */
export function useDoneTasks() {
  return useInfiniteQuery({
    queryKey: [API.tasks, "done"],
    queryFn: ({ pageParam }) => getJson<DoneView>(API.tasksDone(pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last: DoneView) => (last.older ? last.next_before : undefined),
  });
}

/**
 * One entry's detail, read once when `enabled` turns true (a card opens, or Suggest is pressed), never polled. Each
 * `round` (a Suggest press) reads it again, and the last round's answer stays shown while the next one loads.
 */
export function useRuleEntry(id: string, enabled: boolean, round = 0) {
  const url = API.ruleEntry(id);
  return useQuery({ queryKey: [url, round], queryFn: () => getJson<RuleEntryView>(url), enabled, staleTime: Infinity, placeholderData: keepPreviousData });
}

/** A JSON POST with the CSRF token: the status and the parsed body ({} when the body is not JSON). */
async function postJson<T extends { error?: string }>(url: string, token: string, body: unknown): Promise<{ ok: boolean; status: number; value: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": token },
    body: JSON.stringify(body),
  });
  let value = {} as T;
  try {
    value = (await res.json()) as T;
  } catch {
    // An error without a JSON body: the caller says the status.
  }
  return { ok: res.ok, status: res.status, value };
}

/** POST /api/v1/settings: a set, reset or edit-file, with the CSRF token. A refusal comes back as `{ ok: false, error }`. */
export async function postSettings(token: string, body: SettingsWrite): Promise<WriteResult> {
  const r = await postJson<{ ok?: boolean; lines?: string[]; error?: string; item?: string; branch?: string }>(API.settings, token, body);
  if (r.ok && r.value.ok) {
    const { item, branch } = r.value;
    return { ok: true, lines: r.value.lines ?? [], ...(item !== undefined && branch !== undefined ? { filed: { item, branch } } : {}) };
  }
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/**
 * POST /api/v1/items/:id/commands: `{ command, note }`, the note only when it has text; a proposal's Confirm all or
 * Cancel sends `{ command, proposal }` instead. 202 → the request's seq.
 */
export async function postCommand(token: string, id: string, command: string, note: string, proposal?: string): Promise<CommandResult> {
  const text = note.trim();
  const body = proposal !== undefined ? { command, proposal } : text ? { command, note: text } : { command };
  const r = await postJson<{ seq?: number; error?: string }>(API.itemCommands(id), token, body);
  if (r.ok) return { ok: true, seq: r.value.seq ?? 0 };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** POST /api/v1/pauses/resume: ends one pause now. A refusal (403, 400, …) comes back as `{ ok: false, error }`. */
export async function postResume(token: string, name: string): Promise<{ ok: true; ended: boolean } | { ok: false; error: string }> {
  const r = await postJson<{ ended?: boolean; error?: string }>(API.resume, token, { name });
  if (r.ok) return { ok: true, ended: r.value.ended === true };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** POST /api/v1/standing: a rule on or off, naming the proposal it answers if any. A refusal comes back as `{ ok: false, error }`. */
export async function postStanding(
  token: string,
  body: { rule: string; enabled: boolean; proposal?: string },
): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const r = await postJson<{ changed?: boolean; error?: string }>(API.standing, token, body);
  if (r.ok) return { ok: true, changed: r.value.changed === true };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** POST /api/v1/rules/verdict: a verdict with its reason, and for promote of a class (C-) the owner's wording, default and exception (retire takes none). */
export async function postRuleVerdict(
  token: string,
  body: { id: string; verdict: RuleVerdict; reason: string; text?: string; default?: string; exception?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(API.ruleVerdict, token, body);
  if (r.ok) return { ok: true };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** POST /api/v1/tasks/build: Build this. The work item's ID; a refusal (409, 503, …) comes back as `{ ok: false, error }`. */
export async function postTaskBuild(token: string, id: string): Promise<{ ok: true; work_item_id: string } | { ok: false; error: string }> {
  const r = await postJson<{ work_item_id?: string; error?: string }>(API.taskBuild, token, { id });
  if (r.ok) return { ok: true, work_item_id: r.value.work_item_id ?? "" };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** POST /api/v1/tasks: quick-add words under the page's own `tk_` ID (a resend stores one task). A refusal comes back as `{ ok: false, error }`. */
export async function postTaskAdd(token: string, id: string, words: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(API.tasks, token, { id, words });
  return r.ok ? { ok: true } : { ok: false, error: r.value.error ?? `HTTP ${r.status}` };
}

/** POST /api/v1/projects: a new task project under the page's own `pj_` ID (a resend stores nothing more). A refusal comes back as `{ ok: false, error }`. */
export async function postProject(token: string, id: string, name: string): Promise<{ ok: true; project: ProjectChoice } | { ok: false; error: string }> {
  const r = await postJson<{ project?: ProjectChoice; error?: string }>(API.projects, token, { id, name });
  if (r.ok && r.value.project) return { ok: true, project: r.value.project };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** POST /api/v1/tasks/project: adds the task to the project (`add`) or removes it. A refusal comes back as `{ ok: false, error }`. */
export async function postTaskProject(token: string, id: string, project: string, add: boolean): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const r = await postJson<{ changed?: boolean; error?: string }>(API.taskProject, token, { id, project, add });
  return r.ok ? { ok: true, changed: r.value.changed ?? false } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** One calendar plugin on the Settings page's Calendar section (GET /api/v1/calendar, design 08-settings). */
export interface CalendarPluginView {
  /** The plugin's own name, its only label. */
  name: string;
  /** Listed in the live `calendar` setting (else the config file's key). */
  connected: boolean;
  synced_at: string | null;
  /** The last sync's error; null after a success. */
  error: string | null;
  /** The sign-in this server process started, if any. */
  attempt: { state: "signing_in" | "connected" | "failed"; events: number | null; error: string | null } | null;
}

export interface CalendarView {
  plugins: CalendarPluginView[];
}

/** What POST /api/v1/calendar/connect answered: the inputs to ask for, the consent page to open, or a refusal. */
export type CalendarConnectResult =
  | { ok: true; state: "needs_input"; needs: string[] }
  | { ok: true; state: "signing_in"; consent_url: string }
  | { ok: true; state: "connected" | "failed"; events: number | null }
  | { ok: false; error: string };

/** POST /api/v1/calendar/connect: the plugin, and the values the last answer asked for (none on the first try). */
export async function postCalendarConnect(token: string, plugin: string, values?: Record<string, string>): Promise<CalendarConnectResult> {
  const r = await postJson<{ state?: string; needs?: string[]; consent_url?: string; events?: number | null; error?: string }>(
    API.calendarConnect, token, values === undefined ? { plugin } : { plugin, values },
  );
  if (!r.ok) return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
  const v = r.value;
  if (v.state === "needs_input") return { ok: true, state: "needs_input", needs: v.needs ?? [] };
  if (v.state === "signing_in") return { ok: true, state: "signing_in", consent_url: v.consent_url ?? "" };
  return { ok: true, state: v.state === "failed" ? "failed" : "connected", events: v.events ?? null };
}

/** POST /api/v1/calendar/disconnect. A refusal comes back as `{ ok: false, error }`. */
export async function postCalendarDisconnect(token: string, plugin: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(API.calendarDisconnect, token, { plugin });
  return r.ok ? { ok: true } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** A Tasks page row action: the path segment of its route. */
export type TaskAction = "edit" | "done" | "reopen" | "delete" | "sub" | "schedule";

/**
 * POST /api/v1/tasks/<action>: a row action (edit `{ id, words }`, done and delete `{ id }`, sub `{ parent, id, words }`),
 * ⌘Z's undo of a completion (reopen `{ id }`), or a drop on the timeline (schedule `{ id, date, time }`).
 * A refusal (400, 404, 409, …) comes back as `{ ok: false, error }` with the server's reason.
 */
export async function postTaskAction(token: string, action: TaskAction, body: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(API.taskAction(action), token, body);
  return r.ok ? { ok: true } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** POST /api/v1/data/ask: one plain-text question (design 09-dashboard-app, Data page Ask). */
export async function postDataAsk(token: string, question: string): Promise<DataAskResult> {
  const r = await postJson<{ error?: string; sql?: string; columns?: string[]; rows?: DataCell[][]; truncated?: boolean; answer?: string | null }>(API.dataAsk, token, { question });
  const v = r.value;
  if (r.ok) return { ok: true, sql: v.sql ?? "", columns: v.columns ?? [], rows: v.rows ?? [], truncated: v.truncated === true, answer: v.answer ?? null };
  return { ok: false, sql: v.sql ?? null, error: v.error ?? t("api.http", { status: r.status }) };
}

/**
 * One API read that never refetches on its own: no interval, no refetch on focus, mount or reconnect. Only the
 * Refresh button (which invalidates every query) reads it again. For the Data page, whose reads are heavier.
 */
export function useManualApi<T>(url: string | null) {
  return useQuery({
    queryKey: [url],
    queryFn: () => getJson<T>(url!),
    enabled: url !== null,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
  });
}
