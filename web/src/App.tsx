import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { API, type Overview, POLL_MS, WEB_REV, getJson } from "./api.js";
import { Brand } from "./components/ui/brand.js";
import { Button } from "./components/ui/button.js";
import { t } from "./i18n/index.js";
import { cn } from "./lib/cn.js";
import { useShortcuts } from "./keys.js";
import { Link, NavProvider, useLocationPath } from "./nav.js";
import { BASE, pagesIn, redirectFor, routeFor } from "./pages.js";
import { HelpDialog, SearchDialog } from "./search.js";
import { SideLinks, pageLabel } from "./shell/sidebar.js";
import { ThemeControl } from "./shell/top-bar.js";
import { type ThemeChoice, applyChoice, saveChoice, storedChoice } from "./theme.js";
import { DataPage } from "./views/data.js";
import { HealthPage, ItemPage, ItemsPage, RunnersPage } from "./views/pages.js";
import { PluginsPage } from "./views/plugins.js";
import { SettingsPage } from "./views/settings.js";
import { ModeSwitch } from "./views/settings/general.js";
import { RevisionBanner } from "./views/system-banner.js";
import { TranscriptView, transcriptRoute } from "./views/transcript.js";
import { RulesPage } from "./views/rules.js";
import { ProposalsPage } from "./views/proposals.js";
import { CalendarPage } from "./views/calendar.js";
import { TasksPage } from "./views/tasks.js";
import { WorkersPage } from "./views/workers.js";

const VIEWS: Record<string, () => JSX.Element> = {
  items: ItemsPage,
  tasks: TasksPage,
  calendar: CalendarPage,
  runners: RunnersPage,
  workers: WorkersPage,
  health: HealthPage,
  rules: RulesPage,
  proposals: ProposalsPage,
  settings: SettingsPage,
  data: DataPage,
  plugins: PluginsPage,
};

/** The app (design §9): sidebar, top bar (mode, update failed, search, refresh, theme) and the current page. */
export function App() {
  const overview = useQuery({
    queryKey: [API.overview],
    queryFn: () => getJson<Overview>(API.overview),
    refetchInterval: POLL_MS,
    // Hidden tab: no polling (TanStack Query reads document.visibilityState).
    refetchIntervalInBackground: false,
  });
  const client = useQueryClient();
  const fetching = useIsFetching();
  const [choice, setChoice] = useState<ThemeChoice>(storedChoice);
  // System listens for the system colour scheme; the cleanup removes that listener when the choice changes.
  useEffect(() => applyChoice(choice), [choice]);
  const [path, navigate] = useLocationPath();
  const [dialog, setDialog] = useState<"search" | "help" | null>(null);
  useShortcuts({ navigate, openSearch: () => setDialog("search"), openHelp: () => setDialog("help"), path });
  const route = routeFor(path);
  // An old page path (/app/queue) swaps itself for its new one in the address bar, keeping its query.
  const moved = redirectFor(path, location.search);
  useEffect(() => {
    if (moved) navigate(moved, true);
  }, [moved]);
  // A run's transcript (items/<id>/runs/<run>), under Work like an item page.
  const transcript = transcriptRoute(path);
  const current = transcript ? routeFor(`${BASE}items`).page : route.page;
  const choose = (next: ThemeChoice) => {
    saveChoice(next);
    setChoice(next);
  };
  const needs = overview.data?.needs_you;
  const View = VIEWS[route.page.path] ?? TasksPage;
  useEffect(() => {
    // The Needs you count leads the tab title, so a background tab shows it: "(4) Needs you · Gongbang".
    const count = needs ? `(${needs}) ` : "";
    document.title = `${count}${transcript ? t("app.runTranscript") : route.itemId ? t("app.workItem") : pageLabel(route.page)} · ${t("app.name")}`;
  }, [route.page, route.itemId, transcript, needs]);

  return (
    <NavProvider value={navigate}>
      {/* A window-high shell: the content column scrolls, so the sidebar stays in view without sticky or fixed. */}
      <div className="flex h-dvh bg-bg font-sans text-text-1">
        {/* Scrolls by itself when it is taller than the window. */}
        <aside
          aria-label={t("nav.sidebar")}
          className="flex w-44 shrink-0 flex-col overflow-y-auto border-r border-border bg-(--sidebar) p-3 max-sm:w-14"
        >
          <Brand />
          <SideLinks label={t("nav.tasks")} pages={pagesIn("tasks")} current={current} badges={{ tasks: needs }} />
          <div className="mt-3 border-t border-border pt-3">
            <SideLinks label={t("nav.system")} pages={pagesIn("system")} current={current} />
          </div>
          <div className="mt-auto pt-3">
            <div className="border-t border-border pt-3">
              <SideLinks label={t("nav.setup")} pages={pagesIn("bottom")} current={current} />
            </div>
          </div>
        </aside>
        <div data-scroll-root className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {/* Wraps instead of widening the page on a narrow screen. */}
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
            <ModeSwitch floating />
            <span className="ml-auto shrink-0 text-sm whitespace-nowrap text-text-2" aria-live="polite">
              {overview.isError ? t("topbar.updateFailed") : null}
            </span>
            <Button variant="ghost" size="icon" aria-label={t("search.open")} className="shrink-0" onClick={() => setDialog("search")}>
              <Search aria-hidden className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label={t("topbar.refresh")} className="shrink-0" onClick={() => void client.invalidateQueries()}>
              <RefreshCw aria-hidden className={cn("size-4", fetching > 0 && "animate-spin motion-reduce:animate-none")} />
            </Button>
            <ThemeControl choice={choice} onChoose={choose} />
          </header>
          <RevisionBanner server={overview.data?.server_rev} web={WEB_REV} />
          <main className="min-w-0 p-4">
            {transcript ? (
              <TranscriptView key={`${transcript.itemId}/${transcript.runId}`} itemId={transcript.itemId} runId={transcript.runId} />
            ) : route.itemId ? (
              <ItemPage key={route.itemId} id={route.itemId} />
            ) : moved ? null : (
              // An old path shows nothing while it swaps itself, so the new page starts with its own query.
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
