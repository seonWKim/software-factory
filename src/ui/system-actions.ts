// System actions in Needs you (design §9 Status page, issue #311): what the factory needs from the operator
// besides a work item. A pending migration, a GitHub token that expires within 3 days, a missing model credential, a claim pause or a
// worker pause in effect, an open alarm, a local base whose push to origin conflicts and whose reconcile failed, and a dashboard or UI server that
// runs another revision than it should. Each is one Needs-you row (needs-you.ts) and names the command that clears it (an alarm: where to look into it). Store reads and in-process values only: the overview poll
// asks GitHub nothing (the token's days come from this process's last health run).

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AlertPattern, FactoryStore } from "../interfaces/factory-store.js";
import { MIGRATION_PENDING } from "../interfaces/updater.js";
import { type Check, TOKEN_WARN_DAYS } from "../core/health-check.js";
import type { FactoryStatus } from "./factory-status.js";
import { type AutoStopNote, alarmCommand, alarmDetail, alarmFullText, alarmUntil, lastAutoStop, openAlarms, redMainDetail } from "./alarms.js";
import type { ResumablePause } from "../resume-cmd.js";
import { RESUME_IN_NEEDS_YOU, activePauses } from "./pause-api.js";
import { MODEL_CREDENTIAL } from "../core/policy.js";
import { reconcileOf } from "../core/local-merge.js";

/** Items blocked on a person read to find a failed base reconcile: few wait at once. */
const RECONCILE_READ = 200;

/**
 * The missing model credential's Needs-you row (design §9): the fix in its title, no command; its action opens the Add
 * model credential dialog (model-credential.ts). It ends once the dialog saves one, or a worker finds one.
 */
export const MODEL_CREDENTIAL_TITLE = "Add a model credential";

export type SystemActionCode = "migration_pending" | "token_expiring" | "model_credential" | "claim_pause" | "worker_pause" | "alarm" | "base_push_conflict" | "revision_mismatch";

export interface SystemAction {
  code: SystemActionCode;
  /** One sentence; may carry store text (an alarm's detail), so the API passes it through the Withholder. */
  text: string;
  /** What clears it, as the operator types it. */
  command: string;
  /** When it ends by itself (a claim pause's end, model_stall's next probe, an alarm's close), else null. */
  until: string | null;
  /** On an alarm: its alert's id, which Dismiss posts (POST /api/v1/alarms/dismiss). */
  alert_id?: string;
  /** On an alarm: its pattern and error code, which pick its row's menu (What failed, Show failures). */
  pattern?: AlertPattern;
  error_code?: string;
  /** On an alarm whose detail is raw text (a failed chat check): that detail, which its row shows under Details only. */
  detail?: string | null;
  /** On a red_main alarm: what the red-main check printed (empty and null when it kept nothing). */
  failing_tests?: string[];
  output_tail?: string | null;
  /** On the alarm of the auto-mode stop still in force (design 03-risk): its Needs-you row's sentence and menu. */
  auto_stop?: AutoStopNote;
  /** On a claim pause: the pause's name, which its Needs-you row's Resume now posts. */
  pause?: ResumablePause;
}

/** Each claim pause's plain name: the text of its Needs-you row, never the stored name. */
const PAUSE_NAMES: Record<ResumablePause, string> = {
  rate_limit: "Usage or rate limit",
  forge_auth: "Forge refused the credentials",
  preflight_access: "Push or PR access check failed",
  model_stall: "Model not answering",
  owner: "Agents stopped",
};

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
  /** The revision this UI server's build was made from (`serverRevision`, the stamp in dist/); null: unknown. */
  revision?: string | null;
  /** The last health run of this process. */
  lastChecks?: LastChecks;
}

/**
 * The name of the build stamp in dist/: the revision `npm run build` (scripts/build.mjs, which names the same file)
 * built dist/ and web/dist/ from. A docs-only update moves the checkout without a build, so its git HEAD is no
 * revision of the running code (design 08 Self-update).
 */
export const REVISION_STAMP = "revision";

/** The revision the server at `root` runs: the build stamp in `<root>/dist`. Null when there is none (an older build). */
export async function serverRevision(root: string): Promise<string | null> {
  try {
    return parseRevision((await readFile(join(root, "dist", REVISION_STAMP), "utf8")).trim());
  } catch {
    return null;
  }
}

