import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Moon, RefreshCw, Sun } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { API, type Overview, POLL_MS, WEB_REV, getJson } from "./api.js";
import { Button } from "./components/ui/button.js";
import { LINK_CLASS } from "./components/ui/link-style.js";
import { type MessageKey } from "./i18n/en.js";
import { t } from "./i18n/index.js";
import { cn } from "./lib/cn.js";
import { Link, NavProvider, useLocationPath } from "./nav.js";
import { BASE, PAGES, type PageDef, TOOL_PAGES, routeFor } from "./pages.js";
import { type Theme, saveTheme, storedTheme } from "./theme.js";
import { useNow } from "./views/common.js";
import { DataPage } from "./views/data.js";
import { FailuresPage } from "./views/failures.js";
import { FloorPage, HealthPage, ItemPage, ItemsPage, QueuePage, WorkersPage } from "./views/pages.js";
import { ModeSwitch, SettingsPage } from "./views/settings.js";
import { RevisionBanner } from "./views/system-banner.js";
import { TranscriptView, transcriptRoute } from "./views/transcript.js";
import { UsersPage } from "./views/users.js";

/** "updated Ns ago", ticking each second; below sm only "Ns" shows, the rest stays for screen readers. */
function Ago({ at }: { at: number }) {
  const now = useNow();
  if (at === 0) return <>{t("topbar.notUpdated")}</>;
  return (
    <>
      <span className="max-sm:sr-only">{t("topbar.updated")}</span>
      {Math.max(0, Math.floor((now - at) / 1000))}s<span className="max-sm:sr-only">{t("topbar.ago")}</span>
    </>
  );
}

const VIEWS: Record<string, () => JSX.Element> = {
  "": FloorPage,
  items: ItemsPage,
  workers: WorkersPage,
  queue: QueuePage,
  health: HealthPage,
  failures: FailuresPage,
  settings: SettingsPage,
  users: UsersPage,
  data: DataPage,
};

const PAGE_KEYS: Record<string, MessageKey> = {
  "": "page.floor",
  items: "page.items",
  workers: "page.workers",
  queue: "page.queue",
  health: "page.health",
  failures: "page.failures",
  settings: "page.settings",
  users: "page.users",
  data: "page.data",
};

/** A sidebar page's name in the active locale. */
const pageLabel = (p: PageDef) => (PAGE_KEYS[p.path] ? t(PAGE_KEYS[p.path]!) : p.label);

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
              title={pageLabel(p)}
              aria-label={pageLabel(p)}
              className={cn(
                "flex items-center gap-2 rounded-control px-2 py-1.5 text-sm hover:bg-surface-2",
                p === current && "bg-surface-2 font-medium",
              )}
            >
              <p.icon aria-hidden className="size-4 shrink-0" />
              <span className="max-sm:sr-only">{pageLabel(p)}</span>
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
    // The Needs you count leads the tab title, so a background tab shows it: "(4) Floor · software-factory".
    const count = needs ? `(${needs}) ` : "";
    document.title = `${count}${transcript ? "Run transcript" : route.itemId ? "Work item" : pageLabel(route.page)} · software-factory`;
  }, [route.page, route.itemId, transcript, needs]);

  return (
    <NavProvider value={navigate}>
      <div className="flex min-h-dvh bg-surface font-sans text-text-1">
        <aside aria-label={t("nav.sidebar")} className="w-44 shrink-0 border-r border-border p-3 max-sm:w-14">
          <p className="mb-4 px-2 text-sm font-semibold max-sm:hidden">{t("app.name")}</p>
          <SideLinks label={t("nav.pages")} pages={PAGES} current={current} />
          <div className="mt-3 border-t border-border pt-3">
            <SideLinks label={t("nav.tools")} pages={TOOL_PAGES} current={current} />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Wraps instead of widening the page on a narrow screen. */}
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
            <Link
              href={BASE}
              data-testid="needs-you"
              className={cn(
                "shrink-0 rounded-control px-2 py-1 text-sm font-medium whitespace-nowrap tabular-nums",
                needs ? "bg-pill-bad-bg text-pill-bad-fg" : "bg-surface-2",
              )}
            >
              {t("topbar.needsYou", { count: needs ?? "…" })}
            </Link>
            <ModeSwitch floating />
            <Link href={`${BASE}settings`} className={cn("shrink-0 text-sm whitespace-nowrap", LINK_CLASS)}>
              {t("topbar.settings")}
            </Link>
            <span className="ml-auto shrink-0 text-sm whitespace-nowrap text-text-2 tabular-nums" aria-live="polite">
              {overview.isError ? t("topbar.updateFailed") : <Ago at={overview.dataUpdatedAt} />}
            </span>
            <Button aria-label={t("topbar.refresh")} className="shrink-0" onClick={() => void client.invalidateQueries()}>
              <RefreshCw aria-hidden className="size-4" />
            </Button>
            <Button aria-label={theme === "dark" ? t("topbar.toLight") : t("topbar.toDark")} className="shrink-0" onClick={toggle}>
              {theme === "dark" ? <Sun aria-hidden className="size-4" /> : <Moon aria-hidden className="size-4" />}
            </Button>
          </header>
          <RevisionBanner server={overview.data?.server_rev} web={WEB_REV} />
          <main className="min-w-0 p-4">
            {!route.itemId && !transcript && <h1 className="mb-4 text-balance text-lg font-semibold">{pageLabel(route.page)}</h1>}
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
