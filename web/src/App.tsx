import { useQuery } from "@tanstack/react-query";
import { Moon, RefreshCw, Sun } from "lucide-react";
import { type MouseEvent, useEffect, useState } from "react";
import { API, type Overview, POLL_MS, getJson } from "./api.js";
import { Button } from "./components/ui/button.js";
import { cn } from "./lib/cn.js";
import { BASE, PAGES, type PageDef, pageFor } from "./pages.js";
import { type Theme, saveTheme, storedTheme } from "./theme.js";

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

function usePath(): [PageDef, (p: PageDef) => (e: MouseEvent) => void] {
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = (p: PageDef) => (e: MouseEvent) => {
    e.preventDefault();
    history.pushState(null, "", BASE + p.path);
    setPath(BASE + p.path);
  };
  return [pageFor(path), go];
}

/** The shell (step 2 of #124): sidebar, top bar with "Needs you (N)", and the current page. */
export function App() {
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => getJson<Overview>(API.overview),
    refetchInterval: POLL_MS,
    // Hidden tab: no polling (TanStack Query reads document.visibilityState).
    refetchIntervalInBackground: false,
  });
  const ago = useAgo(overview.dataUpdatedAt);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [page, go] = usePath();
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    saveTheme(next);
    setTheme(next);
  };
  const needs = overview.data?.needs_you;

  return (
    <div className="flex min-h-dvh bg-white font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <nav aria-label="Pages" className="w-44 shrink-0 border-r border-zinc-200 p-3 dark:border-zinc-800">
        <p className="mb-4 px-2 text-sm font-semibold">software-factory</p>
        <ul className="space-y-1">
          {PAGES.map((p) => (
            <li key={p.label}>
              <a
                href={BASE + p.path}
                onClick={go(p)}
                aria-current={p === page ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800",
                  p === page && "bg-zinc-100 font-medium dark:bg-zinc-800",
                )}
              >
                <p.icon aria-hidden className="size-4" />
                {p.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <span
            data-testid="needs-you"
            className={cn(
              "rounded-md px-2 py-1 text-sm font-medium tabular-nums",
              needs ? "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100" : "bg-zinc-100 dark:bg-zinc-800",
            )}
          >
            Needs you ({needs ?? "…"})
          </span>
          <span className="ml-auto text-sm text-zinc-600 tabular-nums dark:text-zinc-400" aria-live="polite">
            {overview.isError ? "update failed" : ago}
          </span>
          <Button aria-label="Refresh" onClick={() => void overview.refetch()}>
            <RefreshCw aria-hidden className="size-4" />
          </Button>
          <Button aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={toggle}>
            {theme === "dark" ? <Sun aria-hidden className="size-4" /> : <Moon aria-hidden className="size-4" />}
          </Button>
        </header>
        <main className="p-4">
          <h1 className="text-balance text-lg font-semibold">{page.label}</h1>
          <p className="mt-2 text-pretty text-sm text-zinc-600 dark:text-zinc-400">{page.comes}</p>
        </main>
      </div>
    </div>
  );
}
