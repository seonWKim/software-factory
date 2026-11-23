// The dashboard's GET route chain under /api/v1 (design §9): GET /api/v1/notices (notices-api.ts), /api/v1/rules and
// /api/v1/rules/entry (rules-api.ts), /api/v1/proposals (improve-api.ts), /api/v1/tasks (`?project=<slug>`: the
// project switcher) and /api/v1/tasks/preview (the quick-add preview; tasks-api.ts), /api/v1/plugins (the Plugins
// page; plugins-api.ts), /api/v1/plugins/import (it reads the user's own Claude Code and Codex configs, so it also
// needs the CSRF token; plugins-import-api.ts), /api/v1/calendar (calendar-api.ts), /api/v1/model-credential (the
// dialog's secret names; model-credential.ts), /api/v1/supervisor (what Migrate now, Start and Restart now may do;
// migrate-api.ts), /api/v1/calendar/events (the Calendar page's range read; calendar-events-api.ts) and
// /api/v1/evals/<skill>/runs, /grid and /compare (a skill's eval runs, grid and compare; evals-api.ts, a path
// pattern), /api/v1/items/:id/changes (the item page's Changes tab; changes.ts) and /api/v1/schedules and
// /api/v1/schedules/runs (`?schedule=<id>`; schedules-api.ts); every other
// path is api.ts's. They are served here beside api.ts so it stays within its size budget. A new read route adds one
// entry to READ_ROUTES, not a line in server.ts.

import { compareSkillEvalRuns, skillEvalGrid } from "../core/skill-eval-compare.js";
import { type ApiResult, api, apiError } from "./api.js";
import { staleCsrf } from "./commands.js";
import { csrfMatches } from "./settings-api.js";
import { TASKS_PATH, TASK_PREVIEW_PATH, readTaskPreview, readTasks } from "./tasks-api.js";
import { RULES_PATH, RULE_ENTRY_PATH, readRuleEntry, readRules } from "./rules-api.js";
import { PROPOSALS_PATH, readProposals } from "./improve-api.js";
import { NOTICES_PATH, readNotices } from "./notices-api.js";
import { PLUGINS_PATH, readPlugins } from "./plugins-api.js";
import { PLUGINS_IMPORT_PATH, readPluginsImport } from "./plugins-import-api.js";
import { CALENDAR_PATH, readCalendarStatus } from "./calendar-api.js";
import { CALENDAR_EVENTS_PATH, readCalendarEvents } from "./calendar-events-api.js";
import { MODEL_CREDENTIAL_PATH, readModelCredential } from "./model-credential.js";
import { SUPERVISOR_PATH, readSupervisor } from "./migrate-api.js";
import { EVALS_LIST_PATH, EVALS_PATH, readEvalSuites, readSkillEvals } from "./evals-api.js";
import { changesPathId, readItemChanges } from "./changes.js";
import { SCHEDULES_PATH, SCHEDULE_RUNS_PATH, readScheduleRuns, readSchedules } from "./schedules-api.js";
import type { ServerDeps, UiRequest } from "./server.js";

/** One GET (or HEAD) route under /api/v1: its path (or a pattern over it) and its read. */
interface ReadRoute {
  path: string | RegExp;
  run(d: ServerDeps, url: URL, req: UiRequest): ApiResult | Promise<ApiResult>;
}

/** The import's read lists files of the user's home folder: the page's CSRF token too, before any read. */
function pluginsImport(d: ServerDeps, req: UiRequest): ApiResult | Promise<ApiResult> {
  if (d.pauses === undefined) return apiError(404, "Not found.");
  if (!csrfMatches(d.pauses.csrfToken, req.csrfToken)) return staleCsrf();
  return readPluginsImport(d);
}

const READ_ROUTES: readonly ReadRoute[] = [
  { path: PLUGINS_IMPORT_PATH, run: (d, _u, req) => pluginsImport(d, req) },
  { path: NOTICES_PATH, run: (d) => readNotices(d) },
  { path: RULES_PATH, run: (d) => readRules(d) },
  { path: RULE_ENTRY_PATH, run: (d, u) => readRuleEntry(d, u.searchParams.get("id")) },
  { path: PROPOSALS_PATH, run: (d) => readProposals(d) },
  { path: TASKS_PATH, run: (d, u) => readTasks(d, u.searchParams.get("project")) },
  { path: TASK_PREVIEW_PATH, run: (d, u) => readTaskPreview(d, u.searchParams.get("words")) },
  { path: PLUGINS_PATH, run: (d) => readPlugins(d) },
  { path: CALENDAR_PATH, run: (d) => readCalendarStatus(d) },
  { path: MODEL_CREDENTIAL_PATH, run: (d) => readModelCredential(d) },
  // Unwired, the supervisor path falls through to api.ts's 404.
  { path: SUPERVISOR_PATH, run: (d, u) => (d.migrate !== undefined && d.pauses !== undefined ? readSupervisor(d.migrate, d.pauses) : api(d, u)) },
  { path: CALENDAR_EVENTS_PATH, run: (d, u) => readCalendarEvents(d, u.searchParams.get("from"), u.searchParams.get("to")) },
  { path: EVALS_LIST_PATH, run: (d) => readEvalSuites(d) },
  { path: EVALS_PATH, run: (d, u) => readSkillEvals(d, { grid: skillEvalGrid, compare: compareSkillEvalRuns }, u) },
  { path: SCHEDULES_PATH, run: (d) => readSchedules(d) },
  { path: SCHEDULE_RUNS_PATH, run: (d, u) => readScheduleRuns(d, u.searchParams.get("schedule")) },
];

/** Answers one GET (or HEAD) under /api/v1 on its parsed URL. */
export async function readApi(d: ServerDeps, url: URL, req: UiRequest): Promise<ApiResult> {
  const route = READ_ROUTES.find((r) => (typeof r.path === "string" ? r.path === url.pathname : r.path.test(url.pathname)));
  if (route) return route.run(d, url, req);
  const changesId = changesPathId(url.pathname);
  return changesId !== null ? readItemChanges(d, changesId, url.searchParams.get("path")) : api(d, url);
}