/** `git rev-parse HEAD` in `root`: the checkout a hand-started page refuses by (`olderThanFactory`). Null when git cannot say. */
export async function checkoutRevision(root: string): Promise<string | null> {
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
  /** The supervisor's status; absent or null: none. */
  factory: FactoryStatus | null | undefined;
  deps: SystemDeps;
  /** The overview's now: an alarm is open inside its window before it. */
  now: Date;
  /** The revision built into the dashboard that polls, when it sent one. */
  dashboardRev: string | null;
}

/** Every system action in effect, in a fixed order: migration, token, model credential, pauses, alarms, base pushes, revisions. */
export async function systemActions(x: SystemInput): Promise<SystemAction[]> {
  const out: SystemAction[] = [];
  const add = (code: SystemActionCode, text: string, command: string, until: string | null = null) =>
    out.push({ code, text, command, until });

  const migration = await pendingMigration(x.store, x.factory);
  // The dashboard action first (the row's Migrate now button), the CLI command as the fallback.
  if (migration) add("migration_pending", migration, "Migrate now, or factory migrate");

  const days = x.deps.lastChecks?.tokenDays() ?? null;
  if (typeof days === "number" && days < TOKEN_WARN_DAYS) {
    add("token_expiring", days <= 0 ? "The GitHub token has expired or expires today" : `The GitHub token expires in ${days} day${days === 1 ? "" : "s"}`, "npm run setup -- --rotate-github");
  }

  // One row for the missing model credential: it is no resumable pause, so the claim_pause rows below never list it. The
  // dashboard action first (the row's dialog), the CLI command as the fallback; the row draws the dialog, never this command.
  if ((await x.store.getClaimPause(MODEL_CREDENTIAL)) !== null) add("model_credential", MODEL_CREDENTIAL_TITLE, "Add model credential, or npm run setup");

  for (const p of await activePauses(x)) {
    // The plain name; the row shows `until` (model_stall's next probe) as a relative time; the owner pause has none, and
    // its row reads when it began from GET /api/v1/pauses. The dashboard action first, the CLI command as the fallback;
    // the Tasks row draws the button, never this command.
    add("claim_pause", PAUSE_NAMES[p.name], `${RESUME_IN_NEEDS_YOU}, or factory resume ${p.name}`, p.ends_at);
    out.at(-1)!.pause = p.name;
  }
  // The all-workers row is the owner pause above (`factory stop`); this row counts the per-worker pauses only, set on the
  // CLI: the dashboard has no per-worker pause or resume control.
  const workerPauses = (await x.store.listWorkerPauses()).filter((p) => p.worker_id !== "*");
  if (workerPauses.length > 0) {
    add("worker_pause", `${workerPauses.length} worker pause${workerPauses.length === 1 ? "" : "s"} in effect (factory workers pause)`, "factory workers resume");
  }

  const stop = await lastAutoStop(x.store);
  for (const a of await openAlarms(x.store, x.now)) {
    add("alarm", alarmFullText(a), alarmCommand(a), alarmUntil(a));
    const row = Object.assign(out.at(-1)!, { alert_id: a.id, pattern: a.pattern, error_code: a.error_code });
    const detail = alarmDetail(a);
    if (detail !== null) row.detail = detail;
    if (a.pattern === "red_main") {
      const output = redMainDetail(a).output;
      Object.assign(row, { failing_tests: output?.failing_tests ?? [], output_tail: output?.output_tail ?? null });
    }
    if (stop?.alert_id === a.id) row.auto_stop = stop;
  }

  // A local base whose newest delivered push to origin is a conflict (design 05-sources, Base reconcile): its reconcile item
  // merges origin in by itself, so the owner is asked only once a reconcile item of that base waits on a person (its
  // resolve run or its merge check failed). One row per base, read from its push actions and the items blocked on a
  // person; a push that lands removes it.
  const conflicted = (await x.store.listBasePushBacklogs()).filter((b) => b.conflicts !== null);
  const failed = conflicted.length === 0 ? [] : (await x.store.listWorkItemsWhere({ blocked_on: "human", exclude_closed: true, limit: RECONCILE_READ }))
    .filter((it) => reconcileOf(it) !== null);
  for (const b of conflicted) {
    const it = failed.find((i) => reconcileOf(i)!.base_ref === b.base_ref);
    if (!it) continue;
    const files = b.conflicts!.length > 0 ? `Conflicts in ${b.conflicts!.join(", ")}; ` : "";
    const merges = `${b.waiting} local merge${b.waiting === 1 ? "" : "s"} waiting`;
    add("base_push_conflict", `The reconcile of local ${b.base_ref} with origin failed`,
      `${files}${merges}. See ${it.id}, then merge origin/${b.base_ref} into ${b.base_ref} in the factory repo and push it`);
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
