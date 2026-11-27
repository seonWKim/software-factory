import { CalendarCheck, CalendarClock, CalendarDays, ChartGantt, Database, FileDiff, HeartPulse, ListTodo, MessageSquare, Puzzle, ScrollText, Settings, type LucideIcon } from "lucide-react";
import { REDIRECTS } from "./page-redirects.js";

/** Where a page sits in the sidebar: the Tasks block, the System block (Work, Health, Workers), the bottom block (Rules, Plugins, Settings), or nowhere (a routable page with no sidebar link: Data, linked from Settings > Advanced, and Proposals at /app/proposals). Runners is Health's Runners tab. */
export type PageGroup = "tasks" | "system" | "bottom" | "hidden";

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
  { path: "schedules", label: "Schedules", key: "schedules", icon: CalendarClock, group: "tasks" },
  { path: "chat", label: "Chat", key: "chat", icon: MessageSquare, group: "tasks" },
  { path: "items", label: "Work", key: "work", icon: ListTodo, group: "system" },
  { path: "health", label: "Health", key: "health", icon: HeartPulse, group: "system" },
  { path: "workers", label: "Workers", key: "workers", icon: ChartGantt, group: "system" },
  { path: "rules", label: "Rules", key: "rules", icon: ScrollText, group: "bottom" },
  { path: "plugins", label: "Plugins", key: "plugins", icon: Puzzle, group: "bottom" },
  { path: "settings", label: "Settings", key: "settings", icon: Settings, group: "bottom" },
  { path: "data", label: "Data", key: "data", icon: Database, group: "hidden" },
  { path: "proposals", label: "Proposals", key: "proposals", icon: FileDiff, group: "hidden" },
];

export const pagesIn = (group: PageGroup): readonly PageDef[] => PAGES.filter((p) => p.group === group);

export const BASE = "/app/";

/** The Settings page's "Commands from the page" section: what to set when the page's commands are off. */
export const PAGE_COMMANDS_PATH = `${BASE}settings#page-commands`;

/** The path under /app/ without query, hash or trailing slash. */
function restOf(pathname: string): string {
  // A query (`failures?window=24h`) selects within a page and a hash (`#msg-3`) is a place on it; neither changes which page.
  return pathname.startsWith(BASE) ? pathname.slice(BASE.length).split(/[?#]/)[0]!.replace(/\/+$/, "") : "";
}

/** The new location of an old page path (`/app/queue` → `/app/items?state=queued`), or null when it is not an old one. The old location's `search` carries over (`/app/failures?window=7d` → `/app/health?tab=failures&window=7d`). */
export function redirectFor(pathname: string, search = ""): string | null {
  const to = REDIRECTS[restOf(pathname)];
  if (to === undefined) return null;
  const [rest, hash = ""] = to.split("#");
  const [page, query = ""] = rest!.split("?");
  const merged = [query, search.replace(/^\?/, "")].filter(Boolean).join("&");
  return `${BASE}${page}${merged ? `?${merged}` : ""}${hash ? `#${hash}` : ""}`;
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
  const rest = (REDIRECTS[restOf(pathname)] ?? restOf(pathname)).split(/[?#]/)[0]!;
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

/** The skill_ref of an evals page path under /app/ (`evals/<skill>`, the skill URL-encoded), or null. */
export function evalsRoute(pathname: string): string | null {
  const m = /^evals\/([^/]+)$/.exec(restOf(pathname));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!) || null;
  } catch {
    return null;
  }
}

export const itemPath = (id: string) => `${BASE}items/${encodeURIComponent(id)}`;
