// @vitest-environment jsdom
// Dashboard shell tests: one queued count, app pages and unreviewed merges. Shared setup is in ui-shell-fixtures.tsx.
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { redirectFor } from "../web/src/pages.js";
import { API } from "../web/src/api.js";
import { VIEW_KEY } from "../web/src/views/tree.js";
import { AT, overview, items, runs, queue, state, installShellFixtures, mount } from "./ui-shell-fixtures.js";

installShellFixtures();

describe("one queued count", () => {
  it("Work's Queued filter tab and overview.queued are the same number of queued runs", async () => {
    history.replaceState(null, "", "/app/items");
    mount();
    const filters = await screen.findByRole("tablist", { name: "Filter by state" });
    // Queued is a state of the Active group: its tab is in the second row once Active is chosen.
    fireEvent.click(await within(filters).findByRole("tab", { name: /^Active/ }));
    const states = await screen.findByRole("tablist", { name: "Filter Active by state" });
    expect(await within(states).findByRole("tab", { name: `Queued ${queue.queue.length}` })).toBeTruthy();
    expect(queue.queue.length).toBe(overview.queued);
  });

  it("/app/queue redirects to Work with the Queued filter pressed, showing the queued runs", async () => {
    history.replaceState(null, "", "/app/queue");
    mount();
    await vi.waitFor(() => expect(location.pathname + location.search).toBe("/app/items?state=queued"));
    const filters = screen.getByRole("tablist", { name: "Filter by state" });
    expect(within(filters).getByRole("tab", { name: /^Active/ }).getAttribute("aria-selected")).toBe("true");
    const states = screen.getByRole("tablist", { name: "Filter Active by state" });
    expect(within(states).getByRole("tab", { name: /^Queued/ }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("table", { name: "Queued runs" })).toBeTruthy();
  });

  it("an unknown state value leaves no filter pressed", async () => {
    history.replaceState(null, "", "/app/items?state=nonsense");
    mount();
    const filters = await screen.findByRole("tablist", { name: "Filter by state" });
    expect(within(filters).getByRole("tab", { name: /^All/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("the Queued filter lists the runs in the server's order with their start times", async () => {
    const saved = queue.queue.slice() as unknown[];
    const later = "2099-01-01T00:00:00.000Z";
    queue.queue.splice(0, queue.queue.length,
      { position: 1, id: "run_a", kind: "implement", work_item_id: "wi_3", attempt: 0, created_at: AT, not_before: AT } as never,
      { position: 2, id: "run_c", kind: "implement", work_item_id: "wi_1", attempt: 1, created_at: AT, not_before: later } as never);
    try {
      history.replaceState(null, "", "/app/items?state=queued");
      mount();
      const table = await screen.findByRole("table", { name: "Queued runs" });
      const rows = [...table.querySelectorAll("tbody tr")];
      expect(rows.map((r) => r.getAttribute("data-key"))).toEqual(["run_a", "run_c"]);
      expect(rows.map((r) => r.querySelector("td")?.textContent)).toEqual(["1", "2"]);
      expect(within(rows[0] as HTMLElement).getByText("now")).toBeTruthy();
      expect(rows[1]!.textContent).toMatch(/in \d/);
    } finally {
      queue.queue.splice(0, queue.queue.length, ...(saved as typeof queue.queue));
    }
  });
});


describe("app pages", () => {
  it("/app/ opens the Tasks page with what needs you in its section; Work shows what runs", async () => {
    mount();
    // An update in progress is no page banner and there is no header status.
    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toBeTruthy();
    expect(screen.queryByTestId("factory-status")).toBeNull();
    expect(screen.queryByTestId("factory-banner")).toBeNull();
    await vi.waitFor(() => expect(location.pathname).toBe("/app/tasks"));
    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(within(needs).getByText("Spec waiting")).toBeTruthy();
    expect(within(needs).queryByText("Being built")).toBeNull();
    expect(screen.queryByRole("table", { name: "Running now" })).toBeNull();
    cleanup();
    history.replaceState(null, "", "/app/items");
    mount();
    expect(screen.getByRole("heading", { level: 1, name: "Work" })).toBeTruthy();
    const running = await screen.findByRole("table", { name: "Running now" });
    expect(within(running).getByText("Being built")).toBeTruthy();
  });

  it("the sidebar leads with Chat (owner 2026-11-27: \"Chat should be the first menu\") and ends its System block with Work, Health; Activity, Failures, Spend, Runners and Data are not among them", () => {
    mount();
    const side = screen.getByRole("complementary", { name: "Sidebar" });
    const links = [...side.querySelectorAll("a")].filter((a) => a.getAttribute("href")?.startsWith("/app/") && a.getAttribute("href") !== "/app/");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Chat", "/app/chat"], ["Tasks", "/app/tasks"], ["Calendar", "/app/calendar"], ["Schedules", "/app/schedules"], ["Work", "/app/items"], ["Health", "/app/health"],
      ["Rules", "/app/rules"], ["Plugins", "/app/plugins"], ["Settings", "/app/settings"],
    ]);
    for (const gone of ["Activity", "Failures", "Spend", "Runners", "Data"]) expect(within(side).queryByRole("link", { name: gone })).toBeNull();
  });

  it("the bottom block lists Rules, Plugins and Settings under no visible title, below Work and Health, with dividers between the blocks", () => {
    mount();
    const tasks = screen.getByRole("navigation", { name: "Tasks" });
    const system = screen.getByRole("navigation", { name: "System" });
    const setup = screen.getByRole("navigation", { name: "Setup" });
    expect([...setup.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/app/rules", "/app/plugins", "/app/settings"]);
    expect(setup.hasAttribute("aria-labelledby")).toBe(false);
    expect(setup.querySelector("p")).toBeNull();
    expect(tasks.compareDocumentPosition(system) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(system.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const nav of [system, setup]) {
      expect(nav.closest("div")!.className.split(" ")).toEqual(expect.arrayContaining(["border-t", "pt-3"]));
    }
    expect(setup.closest("aside > div")!.className.split(" ")).toContain("mt-auto");
    for (const name of ["Rules", "Plugins"]) {
      expect(within(setup).getByRole("link", { name })).toBeTruthy();
      expect(within(system).queryByRole("link", { name })).toBeNull();
    }
  });

  it("the sidebar has no Routines entry, and an old /app/routines link lands on the Schedules page", async () => {
    // The Routines page was removed (design 09-dashboard-routines): routines become Check a page schedules.
    mount();
    const side = screen.getByRole("complementary", { name: "Sidebar" });
    expect(within(side).queryByRole("link", { name: "Routines" })).toBeNull();
    expect(side.querySelector('a[href^="/app/routines"]')).toBeNull();
    cleanup();
    expect(redirectFor("/app/routines")).toBe("/app/schedules");
    history.replaceState(null, "", "/app/routines");
    mount();
    await vi.waitFor(() => expect(location.pathname + location.search).toBe("/app/schedules"));
    expect(await screen.findByRole("heading", { level: 1, name: "Schedules" })).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Tasks" })).getByRole("link", { name: "Schedules" }).getAttribute("aria-current")).toBe("page");
  });

  it("/app/workers redirects to Health's Runs tab and keeps its query; Workers is not in the sidebar; /app/users is not an old path", async () => {
    expect(redirectFor("/app/workers")).toBe("/app/health?tab=runs");
    expect(redirectFor("/app/workers", "?x=1")).toBe("/app/health?tab=runs&x=1");
    expect(redirectFor("/app/users")).toBeNull();
    history.replaceState(null, "", "/app/workers");
    mount();
    await vi.waitFor(() => expect(location.pathname + location.search).toBe("/app/health?tab=runs"));
    expect(within(screen.getByRole("complementary", { name: "Sidebar" })).queryByRole("link", { name: "Workers" })).toBeNull();
  });

  it("/app/spend, /app/failures and /app/runners redirect to their Health tab, keeping the query; /app/queue still does", async () => {
    expect(redirectFor("/app/spend")).toBe("/app/health?tab=spend");
    expect(redirectFor("/app/failures")).toBe("/app/health?tab=failures");
    expect(redirectFor("/app/failures", "?window=7d")).toBe("/app/health?tab=failures&window=7d");
    expect(redirectFor("/app/runners")).toBe("/app/health?tab=runners");
    expect(redirectFor("/app/queue")).toBe("/app/items?state=queued");
    for (const [from, to] of [
      ["/app/spend", "/app/health?tab=spend"],
      ["/app/failures?window=7d", "/app/health?tab=failures&window=7d"],
      ["/app/runners", "/app/health?tab=runners"],
    ] as const) {
      history.replaceState(null, "", from);
      mount();
      await vi.waitFor(() => expect(location.pathname + location.search + location.hash).toBe(to));
      cleanup();
    }
  });

  it("Health draws Spend and Failures only in their tabs, as level-2 headings under its one h1; Work holds the Activity content", async () => {
    history.replaceState(null, "", "/app/health");
    mount();
    await screen.findByText("push access denied");
    // The Overview tab: neither section draws below the tabs, and the Failures window switch is not shown.
    expect(screen.queryByRole("heading", { level: 2, name: "Spend" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "Failures" })).toBeNull();
    expect(document.querySelector("[data-failures-window]")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Cost" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Spend" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Failures" })).toBeNull();
    // Runs holds Runners, Failures (its window switch in the toolbar) and Host sleeps, in that order.
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Failures" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Host sleeps" })).toBeTruthy();
    expect([...document.querySelectorAll("[data-health-section]")].map((e) => e.getAttribute("data-health-section"))).toEqual(["runners", "timeline", "graph", "failures", "sleeps"]);
    expect(document.querySelector("[data-failures-window]")).not.toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    cleanup();
    history.replaceState(null, "", "/app/items");
    mount();
    expect(await screen.findByRole("table", { name: "Running now" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("every sidebar page has exactly one h1, its menu name, from its own PageHeader", async () => {
    const names: Record<string, string> = { "": "Tasks", tasks: "Tasks", calendar: "Calendar", chat: "Chat", items: "Work", health: "Health", rules: "Rules", data: "Data", settings: "Settings" };
    for (const [path, name] of Object.entries(names)) {
      history.replaceState(null, "", `/app/${path}`);
      mount();
      await screen.findByRole("heading", { level: 1, name });
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      cleanup();
    }
  });

  it("Tasks and Work each say in their header what they are for", async () => {
    for (const [path, name, text] of [["tasks", "Tasks", "Tasks = what I plan and what needs me"], ["items", "Work", "Work = what the factory is doing"]] as const) {
      history.replaceState(null, "", `/app/${path}`);
      mount();
      const h1 = await screen.findByRole("heading", { level: 1, name });
      expect(h1.closest("header")!.textContent).toContain(text);
      cleanup();
    }
  });

  it("every page's h1 is in the page title type, and every h2 is the title of a Card (Health's Spend and Failures too) or the Calendar's period in its toolbar", async () => {
    const names: Record<string, string> = { tasks: "Tasks", calendar: "Calendar", items: "Work", "health?tab=runners": "Health", "health?tab=failures": "Health", rules: "Rules", plugins: "Plugins", data: "Data", settings: "Settings" };
    // The one exception: the Calendar's period heading sits in its toolbar line (09-dashboard-tasks-calendar).
    const outside = () => screen.queryAllByRole("heading", { level: 2 }).filter((h) => !h.closest("section.rounded-card.bg-surface.shadow-sm, [data-calendar-toolbar]")).map((h) => h.textContent);
    for (const [path, name] of Object.entries(names)) {
      history.replaceState(null, "", `/app/${path}`);
      mount();
      expect((await screen.findByRole("heading", { level: 1, name })).className).toContain("text-xl font-semibold");
      if (path === "health?tab=failures") await screen.findByRole("heading", { level: 2, name: "Failures" });
      if (path === "health?tab=runners") await screen.findByRole("heading", { level: 2, name: "Worker processes" });
      if (path === "items") await screen.findByRole("table", { name: "Running now" });
      expect(outside(), path).toEqual([]);
      cleanup();
    }
  });

  it("an item link opens its page: runs with their error, the timeline, and a way back", async () => {
    mount();
    fireEvent.click(await screen.findByText("Spec waiting"));
    expect(location.pathname).toBe("/app/items/wi_1");
    const runs = await screen.findByRole("table", { name: "Runs" });
    // One error line in words; the code and the full text sit behind Details.
    expect(within(runs).getByText("A git command failed")).toBeTruthy();
    expect(runs.querySelector("[data-raw]")?.textContent).toContain("git merge: boom");
    expect(screen.getByText("Created by a person")).toBeTruthy();
    // The breadcrumb back to the list (the sidebar's entry is the current page).
    fireEvent.click(screen.getByRole("link", { name: "Work", current: false }));
    expect(location.pathname).toBe("/app/items");
  });

  it("the items page, in the List view, filters by state through the API's state parameter", async () => {
    localStorage.setItem(VIEW_KEY, "list");
    history.replaceState(null, "", "/app/items");
    mount();
    await screen.findByRole("table", { name: "Work items" });
    fireEvent.click(screen.getByRole("tab", { name: /^Needs you/ }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(state.fetched).toContain("/api/v1/items?state=needs");
  });

  it("Health tabs: Overview by default, five tabs, counts only for what waits on the owner, a failing check marks Overview, an unknown tab selects Overview, a click keeps the history length", async () => {
    history.replaceState(null, "", "/app/health?tab=nonsense");
    mount();
    await screen.findByText("push access denied");
    const tabs = screen.getAllByRole("tab");
    // One failing check (the ok one is not counted) and two unreviewed merges; Runs and Cost carry no count.
    expect(tabs.map((x) => x.textContent)).toEqual(["Overview (1) ⚠ failing", "Runs", "Cost", "Review (2)", "Activity"]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    const length = history.length;
    fireEvent.click(tabs[1]!);
    expect(location.search).toBe("?tab=runs");
    expect(history.length).toBe(length);
    expect(await screen.findByText("No host sleep recorded.")).toBeTruthy();
  });

  it("an old Health tab link opens the tab that now holds it and scrolls to that section; the first section of a tab needs no scroll", async () => {
    const scrolled: string[] = [];
    // jsdom has no scrolling: record which element the page asked to scroll into view.
    const proto = HTMLElement.prototype as { scrollIntoView?: unknown };
    const before = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.id);
    };
    try {
      const opens: [string, string, string | null][] = [
        ["sleeps", "Runs", "health-sleeps"], ["failures", "Runs", "health-failures"], ["runners", "Runs", null],
        ["spend", "Cost", null], ["efficiency", "Cost", "health-efficiency"], ["merges", "Review", null], ["checks", "Overview", null],
      ];
      for (const [old, tab, anchor] of opens) {
        scrolled.length = 0;
        history.replaceState(null, "", `/app/health?tab=${old}`);
        mount();
        await screen.findByRole("tablist", { name: "Health sections" });
        expect(screen.getByRole("tab", { selected: true }).textContent, old).toContain(tab);
        await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
        expect(document.getElementById(`health-${old}`), old).not.toBeNull();
        expect(scrolled, old).toEqual(anchor ? [anchor] : []);
        cleanup();
      }
    } finally {
      proto.scrollIntoView = before;
    }
  });

  it("health lists failing checks first", async () => {
    history.replaceState(null, "", "/app/health");
    mount();
    await screen.findByText("push access denied");
    const texts = [...document.querySelectorAll("main li")].map((li) => li.textContent);
    expect(texts[0]).toContain("push access denied");
  });
});

describe("unreviewed merges", () => {
  it("Work says how many PRs merged without review and links to Health; hidden at 0", async () => {
    history.replaceState(null, "", "/app/items");
    mount();
    const line = await screen.findByTestId("unreviewed-merges-line");
    expect(line.textContent).toContain("2 PRs merged without review in the last 7 days");
    fireEvent.click(within(line).getByRole("link"));
    expect(location.pathname).toBe("/app/health");
    cleanup();
    (overview as { unreviewed_merges_7d: number }).unreviewed_merges_7d = 0;
    try {
      history.replaceState(null, "", "/app/items");
      mount();
      await screen.findByRole("table", { name: "Running now" });
      expect(screen.queryByTestId("unreviewed-merges-line")).toBeNull();
    } finally {
      (overview as { unreviewed_merges_7d: number }).unreviewed_merges_7d = 2;
    }
  });

  it("Health lists them in a table: PR (linked only with a URL), merged by, short sha, when", async () => {
    history.replaceState(null, "", "/app/health?tab=review");
    mount();
    const t = await screen.findByRole("table", { name: "Merged without review" });
    expect([...t.querySelectorAll("th")].map((h) => h.textContent)).toEqual(["PR", "Merged by", "Merge commit", "When"]);
    const rows = [...t.querySelectorAll("tbody tr")] as HTMLElement[];
    expect(rows.map((r) => r.children[0]!.textContent)).toEqual(["#9", "#8"]);
    expect(rows[0]!.querySelector("a")!.getAttribute("href")).toBe("https://github.com/o/r/pull/9");
    expect(rows[1]!.querySelector("a")).toBeNull();
    // A person shows as plain text ("a person"; "you" for the viewer), the ID as the cell's tooltip: no disclosure, no Copy button.
    const by = rows[0]!.children[1]!;
    expect(by.textContent).toBe("a person");
    expect(by.querySelector("[title]")!.getAttribute("title")).toBe("github:7");
    expect(by.querySelector("details, button")).toBeNull();
    expect(rows[0]!.children[2]!.textContent).toBe("abcdef1");
  });
});
