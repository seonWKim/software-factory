// @vitest-environment jsdom
// Dashboard shell tests: one queued count, app pages, unreviewed merges, system actions and revisions. Shared setup is in ui-shell-fixtures.tsx.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { redirectFor } from "../web/src/pages.js";
import { ItemsTable } from "../web/src/views/common.js";
import { API, POLL_MS } from "../web/src/api.js";
import { RevisionBanner, SEEN_REV_KEY } from "../web/src/views/system-banner.js";
import { VIEW_KEY } from "../web/src/views/tree.js";
import { AT, overview, row, items, runs, queue, RESPONSES, state, installShellFixtures, waitBadge, mount } from "./ui-shell-fixtures.js";

installShellFixtures();

describe("one queued count", () => {
  it("Work's Queued filter tab and overview.queued are the same number of queued runs", async () => {
    history.replaceState(null, "", "/app/items");
    mount();
    const filters = await screen.findByRole("tablist", { name: "Filter by state" });
    expect(await within(filters).findByRole("tab", { name: `Queued ${queue.queue.length}` })).toBeTruthy();
    expect(queue.queue.length).toBe(overview.queued);
  });

  it("/app/queue redirects to Work with the Queued filter pressed, showing the queued runs", async () => {
    history.replaceState(null, "", "/app/queue");
    mount();
    await vi.waitFor(() => expect(location.pathname + location.search).toBe("/app/items?state=queued"));
    const filters = screen.getByRole("tablist", { name: "Filter by state" });
    expect(within(filters).getByRole("tab", { name: /^Queued/ }).getAttribute("aria-selected")).toBe("true");
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

  it("the sidebar's Tasks group links the Tasks page, the System group shows its links, and there is no Users", () => {
    mount();
    const tasks = screen.getByRole("navigation", { name: "Tasks" });
    expect([...tasks.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/app/tasks", "/app/calendar"]);
    const system = screen.getByRole("navigation", { name: "System" });
    expect(within(system).getByRole("link", { name: "Health" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
  });

  it("the sidebar links Workers after Health; Activity, Failures, Spend, Runners and Data are not among them", () => {
    mount();
    const side = screen.getByRole("complementary", { name: "Sidebar" });
    const links = [...side.querySelectorAll("a")].filter((a) => a.getAttribute("href")?.startsWith("/app/") && a.getAttribute("href") !== "/app/");
    expect(links.map((a) => [a.getAttribute("aria-label"), a.getAttribute("href")])).toEqual([
      ["Tasks", "/app/tasks"], ["Calendar", "/app/calendar"], ["Work", "/app/items"], ["Health", "/app/health"], ["Workers", "/app/workers"],
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

  it("/app/workers opens the Workers page with no redirect; /app/runners still opens Runners; /app/users is no longer an old path", async () => {
    history.replaceState(null, "", "/app/workers");
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "Workers" })).toBeTruthy();
    expect(location.pathname).toBe("/app/workers");
    expect(redirectFor("/app/workers")).toBeNull();
    cleanup();
    history.replaceState(null, "", "/app/runners");
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "Runners" })).toBeTruthy();
    expect(location.pathname).toBe("/app/runners");
    expect(redirectFor("/app/users")).toBeNull();
  });

  it("/app/spend, /app/failures and /app/activity redirect, keeping the query; /app/queue still does", async () => {
    expect(redirectFor("/app/spend")).toBe("/app/health#spend");
    expect(redirectFor("/app/failures")).toBe("/app/health#failures");
    expect(redirectFor("/app/failures", "?window=7d")).toBe("/app/health?window=7d#failures");
    expect(redirectFor("/app/activity")).toBe("/app/items");
    expect(redirectFor("/app/queue")).toBe("/app/items?state=queued");
    for (const [from, to] of [
      ["/app/spend", "/app/health#spend"],
      ["/app/failures?window=7d", "/app/health?window=7d#failures"],
      ["/app/activity", "/app/items"],
    ] as const) {
      history.replaceState(null, "", from);
      mount();
      await vi.waitFor(() => expect(location.pathname + location.search + location.hash).toBe(to));
      cleanup();
    }
  });

  it("Health has Spend and Failures sections as level-2 headings under its one h1; Work holds the Activity content", async () => {
    history.replaceState(null, "", "/app/health");
    mount();
    expect(await screen.findByRole("heading", { level: 2, name: "Spend" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Failures" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    cleanup();
    history.replaceState(null, "", "/app/items");
    mount();
    expect(await screen.findByRole("table", { name: "Running now" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("every sidebar page has exactly one h1, its menu name, from its own PageHeader", async () => {
    const names: Record<string, string> = { "": "Tasks", tasks: "Tasks", calendar: "Calendar", items: "Work", runners: "Runners", health: "Health", rules: "Rules", data: "Data", settings: "Settings" };
    for (const [path, name] of Object.entries(names)) {
      history.replaceState(null, "", `/app/${path}`);
      mount();
      await screen.findByRole("heading", { level: 1, name });
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      cleanup();
    }
  });

  it("every page's h1 is in the page title type, and every h2 is the title of a Card (Health's Spend and Failures too)", async () => {
    const names: Record<string, string> = { tasks: "Tasks", calendar: "Calendar", items: "Work", runners: "Runners", health: "Health", rules: "Rules", plugins: "Plugins", data: "Data", settings: "Settings" };
    const outside = () => screen.queryAllByRole("heading", { level: 2 }).filter((h) => !h.closest("section.rounded-card.bg-surface.shadow-sm")).map((h) => h.textContent);
    for (const [path, name] of Object.entries(names)) {
      history.replaceState(null, "", `/app/${path}`);
      mount();
      expect((await screen.findByRole("heading", { level: 1, name })).className).toContain("text-xl font-semibold");
      if (path === "health") await screen.findByRole("heading", { level: 2, name: "Failures" });
      if (path === "items") await screen.findByRole("table", { name: "Running now" });
      expect(outside(), path).toEqual([]);
      cleanup();
    }
  });

  it("each page's heading matches its menu name", async () => {
    const names: Record<string, string> = { items: "Work", runners: "Runners", health: "Health", data: "Data", settings: "Settings" };
    for (const [path, name] of Object.entries(names)) {
      history.replaceState(null, "", `/app/${path}`);
      mount();
      expect(screen.getByRole("heading", { level: 1, name })).toBeTruthy();
      cleanup();
    }
  });

  it("an item link opens its page: runs with their error, the timeline, and a way back", async () => {
    mount();
    fireEvent.click(await screen.findByText("Spec waiting"));
    expect(location.pathname).toBe("/app/items/wi_1");
    expect(await screen.findByText("git_failed")).toBeTruthy();
    expect(screen.getByText(": git merge: boom", { exact: false })).toBeTruthy();
    expect(screen.getByText("intake")).toBeTruthy();
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

  it("Health tabs: Checks by default, counts in the labels, a failing check marks its tab, an unknown tab selects Checks, a click keeps the history length", async () => {
    history.replaceState(null, "", "/app/health?tab=nonsense");
    mount();
    await screen.findByText("push access denied");
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((x) => x.textContent!.replace(/\s*\(.*$/, ""))).toEqual(["Checks", "Host sleeps", "Merged without review", "Efficiency"]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]!.textContent).toContain("(2)");
    expect(tabs[0]!.textContent).toContain("failing");
    expect(tabs[1]!.textContent).toContain("(0)");
    const length = history.length;
    fireEvent.click(tabs[1]!);
    expect(location.search).toBe("?tab=sleeps");
    expect(history.length).toBe(length);
    expect(screen.getByText("No host sleep recorded.")).toBeTruthy();
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
    history.replaceState(null, "", "/app/health?tab=merges");
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

// ---- ItemsTable (issue #240): title link, Issue and PR columns only with the GitHub plugin ----

describe("system actions, revisions and the tab title (issue #311)", () => {
  const BANNER = "Dashboard out of date: reload / restart factory ui";

  it("a revision mismatch shows the banner; equal or unknown revisions show none", () => {
    const { container, rerender } = render(<RevisionBanner server={"a".repeat(40)} web={"b".repeat(40)} />);
    expect(screen.getByTestId("revision-banner").textContent).toBe(BANNER);
    expect(screen.getByRole("alert").querySelector("code")!.textContent).toBe("factory ui");
    rerender(<RevisionBanner server={"a".repeat(40)} web={"a".repeat(40)} />);
    expect(container.textContent).toBe("");
    rerender(<RevisionBanner server={null} web={"a".repeat(40)} />);
    expect(container.textContent).toBe("");
    rerender(<RevisionBanner server={"a".repeat(40)} web={null} />);
    expect(container.textContent).toBe("");
  });

  it("the tab title leads with the Needs you count, and has no prefix at 0", async () => {
    mount();
    await waitBadge();
    await vi.waitFor(() => expect(document.title).toBe("(4) Tasks · Gongbang"));
    cleanup();
    const before = overview.needs_you;
    overview.needs_you = 0;
    try {
      mount();
      await vi.waitFor(() => expect(document.title).toBe("Tasks · Gongbang"));
    } finally {
      overview.needs_you = before;
    }
  });

  it("the Tasks page lists each system action with its command as a row in the Needs you section's Check group", async () => {
    const actions = [
      { code: "migration_pending", text: "Schema at version 3 of 8", command: "Migrate now, or factory migrate", until: null, work_item_id: null },
      { code: "claim_pause", text: "Claim pause rate_limit in effect, until 2026-11-07T01:00:00.000Z", command: "factory resume rate_limit", until: "2026-11-07T01:00:00.000Z", work_item_id: null },
    ];
    (overview as Record<string, unknown>).system_actions = actions;
    try {
      mount();
      const list = await screen.findByRole("list", { name: "Check" });
      const rows = [...list.querySelectorAll("li")];
      expect(rows.map((r) => r.getAttribute("data-check"))).toEqual(["migration_pending", "claim_pause"]);
      expect(rows[0]!.textContent).toContain("Schema at version 3 of 8");
      expect(rows[0]!.querySelector("code")!.textContent).toBe("Migrate now, or factory migrate");
      expect(rows[1]!.querySelector("code")!.textContent).toBe("factory resume rate_limit");
      // The rows are inside the Needs you section, not lines after it.
      expect(screen.getByRole("region", { name: "Needs you" }).contains(list)).toBe(true);
      expect(screen.queryByRole("list", { name: "System actions" })).toBeNull();
    } finally {
      delete (overview as Record<string, unknown>).system_actions;
    }
  });

  it("Health folds ok rows behind their count; warn and fail rows stay visible", async () => {
    const checks = [
      ...Array.from({ length: 22 }, (_, i) => ({ status: "ok", msg: `fine ${i}` })),
      { status: "warn", msg: "token expires in 2 days" },
      { status: "fail", msg: "push access denied" },
    ];
    const saved = RESPONSES["/api/v1/health"];
    RESPONSES["/api/v1/health"] = { checked_at: AT, checks };
    try {
      history.replaceState(null, "", "/app/health");
      mount();
      await screen.findByText("push access denied");
      const folded = screen.getByTestId("ok-checks") as HTMLDetailsElement;
      expect(folded.open).toBe(false);
      expect(folded.querySelector("summary")!.textContent).toBe("22 ok");
      expect(folded.querySelectorAll("li")).toHaveLength(22);
      for (const msg of ["token expires in 2 days", "push access denied"]) expect(folded.textContent).not.toContain(msg);
    } finally {
      RESPONSES["/api/v1/health"] = saved;
    }
  });
});


// ---- The factory update note and the header revision (design 09-dashboard-shell) ----

describe("factory update note and header revision", () => {
  const OLD = "c0147aa0000";
  const NEW = "3dc0029bbbb";
  const UPDATED = {
    ...overview.factory, state: "running", rev: NEW, previous_rev: OLD, behind: 0,
    changes: { count: 12, subjects: ["Tell the open tab when the factory updated", "Fix the header size"] },
  };
  /** Runs `body` with the overview's factory object set to `factory`, then puts the fixture's back. */
  async function withFactory(factory: unknown, body: () => Promise<void>) {
    const saved = overview.factory;
    (overview as Record<string, unknown>).factory = factory;
    try {
      await body();
    } finally {
      (overview as Record<string, unknown>).factory = saved;
    }
  }
  const poll = () => act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS + 10)));

  it("a first visit (no stored revision) shows no note and stores the running one", async () => {
    await withFactory(UPDATED, async () => {
      mount();
      await waitBadge();
      await vi.waitFor(() => expect(localStorage.getItem(SEEN_REV_KEY)).toBe(NEW));
      expect(screen.queryByTestId("update-note")).toBeNull();
    });
  });

  it("a revision change seen while the tab is open shows one note with the count and the change list", async () => {
    await withFactory({ ...UPDATED, rev: OLD, previous_rev: null, changes: null }, async () => {
      mount();
      await waitBadge();
      await vi.waitFor(() => expect(localStorage.getItem(SEEN_REV_KEY)).toBe(OLD));
      expect(screen.queryByTestId("update-note")).toBeNull();
      (overview as Record<string, unknown>).factory = UPDATED;
      await poll();
      const note = await screen.findByTestId("update-note");
      expect(note.querySelector("[data-update-text]")!.textContent).toBe("Updated to 3dc0029: 12 changes");
      expect(screen.getAllByTestId("update-note")).toHaveLength(1);
      fireEvent.click(within(note).getByText("Changes"));
      const subjects = [...note.querySelectorAll("li")].map((li) => li.textContent);
      expect(subjects).toEqual(UPDATED.changes.subjects);
      await poll(); // a poll for the same revision keeps the one note
      expect(screen.getAllByTestId("update-note")).toHaveLength(1);
    });
  });

  it("Dismiss hides the note for that revision: not back on a poll or a reload", async () => {
    localStorage.setItem(SEEN_REV_KEY, OLD); // a stored earlier revision: the note shows on load
    await withFactory(UPDATED, async () => {
      mount();
      const note = await screen.findByTestId("update-note");
      fireEvent.click(within(note).getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByTestId("update-note")).toBeNull();
      await poll();
      expect(screen.queryByTestId("update-note")).toBeNull();
      cleanup();
      mount();
      await waitBadge();
      await poll();
      expect(screen.queryByTestId("update-note")).toBeNull();
    });
  });

  it("a git failure (no count) names the revision without a count and lists nothing", async () => {
    localStorage.setItem(SEEN_REV_KEY, OLD);
    await withFactory({ ...UPDATED, changes: { count: null, subjects: [] } }, async () => {
      mount();
      const note = await screen.findByTestId("update-note");
      expect(note.querySelector("[data-update-text]")!.textContent).toBe("Updated to 3dc0029");
      expect(within(note).queryByText("Changes")).toBeNull();
    });
  });

  it("the header shows the running short revision and its state; only the revision without behind; nothing without a factory", async () => {
    await withFactory(UPDATED, async () => {
      mount();
      await vi.waitFor(() => expect(screen.getByTestId("factory-rev").textContent).toBe("3dc0029 · up to date"));
    });
    cleanup();
    await withFactory({ ...UPDATED, behind: 3 }, async () => {
      mount();
      await vi.waitFor(() => expect(screen.getByTestId("factory-rev").textContent).toBe("3dc0029 · 3 behind"));
    });
    cleanup();
    const { behind: _, ...selfHosting } = UPDATED;
    await withFactory(selfHosting, async () => {
      mount();
      await vi.waitFor(() => expect(screen.getByTestId("factory-rev").textContent).toBe("3dc0029"));
    });
    cleanup();
    await withFactory(null, async () => {
      mount();
      await waitBadge();
      expect(screen.queryByTestId("factory-rev")).toBeNull();
      expect(screen.queryByTestId("update-note")).toBeNull();
    });
  });
});
