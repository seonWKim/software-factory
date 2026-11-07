import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Moon, RefreshCw, Sun } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { API, type Overview, POLL_MS, getJson } from "./api.js";
import { Button } from "./components/ui/button.js";
import { cn } from "./lib/cn.js";
import { Link, NavProvider, useLocationPath } from "./nav.js";
import { BASE, PAGES, type PageDef, TOOL_PAGES, routeFor } from "./pages.js";
import { type Theme, saveTheme, storedTheme } from "./theme.js";
import { DataPage } from "./views/data.js";
import { FailuresPage } from "./views/failures.js";
import { FloorPage, HealthPage, ItemPage, ItemsPage, QueuePage, WorkersPage } from "./views/pages.js";
import { SettingsPage } from "./views/settings.js";
import { TranscriptView, transcriptRoute } from "./views/transcript.js";

/** "updated Ns ago", ticking each second. */
function useAgo(at: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (at === 0) return "not updated yet";
  return `updated ${Math.max(0, Math.floor((now - at) / 1000))}s ago`;
}

const VIEWS: Record<string, () => JSX.Element> = {
  "": FloorPage,
  items: ItemsPage,
  workers: WorkersPage,
  queue: QueuePage,
  health: HealthPage,
  failures: FailuresPage,
  settings: SettingsPage,
  data: DataPage,
};

/** One sidebar group of page links. */
function SideLinks({ label, pages, current }: { label: string; pages: readonly PageDef[]; current: PageDef }) {
  return (
    <nav aria-label={label}>
      <ul className="space-y-1">
        {pages.map((p) => (
          <li key={p.label}>
            <Link
              href={BASE + p.path}
              aria-current={p === current ? "page" : undefined}
              // Below sm only the icon shows: the title and name keep each link named.
              title={p.label}
              aria-label={p.label}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800",
                p === current && "bg-zinc-100 font-medium dark:bg-zinc-800",
              )}
            >
              <p.icon aria-hidden className="size-4 shrink-0" />
              <span className="max-sm:sr-only">{p.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The app (design §9): sidebar, top bar with "Needs you (N)", and the current page. */
export function App() {
  const overview = useQuery({
    queryKey: [API.overview],
    queryFn: () => getJson<Overview>(API.overview),
    refetchInterval: POLL_MS,
    // Hidden tab: no polling (TanStack Query reads document.visibilityState).
    refetchIntervalInBackground: false,
  });
  const client = useQueryClient();
  const ago = useAgo(overview.dataUpdatedAt);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [path, navigate] = useLocationPath();
  const route = routeFor(path);
  // A run's transcript (items/<id>/runs/<run>), under Work items like an item page.
  const transcript = transcriptRoute(path);
  const current = transcript ? PAGES[1]! : route.page;
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    saveTheme(next);
    setTheme(next);
  };
  const needs = overview.data?.needs_you;
  const View = VIEWS[route.page.path] ?? FloorPage;
  useEffect(() => {
    document.title = `${transcript ? "Run transcript" : route.itemId ? "Work item" : route.page.label} · software-factory`;
  }, [route.page, route.itemId, transcript]);

  return (
    <NavProvider value={navigate}>
      <div className="flex min-h-dvh bg-white font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <aside aria-label="Sidebar" className="w-44 shrink-0 border-r border-zinc-200 p-3 max-sm:w-14 dark:border-zinc-800">
          <p className="mb-4 px-2 text-sm font-semibold max-sm:hidden">software-factory</p>
          <SideLinks label="Pages" pages={PAGES} current={current} />
          <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <SideLinks label="Tools" pages={TOOL_PAGES} current={current} />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
            <Link
              href={BASE}
              data-testid="needs-you"
              className={cn(
                "rounded-md px-2 py-1 text-sm font-medium tabular-nums",
                needs ? "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100" : "bg-zinc-100 dark:bg-zinc-800",
              )}
            >
              Needs you ({needs ?? "…"})
            </Link>
            <span className="ml-auto text-sm text-zinc-600 tabular-nums dark:text-zinc-400" aria-live="polite">
              {overview.isError ? "update failed" : ago}
            </span>
            <Button aria-label="Refresh" onClick={() => void client.invalidateQueries()}>
              <RefreshCw aria-hidden className="size-4" />
            </Button>
            <Button aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={toggle}>
              {theme === "dark" ? <Sun aria-hidden className="size-4" /> : <Moon aria-hidden className="size-4" />}
            </Button>
          </header>
          <main className="min-w-0 p-4">
            {!route.itemId && !transcript && <h1 className="mb-4 text-balance text-lg font-semibold">{route.page.label}</h1>}
            {transcript ? (
              <TranscriptView key={`${transcript.itemId}/${transcript.runId}`} itemId={transcript.itemId} runId={transcript.runId} />
            ) : route.itemId ? (
              <ItemPage key={route.itemId} id={route.itemId} />
            ) : (
              <View />
            )}
          </main>
        </div>
      </div>
    </NavProvider>
  );
}
