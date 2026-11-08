// System actions in Needs you (design §9 Status page, issue #311): what the factory needs from the operator
// besides a work item. A pending migration, a GitHub token that expires within 3 days, a claim pause or a
// worker pause in effect, a claim deadlock, an open alarm, and a dashboard or UI server that runs another
// revision than it should. Each names the command that clears it (an alarm: where to look into it). Store reads and in-process values only: the overview poll
// asks GitHub nothing (the token's days come from this process's last health run).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Run, WorkItemId } from "../core/types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { MIGRATION_PENDING } from "../interfaces/updater.js";
import { type Check, TOKEN_WARN_DAYS } from "../setup.js";
import type { FactoryStatus } from "./factory-status.js";
import { alarmCommand, alarmText, alarmUntil, openAlarms } from "./alarms.js";
import { activePauses } from "./pause-api.js";
import { deadlocked } from "./why.js";

export type SystemActionCode = "migration_pending" | "token_expiring" | "claim_pause" | "worker_pause" | "claim_deadlock" | "alarm" | "revision_mismatch";

export interface SystemAction {
  code: SystemActionCode;
  /** One sentence; may carry store text (a deadlock's holder), so the API passes it through the Withholder. */
  text: string;
  /** What clears it, as the operator types it. */
  command: string;
  /** When it ends by itself (a claim pause's end, model_stall's next probe, an alarm's close), else null. */
  until: string | null;
  /** The item it is about (a deadlock), else null. */
  work_item_id: WorkItemId | null;
}

/**
 * The checks of this process's last health run, kept as they finished: Needs you reads the token's days from
 * them, so a poll never asks GitHub. In-process on purpose, like HealthMonitor's own rate limit: another
 * replica runs its own checks, and one with no run yet says `unknown`.
 */
export class LastChecks {
  private last: readonly Check[] | null = null;

  /** `run`, recording each result it returns. */
  wrap(run: () => Promise<Check[]>): () => Promise<Check[]> {
    return async () => {
      const checks = await run();
      this.last = checks;
      return checks;
    };
  }

  /** Days left on the GitHub token from the last run; `unknown` before any run; null when it had no expiry check. */
  tokenDays(): number | "unknown" | null {
    if (this.last === null) return "unknown";
    return this.last.find((c) => c.token_days !== undefined)?.token_days ?? null;
  }
}

/** What the overview needs for system actions beside the store. Each absent value lists nothing. */
export interface SystemDeps {
  /** The git revision this UI server's code was started from (`serverRevision`); null: unknown. */
  revision?: string | null;
  /** The last health run of this process. */
  lastChecks?: LastChecks;
}

/** `git rev-parse HEAD` in `root`: the revision the server runs. Null when git cannot say. */
export async function serverRevision(root: string): Promise<string | null> {
  try {
    const r = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5000 });
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Why a `factory ui` started by hand must stop (design 08 Self-update): the factory runs a newer commit than this
 * server (`serverRev` is an ancestor of `factoryRev` in `root`). Null when it may keep serving: either revision is
 * unknown, they are equal, or git cannot order them (another branch, a commit this checkout lacks).
 */
export async function olderThanFactory(root: string, serverRev: string | null, factoryRev: string | null): Promise<string | null> {
  if (serverRev === null || factoryRev === null || serverRev === factoryRev) return null;
  try {
    await promisify(execFile)("git", ["merge-base", "--is-ancestor", serverRev, factoryRev], { cwd: root, timeout: 5000 });
  } catch {
    return null;
  }
  return `factory ui: this page runs ${short(serverRev)}, the factory runs the newer ${short(factoryRev)}; stopping so it never serves old code. ` +
    "Under git-worktree open the page `factory dev` serves; otherwise rebuild and start `factory ui` again.";
}

/** A revision the dashboard sends (`?rev=`): a hex commit id, else ignored. */
export function parseRevision(raw: string | null): string | null {
  return raw !== null && /^[0-9a-f]{7,40}$/.test(raw) ? raw : null;
}

const short = (rev: string) => rev.slice(0, 7);

export interface SystemInput {
  store: FactoryStore;
  /** The running and queued runs the overview already read. */
  active: readonly Run[];
  /** The supervisor's status; absent or null: none. */
  factory: FactoryStatus | null | undefined;
  deps: SystemDeps;
  /** The overview's now: an alarm is open inside its window before it. */
  now: Date;
  /** The revision built into the dashboard that polls, when it sent one. */
  dashboardRev: string | null;
}

