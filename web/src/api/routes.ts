// The route map: every URL of the JSON API under /api/v1 (design §9), and the Tasks page's row actions.

import { WEB_REV } from "./overview.js";

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
  /** The spend of one UTC day (YYYY-MM-DD): its items only. */
  spendDay: (day: string) => `/api/v1/spend?from=${day}&to=${day}`,
  unreviewedMerges: "/api/v1/unreviewed-merges",
  settings: "/api/v1/settings",
  capabilities: "/api/v1/settings/capabilities",
  plugins: "/api/v1/plugins",
  packApprovals: "/api/v1/packs/approvals",
  pluginsImport: "/api/v1/plugins/import",
  pauses: "/api/v1/pauses",
  resume: "/api/v1/pauses/resume",
  supervisor: "/api/v1/supervisor",
  migrate: "/api/v1/migrate",
  standing: "/api/v1/standing",
  rules: "/api/v1/rules",
  ruleVerdict: "/api/v1/rules/verdict",
  ruleEntry: (id: string) => `/api/v1/rules/entry?id=${encodeURIComponent(id)}`,
  improveRun: "/api/v1/improve/run",
  tasks: "/api/v1/tasks",
  /** The tasks' read, filtered to one task project's tasks when `project` is a slug. */
  tasksIn: (project: string | null) => (project === null ? "/api/v1/tasks" : `/api/v1/tasks?project=${encodeURIComponent(project)}`),
  /** What quick add would store for these words, from the server's parser; writes nothing. */
  taskPreview: (words: string) => `/api/v1/tasks/preview?words=${encodeURIComponent(words)}`,
  projects: "/api/v1/projects",
  taskProject: "/api/v1/tasks/project",
  calendar: "/api/v1/calendar",
  calendarConnect: "/api/v1/calendar/connect",
  calendarDisconnect: "/api/v1/calendar/disconnect",
  /** The Calendar page's read of the stored events of the local days `from` through `to` (YYYY-MM-DD, inclusive). */
  calendarEvents: (from: string, to: string) => `/api/v1/calendar/events?from=${from}&to=${to}`,
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

/** A Tasks page row action: the path segment of its route. */
export type TaskAction = "edit" | "done" | "reopen" | "delete" | "sub";
