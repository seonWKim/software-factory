import { Activity, Factory, HeartPulse, type LucideIcon, ListOrdered, ListTodo, Settings } from "lucide-react";

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
  { path: "settings", label: "Settings", icon: Settings },
];

export const BASE = "/app/";

/** Where a location path under /app/ leads: a sidebar page, or one work item (`items/<id>`, under Work items). */
export interface Route {
  page: PageDef;
  itemId: string | null;
}

/** The route for a location path under /app/; unknown paths show the Floor. */
export function routeFor(pathname: string): Route {
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length).replace(/\/+$/, "") : "";
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
  return { page: PAGES.find((p) => p.path === rest) ?? PAGES[0]!, itemId: null };
}

/** The page for a location path under /app/ (the sidebar's current entry). */
export function pageFor(pathname: string): PageDef {
  return routeFor(pathname).page;
}

export const itemPath = (id: string) => `${BASE}items/${encodeURIComponent(id)}`;
