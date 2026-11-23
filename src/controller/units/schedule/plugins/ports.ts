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
  /** Runs one agent call on `prompt` in a fresh read-only checkout, with the output schema if given. */
  ask(i: { prompt: string; output_schema?: Readonly<Record<string, unknown>> }): Promise<AgentAnswer>;
  /** Stores the occurrence's output and adds its tokens and cost to its run row. */
  record(r: { output: string; tokens: number; cost_usd: number | null }): Promise<void>;
}

/** One action: runs a fired occurrence of `schedule`, due at `occurrence_at`. Safe to run twice for one occurrence. */
export type ScheduleActionRoute = (schedule: ActionSchedule, occurrence_at: string, ports: ActionPorts) => Promise<void>;

/** One route per action kind (src/core/schedule.ts ScheduleActionKind). */
export type ScheduleActionRoutes = Readonly<Record<"build" | "agent" | "feedback", ScheduleActionRoute>>;
