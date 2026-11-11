import { Activity, Archive, CalendarDays, Database, FolderKanban, HeartPulse, Inbox, ListOrdered, ListTodo, OctagonAlert, Settings, Siren, Waypoints, type LucideIcon } from "lucide-react";

/** Where a page sits in the sidebar: the Factory group, the collapsed System group, or only the top bar (Settings). */
export type PageGroup = "factory" | "system" | null;

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
  { path: "", label: "Needs you", key: "needs", icon: Siren, group: "factory" },
  { path: "items", label: "Work", key: "work", icon: ListTodo, group: "factory" },
  { path: "activity", label: "Activity", key: "activity", icon: Activity, group: "factory" },
  { path: "health", label: "Health", key: "health", icon: HeartPulse, group: "system" },
  { path: "failures", label: "Failures", key: "failures", icon: OctagonAlert, group: "system" },
  { path: "runners", label: "Runners", key: "runners", icon: Waypoints, group: "system" },
  { path: "queue", label: "Queue", key: "queue", icon: ListOrdered, group: "system" },
  { path: "data", label: "Data", key: "data", icon: Database, group: "system" },
  { path: "settings", label: "Settings", key: "settings", icon: Settings, group: null },
];

/** A Tasks entry whose view #569 has not added yet: shown disabled with "coming", never a link. */
export interface ComingDef {
  key: string;
  icon: LucideIcon;
}

export const TASK_ENTRIES: readonly ComingDef[] = [
  { key: "inbox", icon: Inbox },
  { key: "today", icon: CalendarDays },
  { key: "upcoming", icon: Archive },
  { key: "projects", icon: FolderKanban },
];

export const pagesIn = (group: PageGroup): readonly PageDef[] => PAGES.filter((p) => p.group === group);

export const BASE = "/app/";

/** The Settings page's "Commands from the page" section: what to set when the page's commands are off. */
export const PAGE_COMMANDS_PATH = `${BASE}settings#page-commands`;

/** Old page paths and where they lead now (Workers became Runners; the Users page is gone, one owner). */
const REDIRECTS: Readonly<Record<string, string>> = { workers: "runners", users: "" };

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

/** Where a location path under /app/ leads: a sidebar page, or one work item (`items/<id>`, under Work). */
export interface Route {
  page: PageDef;
  itemId: string | null;
}

/** The route for a location path under /app/; an old path leads where it moved to, an unknown one to Needs you. */
export function routeFor(pathname: string): Route {
  const rest = REDIRECTS[restOf(pathname)] ?? restOf(pathname);
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
  return { page: PAGES.find((p) => p.path === rest) ?? PAGES[0]!, itemId: null };
}

export const itemPath = (id: string) => `${BASE}items/${encodeURIComponent(id)}`;
