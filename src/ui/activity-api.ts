// The Activity read (design 09-dashboard-activity, over 08-schedules-actions): GET /api/v1/activity, declared once as
// the `activity.actors` capability (src/api/capabilities/activity.ts) and called by the dashboard and the chat through
// the generated client. One entry per autonomous actor (BACKGROUND_JOBS), each with its name in plain words, what it
// does now, its last and next run, and its recent actions (the `controller_activity` rows of its actor ID, newest
// first, none older than ACTIVITY_RETENTION_DAYS), each with its outcome, reason and a Transcript or log link; and the
// factory's open alerts, which the owner clears with the alarm dismissal route. Reads only; the store prunes the rows.

import { BACKGROUND_JOBS, type ActivityKind } from "../controller/background-jobs.js";
import { ACTIVITY_RETENTION_DAYS } from "../impl/store/sql/activity.js";
import type { Activity } from "../interfaces/factory-store.js";
import { openAlarms, alarmText } from "./alarms.js";
import type { UiDeps } from "./deps.js";

const DAY_MS = 86_400_000;
/** Recent actions shown per actor. */
export const RECENT_PER_ACTOR = 10;
/** Rows read once for every actor (the store's own cap). */
const READ_LIMIT = 200;

/** An actor's words: its name, what it does, and what it says while it has no action to show. */
export interface ActorWords { name: string; about: string; idle: string }

/** Every job's Activity mapping, in plain words. The guard test (tests/design-system.test.ts) fails for a job missing here. */
export const ACTOR_WORDS: Readonly<Record<ActivityKind, ActorWords>> = {
  lease_expiry: { name: "Run reaper", about: "Takes back a run whose worker stopped sending heartbeats.", idle: "Watching for runs that stopped" },
  retention: { name: "Tidy-up of old records", about: "Deletes records older than their keeping time.", idle: "Waiting for records to age out" },
  cleanup: { name: "Workspace cleanup", about: "Removes workspaces and files nothing uses any more.", idle: "Waiting for something to clean up" },
  auto_grant: { name: "Auto-approval", about: "Approves a change by itself when the rules allow it.", idle: "Waiting for a change to approve" },
  schedule_run: { name: "Schedules", about: "Starts the work of each schedule when its time comes.", idle: "Waiting for the next slot" },
  restart: { name: "Supervisor", about: "Restarts a part of the factory that stopped.", idle: "Every part is running" },
  migration: { name: "Data migrations", about: "Brings stored data up to the current version.", idle: "Data is up to date" },
};

export type ActionLink = { kind: "transcript" | "log"; href: string | null; text: string };

/** The link an action's reference gives: a run's transcript (a path), else the log line it names, else none. */
export function linkOf(ref: string | null): ActionLink | null {
  if (ref === null) return null;
  const run = /^\/api\/v1\/items\/([^/]+)\/runs\/([^/]+)\/transcript$/.exec(ref);
  if (run) return { kind: "transcript", href: `/app/items/${run[1]}/runs/${run[2]}`, text: ref };
  const log = /^log:([^:]+):(.*)$/.exec(ref);
  if (log) return { kind: "log", href: null, text: `${log[1]}: ${log[2]}` };
  return { kind: "log", href: null, text: ref };
}

const actionOf = (a: Activity) => ({ seq: a.seq, kind: a.kind, subject: a.subject, outcome: a.outcome, reason: a.reason, at: String(a.at), link: linkOf(a.ref) });

/** What the schedule actor shows live, from the stored schedules: what is running, and the earliest next run. */
async function scheduleState(d: Pick<UiDeps, "store">): Promise<{ running: string | null; next: string | null }> {
  const all = await d.store.listSchedules();
  const next = all.flatMap((s) => (s.next_due_at === null ? [] : [String(s.next_due_at)])).sort()[0] ?? null;
  return { running: all.find((s) => s.running_since !== null)?.title ?? null, next };
}

/** GET /api/v1/activity: the actors, each with its recent actions, and the open alerts. */
export async function readActivity(d: Pick<UiDeps, "store" | "clock">) {
  const now = d.clock.now();
  const since = new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * DAY_MS).toISOString();
  // One read for every actor; rows past the retention window are cut here, whether or not the retention pass has run.
  const rows = (await d.store.listActivity({ limit: READ_LIMIT })).filter((a) => String(a.at) >= since);
  const sched = await scheduleState(d);
  const actors = BACKGROUND_JOBS.map((job) => {
    const words = ACTOR_WORDS[job.kind];
    const mine = rows.filter((a) => a.actor_id === job.actor_id);
    const last = mine[0] ?? null;
    const running = job.kind === "schedule_run" ? sched.running : null;
    const state: "idle" | "running" | "attention" = running !== null ? "running" : last !== null && /fail/.test(last.outcome) ? "attention" : "idle";
    return {
      actor_id: job.actor_id, name: words.name, about: words.about,
      state, now: running !== null ? `Running ${running}` : words.idle,
      last_at: last === null ? null : String(last.at), next_run_at: job.kind === "schedule_run" ? sched.next : null,
      transcript: last === null ? null : linkOf(last.ref),
      actions: mine.slice(0, RECENT_PER_ACTOR).map(actionOf),
    };
  });
  const alerts = (await openAlarms(d.store, now)).map((a) => ({ alert_id: a.id, text: alarmText(a), created_at: String(a.created_at) }));
  return { as_of: now.toISOString(), retention_days: ACTIVITY_RETENTION_DAYS, actors, alerts };
}
