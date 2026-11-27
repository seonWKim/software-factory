// What a schedule action works through (design 08-schedules): the routes the selected ScheduleAction dispatcher
// (`routed`, src/impl/schedule-action/) hands each fired occurrence to, one per action kind, and the ports it binds
// to the store, the agent runner and the egress scanner. Types only: the action folders beside this file import
// nothing outside the controller, and compose passes them to the dispatcher.

/** The schedule as an action reads it. */
export interface ActionSchedule {
  id: string;
  title: string;
  /** The action's settings as stored (JSON): each action reads and checks its own. */
  settings: Readonly<Record<string, unknown>>;
}

/** One read-only agent call (Read, Glob and Grep only), its result scanned before it reaches the action. */
export interface AgentAnswer {
  /** The runner's status; `completed` is the only success. */
  status: string;
  /** The structured answer, when the call was given a schema and completed; scanned (null when the scan flagged it). */
  output: unknown;
  /** The answer as text for the run's output: the structured answer as JSON, else the transcript, scanned. */
  text: string;
  /** What the call used: every token counted, and the harness's cost (null when it gave none). */
  tokens: number;
  cost_usd: number | null;
  error?: string;
}

export interface ActionPorts {
  /** The occurrence as a source ID, `schedule-<schedule id>-<slot>`: an action files its items under it, so a retry files none twice. */
  readonly occurrence_id: string;
  /**
   * Files one local work item with its triage run queued, idempotent on `source_id`: a second call returns the same
   * item with `created` false. Null when the egress scan flagged its title or body, and nothing was filed.
   */
  fileItem(i: { source_id: string; title: string; body: string }): Promise<{ id: string; created: boolean } | null>;
  /**
   * Runs one agent call on `prompt` in a fresh read-only checkout, with the output schema if given. With `run` (a
   * schedule's grants as handed out): in its repo, with its tools and writable paths, its grants told to the agent.
   */
  ask(i: { prompt: string; output_schema?: Readonly<Record<string, unknown>>; run?: GrantedAgentRun }): Promise<AgentAnswer>;
  /** Stores the occurrence's output and adds its tokens and cost to its run row. */
  record(r: { output: string; tokens: number; cost_usd: number | null }): Promise<void>;
}

/** One agent tool: a ToolSpec of src/core/tools, named by shape so this file imports nothing outside the controller. */
export interface AgentTool { readonly name: string; readonly capability: "read" | "write" | "exec" }

/** A schedule's grants as ScheduleGrantBroker handed them out (src/core/schedule-grants.ts): what its agent run gets. */
export interface GrantedAgentRun {
  /** The read-only tools, then each granted one (Browse on the sandbox URL, Write and Edit in the notes folder). */
  tools: readonly AgentTool[];
  /** The repo the run checks out, and its base: the factory repo's, or the granted repo's. */
  repo: string;
  base_ref: string;
  /** The notes folder, when granted. */
  writable_paths: readonly string[];
  /** The broker tools granted (the shell grant's read-only sqlite3), served through the runner's tool bridge. */
  tool_grants: readonly string[];
  /** Each grant in plain words. */
  granted: readonly string[];
}

/** Checks and hands out a schedule's grants, or null when it has none; throws on a refused grant. Compose binds it to ScheduleGrantBroker. */
export type GrantHandOut = (schedule: ActionSchedule) => Promise<GrantedAgentRun | null>;

/**
 * Queues the daily improve run of the UTC day of the slot `occurrence_at`, keyed `improve:<project>:daily:<day>` as
 * the controller's daily step keys it, so a second call for that day queues none. Compose binds it to the store.
 */
export type DailyImproveQueue = (occurrence_at: string) => Promise<{ run: { id: string; idempotency_key: string }; created: boolean }>;

/**
 * Queues the `routine` run of Check a page schedule `schedule_id` for the slot `occurrence_at` on the routine's carrier
 * item, keyed on the slot, so a second call queues none and returns the same run with `created` false. Compose binds
 * it to the store (queueRoutineRun, src/core/routines.ts).
 */
export type RoutineQueue = (schedule_id: string, occurrence_at: string) => Promise<{ run: { id: string; idempotency_key: string }; created: boolean }>;

/** One summary slot (design 08-schedules-actions): the morning or the evening post of a local date. */
export type SummarySlotName = "morning" | "evening";
/** The window one summary covers: from the slot before it (`since`) to its own time (`until`), ISO times. */
export interface SummaryWindow { slot: SummarySlotName; since: string; until: string; exclude_schedule: string }
/** A summary's button: the command its line asks for, on its item (null: open the item). */
export interface SummaryButton { work_item_id: string; label: string; command: string | null }

/**
 * What the summary action works through; compose binds it (summaryDeps, src/core/summary.ts, which matches it by
 * shape: core imports nothing outside core). `times` reads both time settings now (each run), `build` the window's
 * summary from the store (null: nothing to report), `scan` the egress scanner's findings (empty: clean), `post` one
 * outbound delivery on the owner's chat, keyed on `key`: a key already stored stores nothing (`created` false).
 * `post` throws while the channel is down.
 */
export interface SummaryDeps {
  times(): Promise<{ morning: string; evening: string }>;
  build(w: SummaryWindow): Promise<{ text: string; buttons: readonly SummaryButton[] } | null>;
  scan(text: string): Promise<readonly string[]>;
  post(d: { key: string; text: string; buttons: readonly SummaryButton[] }): Promise<{ created: boolean }>;
}

/** One action: runs a fired occurrence of `schedule`, due at `occurrence_at`. Safe to run twice for one occurrence. */
export type ScheduleActionRoute = (schedule: ActionSchedule, occurrence_at: string, ports: ActionPorts) => Promise<void>;

/** One route per action kind (src/core/schedule.ts ScheduleActionKind). */
export type ScheduleActionRoutes = Readonly<Record<"build" | "agent" | "feedback" | "improve" | "check_page" | "summary", ScheduleActionRoute>>;
