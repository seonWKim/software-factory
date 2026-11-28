// Migrate now, Start and Restart now on the dashboard (design 08-self-update and 09-dashboard-app): the supervisor
// requests `npm run migrate` files, from the page. GET /api/v1/supervisor says which of the three the page may offer
// and, when one is not, why in plain words. POST /api/v1/migrate without `confirm` is Migrate now's dry run (the
// pending steps and each change, through sqlitePendingSteps and migrateSqlite in dry-run mode; nothing is written);
// with `confirm: true` it runs `npm run migrate`'s own sequence (withDrain: a drain request, a wait for
// migration_ready, the steps, then start on success or cancel on failure) in the background. POST /api/v1/supervisor
// with `{ action: "start" | "restart", confirm: true }` files that request. The request guards (Host, Origin,
// Content-Type, CSRF token) run in server.ts first; then the resume route's owner check (approve_spec); then the
// confirm and the supervisor's state. Every refusal comes before any file is written. Nothing here works without a
// live supervisor: it is the one reader of the request file.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../core/log.js";
import type { ProjectRef } from "../core/project.js";
import type { GitHubApi } from "../interfaces/github-credentials.js";
import type { SupervisorStatus } from "../interfaces/updater.js";
import { ConsoleLogger } from "../impl/log/console-logger.js";
import { type ResolveRepo, runProjectKeyStep } from "../impl/store/project-keys.js";
import { type SqliteMigrateSteps, migrateSqlite, sqlitePendingSteps } from "../impl/store/sqlite/rehearse.js";
import type { SqliteDriver } from "../impl/store/sqlite/sqlite-driver.js";
import { DRAIN_MARGIN_MS } from "../impl/updater/git-worktree.js";
import { type DrainDeps, fileSupervisorRequest, isLiveSupervisor, processAlive, readSupervisorStatus, withDrain } from "../migrate-drain.js";
import { ensureDiscoveredTopicTables } from "../runtime/index.js";
import type { ApiResult } from "./api.js";
import type { PauseDeps, UiPauses } from "./pause-api.js";

export const MIGRATE_PATH = "/api/v1/migrate";
export const SUPERVISOR_PATH = "/api/v1/supervisor";

/** What the three actions need beside the store. Built once per UI process (compose.ts buildUiParts). */
export interface UiMigrate {
  stateDir: string;
  clock: DrainDeps["clock"];
  /** `run_timeout_ms`: the drain wait gives up after it plus the supervisor's drain margin, as `npm run migrate`. */
  runTimeoutMs: number;
  /** After the schema is current (apply only): the discovered topic tables, as `npm run migrate`. */
  topicTables(driver: SqliteDriver): Promise<void>;
  /** The project-key step's resolver (the GitHub plugin), built only when owner/name rows are left. */
  resolveRepo(): Promise<ResolveRepo>;
  log: Logger;
  /** Whether a pid names a live process. Default: `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean;
  /** Migrate now's sequence while it runs in this process (a second press is refused), else null. */
  running: Promise<number> | null;
}

/**
 * The UI process's parts (compose.ts buildUiParts): `npm run migrate`'s steps, the topic tables and the project-key step,
 * whose resolver builds the GitHub client (`githubApi`) only when owner/name rows are left, as the CLI's does. The GitHub
 * plugin's `resolveProject` comes from the composition: src/ui imports no GitHub code.
 */
export function uiMigrate(
  o: Pick<UiMigrate, "stateDir" | "clock" | "runTimeoutMs"> & {
    githubApi: () => Promise<GitHubApi>;
    resolveProject: (github: GitHubApi, repo: { owner: string; name: string }) => Promise<ProjectRef>;
  },
): UiMigrate {
  return {
    stateDir: o.stateDir, clock: o.clock, runTimeoutMs: o.runTimeoutMs, log: new ConsoleLogger(o.clock, "migrate"), running: null,
    topicTables: (driver) => ensureDiscoveredTopicTables("sqlite", driver),
    resolveRepo: async () => {
      const github = await o.githubApi();
      return (ownerName) => {
        const [owner = "", name = ""] = ownerName.split("/");
        return o.resolveProject(github, { owner, name });
      };
    },
  };
}

/** The UI's dependencies with these routes. Absent `migrate` (or `pauses`): GET is a 404 and POST a 405. */
export type MigrateDeps = PauseDeps & { migrate?: UiMigrate };

/** One action: offered, or why not in plain words. */
export interface Offer {
  offered: boolean;
  reason: string | null;
}

const YES: Offer = { offered: true, reason: null };
const no = (reason: string): Offer => ({ offered: false, reason });

const NOT_LIVE = "No factory supervisor is running, so this page cannot reach it. Start the factory from a terminal with factory dev.";
const IN_PLACE = "Updates from this page are off while the factory runs from your checkout. To update, stop it, pull the latest code and start it again.";
const UNDER_WAY = "A migration is under way: no process claims work until it ends. Wait for it to finish.";
const WAITS = "An update waits for its migration: use Migrate now first.";
const RUNS = "A factory process already runs and claims work: use Restart now for a fresh one.";
const NONE_RUNS = "No factory process runs: use Start.";

