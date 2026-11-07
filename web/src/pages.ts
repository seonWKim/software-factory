import { Activity, Factory, HeartPulse, type LucideIcon, ListOrdered, ListTodo, Settings } from "lucide-react";

/** The sidebar's pages, in order. Each page but the shell is a placeholder naming the step that brings it (#124). */
export interface PageDef {
  path: string;
  label: string;
  icon: LucideIcon;
  comes: string;
}

export const PAGES: readonly PageDef[] = [
  { path: "", label: "Floor", icon: Factory, comes: "The factory floor comes in step 3 of #124." },
  { path: "items", label: "Work items", icon: ListTodo, comes: "The work item list and item pages come in step 4 of #124." },
  { path: "workers", label: "Workers", icon: Activity, comes: "The workers page comes in step 5 of #124." },
  { path: "queue", label: "Queue", icon: ListOrdered, comes: "The queue page comes in step 5 of #124." },
  { path: "health", label: "Health", icon: HeartPulse, comes: "The health page comes in step 5 of #124." },
  { path: "settings", label: "Settings", icon: Settings, comes: "Settings come with the authenticated actions, a separate issue after #124." },
];

export const BASE = "/app/";

/** The page for a location path under /app/; unknown paths show the Floor. */
export function pageFor(pathname: string): PageDef {
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length).replace(/\/+$/, "") : "";
  return PAGES.find((p) => p.path === rest) ?? PAGES[0]!;
}