/** Every system action in effect, in a fixed order: migration, token, pauses, deadlocks, alarms, revisions. */
export async function systemActions(x: SystemInput): Promise<SystemAction[]> {
  const out: SystemAction[] = [];
  const add = (code: SystemActionCode, text: string, command: string, until: string | null = null, work_item_id: WorkItemId | null = null) =>
    out.push({ code, text, command, until, work_item_id });

  const migration = await pendingMigration(x.store, x.factory);
  if (migration) add("migration_pending", migration, "npm run migrate");

  const days = x.deps.lastChecks?.tokenDays() ?? null;
  if (typeof days === "number" && days < TOKEN_WARN_DAYS) {
    add("token_expiring", days <= 0 ? "The GitHub token has expired or expires today" : `The GitHub token expires in ${days} day${days === 1 ? "" : "s"}`, "npm run setup -- --rotate-github");
  }

  for (const p of await activePauses(x)) {
    const what = p.name === "model_stall" ? `next probe at ${p.ends_at}` : `until ${p.ends_at}`;
    add("claim_pause", `Claim pause ${p.name} in effect, ${what}`, `factory resume ${p.name}`, p.ends_at);
  }
  const workerPauses = await x.store.listWorkerPauses();
  if (workerPauses.length > 0) {
    add("worker_pause", `${workerPauses.length} worker pause${workerPauses.length === 1 ? "" : "s"} in effect (factory workers pause)`, "factory workers resume");
  }

  for (const d of await deadlocks(x.store, x.active)) {
    add("claim_deadlock", `Started past a deadlock with ${d.holder_ref}: a person checks the overlap`, `factory status ${d.id}`, null, d.id);
  }

  for (const a of await openAlarms(x.store, x.now)) {
    add("alarm", a.detail === null ? alarmText(a) : `${alarmText(a)}: ${a.detail}`, alarmCommand(a), alarmUntil(a));
  }

  const server = x.deps.revision ?? null;
  if (server !== null && x.dashboardRev !== null && x.dashboardRev !== server) {
    add("revision_mismatch", `Dashboard out of date: it was built from ${short(x.dashboardRev)}, the server runs ${short(server)}`, "reload / restart `factory ui`");
  }
  const factoryRev = x.factory?.state === "running" ? x.factory.rev : null;
  if (server !== null && factoryRev && factoryRev !== server) {
    // Either side may be the newer one (a UI started after a commit the factory has not picked up yet), so neither is
    // called out of date.
    add("revision_mismatch", `UI server and factory differ: the UI runs ${short(server)}, the factory ${short(factoryRev)}`, "restart the older: `factory ui` or `factory dev`");
  }
  return out;
}

/**
 * The pending migration in one sentence, or null: the store's schema behind the code, a store that refuses to
 * open until `npm run migrate` ran, or a supervisor whose update waits on it. Any other read error lists nothing.
 */
async function pendingMigration(store: FactoryStore, factory: FactoryStatus | null | undefined): Promise<string | null> {
  try {
    const v = await store.schemaVersion();
    if (v.applied < v.latest) return `Schema at version ${v.applied} of ${v.latest}`;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === MIGRATION_PENDING) return "Schema or data steps are pending";
  }
  if (factory?.state === "migration_pending") {
    const steps = factory.pending?.length ? ` (pending: ${factory.pending.join(", ")})` : "";
    return `The update to ${short(factory.target_rev ?? "unknown")} waits for the migration${steps}`;
  }
  return null;
}

/**
 * Open items not blocked on a person whose current run's latest claim decision is a deadlock (issue #310). One
 * claim-decision read per item with an active implement run. Listed until the run is resolved.
 */
async function deadlocks(store: FactoryStore, active: readonly Run[]): Promise<{ id: WorkItemId; holder_ref: string }[]> {
  const seen = new Set<WorkItemId>();
  const out: { id: WorkItemId; holder_ref: string }[] = [];
  for (const r of active.filter((x) => x.kind === "implement")) {
    if (seen.has(r.work_item_id)) continue;
    seen.add(r.work_item_id);
    const d = (await store.listClaimDecisions(r.work_item_id)).at(-1) ?? null;
    if (!d || !active.some((x) => x.work_item_id === r.work_item_id && deadlocked(d, x))) continue;
    const it = await store.getWorkItem(r.work_item_id);
    if (it && it.stage !== "CLOSED" && it.blocked_on !== "human") out.push({ id: it.id, holder_ref: d.holder_ref });
  }
  return out;
}

/** How often a `factory ui` started by hand checks that the factory has not moved past its revision. */
const UI_REVISION_CHECK_MS = 30_000;

/**
 * Rereads `older` (a local read of the supervisor's status file) every 30 s; `signal` aborts with the first
 * refusal text, which `text()` then returns.
 */
export function watchRevision(older: () => Promise<string | null>): { signal: AbortSignal; text(): string | null; stop(): void } {
  const stale = new AbortController();
  let text: string | null = null;
  const watch = setInterval(() => {
    void older().then((t) => {
      if (t !== null && text === null) { text = t; stale.abort(); }
    });
  }, UI_REVISION_CHECK_MS);
  watch.unref();
  return { signal: stale.signal, text: () => text, stop: () => clearInterval(watch) };
}
