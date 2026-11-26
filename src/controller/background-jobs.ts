// The background jobs (design 08-schedules-actions): every action the factory takes on its own, with the Activity
// kind and the system actor ID of the `controller_activity` rows it writes, and where it writes them. The guard test
// (phase 2) reads this list; the Activity page (phase 3) groups rows by actor. Imports nothing, so the store and the
// units both read it.

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
  { job: "cleanup", kind: "cleanup", actor_id: "system:cleanup", writes: "controller/units/cleanup/cleanup.unit.ts: one row per pass that removed or failed on a resource" },
  { job: "auto-grant", kind: "auto_grant", actor_id: "system:auto-grant", writes: "controller/units/run-results/auto-grant.ts: the grant's transition `activity`, in its transaction" },
  { job: "schedule", kind: "schedule_run", actor_id: "system:schedule", writes: "impl/store/sql/schedules.ts: one row per claimed occurrence, in the claim's transaction" },
  { job: "supervisor", kind: "restart", actor_id: "system:supervisor", writes: "supervisor.ts: runDevChild, one row per supervised child start" },
  { job: "migrations", kind: "migration", actor_id: "system:migrate", writes: "impl/store/sql/activity.ts: migrationActivity, one row per migration applied on open or by npm run migrate" },
] as const satisfies readonly BackgroundJob[];

export type ActivityKind = (typeof BACKGROUND_JOBS)[number]["kind"];

/** The actor ID of `kind`'s rows. */
export function activityActor(kind: ActivityKind): string {
  return BACKGROUND_JOBS.find((j) => j.kind === kind)!.actor_id;
}

/** Days a `controller_activity` row is kept (owner answer, 2026-11-26): the retention pass's history class deletes older rows. */
export const ACTIVITY_RETENTION_DAYS = 30;