/** Which of Migrate now, Start and Restart now the page may offer, from supervisor.json. File reads only. A factory running in place (the none updater: a live child, no supervisor_pid) gets the checkout reason. */
export async function supervisorOffers(m: UiMigrate): Promise<{ live: boolean; state: SupervisorStatus["state"] | null; migrate: Offer; start: Offer; restart: Offer }> {
  const alive = m.pidAlive ?? processAlive;
  const s = await readSupervisorStatus(m.stateDir);
  const inPlace = s !== null && s.state !== "stopped" && s.supervisor_pid === undefined && s.child_pid !== null && alive(s.child_pid);
  if (s !== null && inPlace) return { live: false, state: s.state, migrate: no(IN_PLACE), start: no(IN_PLACE), restart: no(IN_PLACE) };
  if (s === null || !isLiveSupervisor(s, alive)) return { live: false, state: s?.state ?? null, migrate: no(NOT_LIVE), start: no(NOT_LIVE), restart: no(NOT_LIVE) };
  const underWay = m.running !== null || s.state === "migration_draining" || s.state === "migration_ready";
  const claims = s.child_pid !== null && alive(s.child_pid);
  const blocked = underWay ? no(UNDER_WAY) : s.state === "migration_pending" ? no(WAITS) : null;
  return {
    live: true,
    state: s.state,
    migrate: underWay ? no(UNDER_WAY) : YES,
    start: blocked ?? (claims ? no(RUNS) : YES),
    restart: blocked ?? (claims ? YES : no(NONE_RUNS)),
  };
}

/** GET /api/v1/supervisor: the three offers and the CSRF token their POSTs need. */
export async function readSupervisor(m: UiMigrate, p: UiPauses): Promise<ApiResult> {
  return { status: 200, value: { ...(await supervisorOffers(m)), csrf_token: p.csrfToken } };
}

const field = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)[key] : undefined;

/** The resume route's owner check (approve_spec on the project, pause-api.ts); null when allowed. */
async function ownerRefusal(p: UiPauses, what: string): Promise<ApiResult | null> {
  const user = await p.principal();
  if (user === null) return { status: 403, value: { error: "No factory user acts from this page: link your local account or set cli_user." } };
  const decision = await p.authorize(user);
  return decision.allow ? null : { status: 403, value: { error: `${what} needs write permission (approve_spec): ${decision.reason}.` } };
}

/** The SQLite steps as `npm run migrate` runs them: the topic tables, then the project-key step with this resolver. */
function steps(m: UiMigrate, print: (line: string) => void): SqliteMigrateSteps {
  return { topicTables: (driver) => m.topicTables(driver), projectKeys: (driver, mode) => runProjectKeyStep(driver, () => m.resolveRepo(), mode, print) };
}

const dbFile = (m: UiMigrate) => join(m.stateDir, "db", "factory.db");
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/** The dry run: the pending steps and each line `npm run migrate -- --dry-run` prints (each change). Writes nothing. */
export async function migrateDryRun(m: UiMigrate): Promise<{ pending: string[]; lines: string[]; ok: boolean }> {
  const lines: string[] = [];
  const print = (line: string) => void lines.push(line);
  try {
    const pending = await sqlitePendingSteps(dbFile(m));
    const code = await migrateSqlite(dbFile(m), "dry-run", steps(m, print), print);
    return { pending, lines, ok: code === 0 };
  } catch (err) {
    print(`dry run failed: ${message(err)}`);
    return { pending: [], lines, ok: false };
  }
}

/** `npm run migrate`'s sequence: drain, wait for migration_ready, apply, then start or cancel. A thrown step is a failure. */
function runMigration(m: UiMigrate): Promise<number> {
  const print = (line: string) => m.log.info(line);
  const apply = async (): Promise<number> => {
    try {
      await mkdir(join(m.stateDir, "db"), { recursive: true, mode: 0o700 });
      return await migrateSqlite(dbFile(m), "apply", steps(m, print), print);
    } catch (err) {
      m.log.error("migrate now: the steps failed", { error: message(err) });
      return 1;
    }
  };
  const deps = { stateDir: m.stateDir, clock: m.clock, print, timeoutMs: m.runTimeoutMs + DRAIN_MARGIN_MS, ...(m.pidAlive ? { pidAlive: m.pidAlive } : {}) };
  return withDrain(deps, apply);
}

/**
 * POST /api/v1/migrate, after the request guards. `{}` (no confirm): the dry run, 200. `{ "confirm": true }`: the
 * sequence starts in the background, 202; the banner follows it through supervisor.json. No live supervisor, or a
 * migration under way: 409 with the reason, and no file is written.
 */
export async function postMigrate(m: UiMigrate, p: UiPauses, body: unknown): Promise<ApiResult> {
  const refused = await ownerRefusal(p, "Migrate now");
  if (refused) return refused;
  const offer = (await supervisorOffers(m)).migrate;
  if (!offer.offered) return { status: 409, value: { error: offer.reason } };
  if (field(body, "confirm") !== true) return { status: 200, value: { dry_run: await migrateDryRun(m) } };
  const run = runMigration(m);
  m.running = run;
  void run.finally(() => {
    if (m.running === run) m.running = null;
  });
  return { status: 202, value: { started: true } };
}

/** POST /api/v1/supervisor with `{ action: "start" | "restart", confirm: true }`, after the request guards. */
export async function postSupervisor(m: UiMigrate, p: UiPauses, body: unknown): Promise<ApiResult> {
  const action = field(body, "action");
  if (action !== "start" && action !== "restart") return { status: 400, value: { error: "action must be start or restart" } };
  const what = action === "start" ? "Start" : "Restart now";
  if (field(body, "confirm") !== true) return { status: 400, value: { error: `${what} asks for a confirm first; nothing was filed.` } };
  const refused = await ownerRefusal(p, what);
  if (refused) return refused;
  const offer = (await supervisorOffers(m))[action];
  if (!offer.offered) return { status: 409, value: { error: offer.reason } };
  await fileSupervisorRequest(m.stateDir, action, m.clock);
  p.log.info(`${what}: request filed for the supervisor's next poll`, { action });
  return { status: 202, value: { action, filed: true } };
}
