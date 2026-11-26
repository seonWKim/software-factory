// The background jobs (design 08-schedules-actions): every action the factory takes on its own, with the Activity
// kind and the system actor ID of the `controller_activity` rows it writes, and where it writes them. The guard test
// (phase 2) reads this list; the Activity page (phase 3) groups rows by actor. Imports nothing (dependency-direction).
// The store, which may not import the controller (kinds R1), keeps its own actor map for the kinds it writes
// (src/impl/store/sql/activity.ts STORE_ACTORS), which its type checks against this list.

/** One background job: its name, its Activity kind, its actor ID (an ID, never a display name) and its writer. */
export interface BackgroundJob {
  readonly job: string;
  readonly kind: string;
  readonly actor_id: string;
  /** The src/ file that writes its Activity rows, and how. */
  readonly writes: string;
}

export const BACKGROUND_JOBS = [
  { job: "reaper", kind: "lease_expiry", actor_id: "system:reaper", writes: "impl/store/sql/sql-factory-store.ts: expireLeases, one row per run the expiry moved, in its transaction" },
  { job: "retention", kind: "retention", actor_id: "system:retention", writes: "impl/store/sql/activity.ts: prunedWithActivity, one row per batch that deleted rows, in its transaction" },
  { job: "cleanup", kind: "cleanup", actor_id: "system:cleanup", writes: "controller/units/cleanup/cleanup.unit.ts: recordPass, one row per pass that removed or failed on a resource, after it (the removals are on disk)" },
  { job: "auto-grant", kind: "auto_grant", actor_id: "system:auto-grant", writes: "controller/units/run-results/auto-grant.ts: the grant's transition `activity`, in its transaction" },
  { job: "schedule", kind: "schedule_run", actor_id: "system:schedule", writes: "impl/store/sql/schedules.ts: recordClaim, one row per claimed occurrence with its run row's reason and ref, in the claim's transaction" },
  { job: "supervisor", kind: "restart", actor_id: "system:supervisor", writes: "impl/store/sql/worker-health.ts: recordChildRestart, one row per new restart the supervisor's status file lists, in its insert's transaction" },
  { job: "coordinator", kind: "coordinator", actor_id: "system:coordinator", writes: "coordinator.unit.ts: the cycle's activity port (recordActivity), one row per cycle that called the agent, its cost in the reason, after its new spend row" },
  { job: "migrations", kind: "migration", actor_id: "system:migrate", writes: "impl/store/sql/activity.ts: migrateWithActivity, one row per migration applied on open or by npm run migrate" },
] as const satisfies readonly BackgroundJob[];

export type ActivityKind = (typeof BACKGROUND_JOBS)[number]["kind"];

/** The actor ID of `kind`'s job: the store's actor map is typed against it. */
export type ActorOf<K extends ActivityKind> = Extract<(typeof BACKGROUND_JOBS)[number], { kind: K }>["actor_id"];

/** An Activity row a unit writes (the store's NewActivity): `kind` with its job's actor ID. */
export interface JobActivity { actor_id: string; kind: ActivityKind; subject: string; outcome: string; reason: string; ref: string | null }

/** A row of `kind` with its job's actor ID. */
export function activityOf(kind: ActivityKind, a: Omit<JobActivity, "kind" | "actor_id">): JobActivity {
  return { actor_id: BACKGROUND_JOBS.find((j) => j.kind === kind)!.actor_id, kind, ...a };
}

// The two reference formats a unit writes; the store's copies (src/impl/store/sql/activity.ts) give the same text,
// which tests/background-jobs.test.ts checks.
/** A run's transcript path, as the dashboard's transcript route serves it. */
export const transcriptRef = (work_item_id: string, run_id: string): string => `/api/v1/items/${work_item_id}/runs/${run_id}/transcript`;
/** A log reference: the component's log and the message of the line the action wrote. */
export const logRef = (component: string, message: string): string => `log:${component}:${message}`;
