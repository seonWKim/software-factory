import { Activity, CalendarCheck, CalendarDays, CircleDollarSign, Database, HeartPulse, ListTodo, OctagonAlert, Puzzle, ScrollText, Settings, Waypoints, type LucideIcon } from "lucide-react";

/** Where a page sits in the sidebar: the Tasks group, the Plugins group (its own, above System), the System group, or the row at its bottom (Settings). */
export type PageGroup = "tasks" | "plugins" | "system" | "bottom";

/** One routable page. `key` names it in the English catalog (`page.<key>`), which also names its heading. */
export interface PageDef {
  path: string;
  label: string;
  key: string;
  icon: LucideIcon;
  group: PageGroup;
}

/** The pages, in sidebar order. Literal `path` then `label` per entry: scripts/responsive-check.mjs reads them. */
export const PAGES: readonly PageDef[] = [
  { path: "tasks", label: "Tasks", key: "tasks", icon: CalendarCheck, group: "tasks" },
  { path: "calendar", label: "Calendar", key: "calendar", icon: CalendarDays, group: "tasks" },
  { path: "plugins", label: "Plugins", key: "plugins", icon: Puzzle, group: "plugins" },
  { path: "items", label: "Work", key: "work", icon: ListTodo, group: "system" },
  { path: "activity", label: "Activity", key: "activity", icon: Activity, group: "system" },
  { path: "health", label: "Health", key: "health", icon: HeartPulse, group: "system" },
  { path: "failures", label: "Failures", key: "failures", icon: OctagonAlert, group: "system" },
  { path: "spend", label: "Spend", key: "spend", icon: CircleDollarSign, group: "system" },
  { path: "rules", label: "Rules", key: "rules", icon: ScrollText, group: "system" },
  { path: "runners", label: "Runners", key: "runners", icon: Waypoints, group: "system" },
  { path: "data", label: "Data", key: "data", icon: Database, group: "system" },
  { path: "settings", label: "Settings", key: "settings", icon: Settings, group: "bottom" },
];

export const pagesIn = (group: PageGroup): readonly PageDef[] => PAGES.filter((p) => p.group === group);

export const BASE = "/app/";

/** The Settings page's "Commands from the page" section: what to set when the page's commands are off. */
export const PAGE_COMMANDS_PATH = `${BASE}settings#page-commands`;

/** Old page paths and where they lead now (the landing page, Needs you, became Tasks; Workers became Runners; Queue became Work's Queued filter). */
const REDIRECTS: Readonly<Record<string, string>> = { "": "tasks", workers: "runners", queue: "items?state=queued" };

/** The path under /app/ without query, hash or trailing slash. */
function restOf(pathname: string): string {
  // A query (`failures?window=24h`) selects within a page and a hash (`#msg-3`) is a place on it; neither changes which page.
  return pathname.startsWith(BASE) ? pathname.slice(BASE.length).split(/[?#]/)[0]!.replace(/\/+$/, "") : "";
}

/** The new location of an old page path (`/app/workers` → `/app/runners`), or null when it is not an old one. */
export function redirectFor(pathname: string): string | null {
  const to = REDIRECTS[restOf(pathname)];
  return to === undefined ? null : BASE + to;
}

const WORK = PAGES.find((p) => p.path === "items")!;
const TASKS = PAGES.find((p) => p.path === "tasks")!;

/** Where a location path under /app/ leads: a sidebar page, or one work item (`items/<id>`, under Work). */
export interface Route {
  page: PageDef;
  itemId: string | null;
}

/** The route for a location path under /app/; an old path leads where it moved to, an unknown one to Tasks. */
export function routeFor(pathname: string): Route {
  const rest = (REDIRECTS[restOf(pathname)] ?? restOf(pathname)).split("?")[0]!;
  const m = /^items\/([^/]+)$/.exec(rest);
  if (m) {
    let id: string | null = null;
    try {
      id = decodeURIComponent(m[1]!);
    } catch {
      id = null;
    }
    if (id) return { page: WORK, itemId: id };
  }
  return { page: PAGES.find((p) => p.path === rest) ?? TASKS, itemId: null };
}

export const itemPath = (id: string) => `${BASE}items/${encodeURIComponent(id)}`;
