import { Activity, Database, Factory, HeartPulse, OctagonAlert, type LucideIcon, ListOrdered, ListTodo, Settings } from "lucide-react";

/** The sidebar's pages, in order. */
export interface PageDef {
  path: string;
  label: string;
  icon: LucideIcon;
}

export const PAGES: readonly PageDef[] = [
  { path: "", label: "Floor", icon: Factory },
  { path: "items", label: "Work items", icon: ListTodo },
  { path: "workers", label: "Workers", icon: Activity },
  { path: "queue", label: "Queue", icon: ListOrdered },
  { path: "health", label: "Health", icon: HeartPulse },
  { path: "failures", label: "Failures", icon: OctagonAlert },
  { path: "settings", label: "Settings", icon: Settings },
];

/**
 * The sidebar's tools, listed in their own group after the pages: Data, the raw store tables (design §9). A
 * separate group, so the pages' list stays the operator's view and the tools read as debugging aids.
 */
export const TOOL_PAGES: readonly PageDef[] = [{ path: "data", label: "Data", icon: Database }];

const ALL_PAGES: readonly PageDef[] = [...PAGES, ...TOOL_PAGES];

export const BASE = "/app/";

/** Where a location path under /app/ leads: a sidebar page, or one work item (`items/<id>`, under Work items). */
export interface Route {
  page: PageDef;
  itemId: string | null;
}

/** The route for a location path under /app/; unknown paths show the Floor. */
export function routeFor(pathname: string): Route {
  // A query (`failures?window=24h`) selects within a page and a hash (`#msg-3`) is a place on it; neither changes which page.
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length).split(/[?#]/)[0]!.replace(/\/+$/, "") : "";
  const m = /^items\/([^/]+)$/.exec(rest);
  if (m) {
    let id: string | null = null;
    try {
      id = decodeURIComponent(m[1]!);
    } catch {
      id = null;
    }
    if (id) return { page: PAGES[1]!, itemId: id };
  }
  return { page: ALL_PAGES.find((p) => p.path === rest) ?? PAGES[0]!, itemId: null };
}

/** The page for a location path under /app/ (the sidebar's current entry). */
export function pageFor(pathname: string): PageDef {
  return routeFor(pathname).page;
}

export const itemPath = (id: string) => `${BASE}items/${encodeURIComponent(id)}`;
