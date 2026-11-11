import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Moon, RefreshCw, Search, Sun, Wrench } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { API, type Overview, POLL_MS, WEB_REV, getJson } from "./api.js";
import { Button } from "./components/ui/button.js";
import { LINK_CLASS } from "./components/ui/link-style.js";
import { type MessageKey } from "./i18n/en.js";
import { t } from "./i18n/index.js";
import { cn } from "./lib/cn.js";
import { useShortcuts } from "./keys.js";
import { Link, NavProvider, useLocationPath } from "./nav.js";
import { BASE, type ComingDef, type PageDef, TASK_ENTRIES, pagesIn, redirectFor, routeFor } from "./pages.js";
import { HelpDialog, SearchDialog } from "./search.js";
import { type Theme, saveTheme, storedTheme } from "./theme.js";
import { useNow } from "./views/common.js";
import { DataPage } from "./views/data.js";
import { FailuresPage } from "./views/failures.js";
import { ActivityPage, HealthPage, ItemPage, ItemsPage, NeedsYouPage, QueuePage, RunnersPage } from "./views/pages.js";
import { ModeSwitch, SettingsPage } from "./views/settings.js";
import { RevisionBanner } from "./views/system-banner.js";
import { TranscriptView, transcriptRoute } from "./views/transcript.js";

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
  "": NeedsYouPage,
  items: ItemsPage,
  activity: ActivityPage,
  runners: RunnersPage,
  queue: QueuePage,
  health: HealthPage,
  failures: FailuresPage,
  settings: SettingsPage,
  data: DataPage,
};

/** A page's name in the active locale: its menu name and its heading. */
const pageLabel = (p: PageDef) => t(`page.${p.key}` as MessageKey);

const LINK_ROW = "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm";

/** One sidebar group of page links; Tasks entries without a view yet show disabled, with "coming". */
function SideLinks({ label, pages, current, coming = [] }: { label: string; pages: readonly PageDef[]; current: PageDef; coming?: readonly ComingDef[] }) {
  return (
    <nav aria-label={label}>
      <ul className="space-y-1">
        {coming.map((c) => (
          <li key={c.key}>
            {/* Below sm only the icon shows: the title and name keep each entry named. */}
            <span aria-disabled="true" title={t(`page.${c.key}` as MessageKey)} className={cn(LINK_ROW, "cursor-not-allowed text-zinc-500 dark:text-zinc-400")}>
              <c.icon aria-hidden className="size-4 shrink-0" />
              <span className="max-sm:sr-only">{t(`page.${c.key}` as MessageKey)}</span>
              <span className="ml-auto text-xs max-sm:sr-only">{t("nav.coming")}</span>
            </span>
          </li>
        ))}
        {pages.map((p) => (
          <li key={p.path}>
            <Link
              href={BASE + p.path}
              aria-current={p === current ? "page" : undefined}
              title={pageLabel(p)}
              aria-label={pageLabel(p)}
              className={cn(LINK_ROW, "hover:bg-zinc-100 dark:hover:bg-zinc-800", p === current && "bg-zinc-100 font-medium dark:bg-zinc-800")}
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
  const [dialog, setDialog] = useState<"search" | "help" | null>(null);
  useShortcuts({ navigate, openSearch: () => setDialog("search"), openHelp: () => setDialog("help"), path });
  const route = routeFor(path);
  // An old page path (/app/workers, /app/users) swaps itself for its new one in the address bar.
  const moved = redirectFor(path);
  useEffect(() => {
    if (moved) navigate(moved, true);
  }, [moved]);
  // A run's transcript (items/<id>/runs/<run>), under Work like an item page.
  const transcript = transcriptRoute(path);
  const current = transcript ? routeFor(`${BASE}items`).page : route.page;
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    saveTheme(next);
    setTheme(next);
  };
  const needs = overview.data?.needs_you;
  const View = VIEWS[route.page.path] ?? NeedsYouPage;
  useEffect(() => {
    // The Needs you count leads the tab title, so a background tab shows it: "(4) Needs you · software-factory".
    const count = needs ? `(${needs}) ` : "";
    document.title = `${count}${transcript ? "Run transcript" : route.itemId ? "Work item" : pageLabel(route.page)} · software-factory`;
  }, [route.page, route.itemId, transcript, needs]);

  return (
    <NavProvider value={navigate}>
      <div className="flex min-h-dvh bg-white font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <aside aria-label={t("nav.sidebar")} className="w-44 shrink-0 border-r border-zinc-200 p-3 max-sm:w-14 dark:border-zinc-800">
          <p className="mb-4 px-2 text-sm font-semibold max-sm:hidden">{t("app.name")}</p>
          <SideLinks label={t("nav.tasks")} pages={[]} coming={TASK_ENTRIES} current={current} />
          <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <SideLinks label={t("nav.factory")} pages={pagesIn("factory")} current={current} />
          </div>
          {/* Collapsed until opened, or while one of its pages shows. */}
          <details className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800" open={current.group === "system" || undefined}>
            <summary className={cn(LINK_ROW, "cursor-pointer list-none text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800")}>
              <Wrench aria-hidden className="size-4 shrink-0" />
              <span className="max-sm:sr-only">{t("nav.system")}</span>
            </summary>
            <div className="mt-1">
              <SideLinks label={t("nav.system")} pages={pagesIn("system")} current={current} />
            </div>
          </details>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Wraps instead of widening the page on a narrow screen. */}
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
            <Link
              href={BASE}
              data-testid="needs-you"
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-sm font-medium whitespace-nowrap tabular-nums",
                needs ? "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100" : "bg-zinc-100 dark:bg-zinc-800",
              )}
            >
              {t("topbar.needsYou", { count: needs ?? "…" })}
            </Link>
            <ModeSwitch floating />
            <Link href={`${BASE}settings`} className={cn("shrink-0 text-sm whitespace-nowrap", LINK_CLASS)}>
              {t("topbar.settings")}
            </Link>
            <span className="ml-auto shrink-0 text-sm whitespace-nowrap text-zinc-600 tabular-nums dark:text-zinc-400" aria-live="polite">
              {overview.isError ? t("topbar.updateFailed") : <Ago at={overview.dataUpdatedAt} />}
            </span>
            <Button aria-label={t("search.open")} className="shrink-0" onClick={() => setDialog("search")}>
              <Search aria-hidden className="size-4" />
            </Button>
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
        {dialog === "search" && <SearchDialog navigate={navigate} onClose={() => setDialog(null)} />}
        {dialog === "help" && <HelpDialog onClose={() => setDialog(null)} />}
      </div>
    </NavProvider>
  );
}
