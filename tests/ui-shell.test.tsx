// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemsTable, QueueTable, RunningTable } from "../web/src/views/common.js";
import { FactoryBanner } from "../web/src/views/pages.js";
import { ItemCommands, commandOutcome } from "../web/src/views/item-commands.js";
import { API, type Items, type ItemRow, useApi } from "../web/src/api.js";
import { STATUS_MS } from "../web/src/components/ui/dialog.js";
import { App } from "../web/src/App.js";
import { POLL_MS } from "../web/src/api.js";
import { THEME_KEY, paintChoice, storedChoice } from "../web/src/theme.js";
import { BANNER_LINK_CLASS } from "../web/src/components/ui/link-style.js";
import { RevisionBanner } from "../web/src/views/system-banner.js";
import { VIEW_KEY } from "../web/src/views/tree.js";

// The app shell (step 2 of #124, design §9): it fetches only /api/v1/*, polls every 3 s while the document is
// visible and not while it is hidden, and keeps the light/dark choice in browser storage.

const AT = "2026-11-07T00:00:00.000Z";
const overview = {
  as_of: AT, stages: { NEW: 1, RUNNING: 2 }, needs_you: 4, running: 1, queued: 1, last_24h: { succeeded: 3, failed: 1, tokens: 1500 },
  unreviewed_merges_7d: 2,
  factory: { state: "migration_pending", rev: "aaaaaaa1111", target_rev: "bbbbbbb2222", child_pid: 7, since: AT, workers: 3, error: null, pending: ["schema 12"] },
};
const row = (n: number, level: string, title: string, extra: object = {}) => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title, level,
  badges: [], stage: "RUNNING", tier: 2, kind: null, blocked_on: "none", blocked_reason: null, close_reason: null, run_status: null,
  change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 }, ...extra,
});
const items = {
  as_of: AT, total: 3,
  items: [
    row(1, "needs_approval", "Spec waiting", { stage: "READY", blocked_on: "human", badges: ["needs approval"] }),
    row(2, "running", "Being built"),
    row(3, "queued", "Waiting its turn"),
  ],
  facets: { allStates: 3, state: { needs: 1, needs_approval: 1, running: 1, queued: 1 } },
};
const runs = { as_of: AT, runs: [{ id: "run_a", status: "running", kind: "implement", work_item_id: "wi_2", attempt: 1, owner: "host:7:0", heartbeat_at: AT, started_at: AT, lease_expires_at: AT, created_at: AT }] };
const queue = { as_of: AT, queue: [{ position: 1, id: "run_b", kind: "implement", work_item_id: "wi_3", attempt: 0, created_at: AT, not_before: null }] };
const detail = {
  as_of: AT,
  item: { ...row(1, "needs_approval", "Spec waiting"), loop_count: 0, restart_count: 2, token_cost: 2_500_000, created_at: AT },
  timeline: [{ version: 1, at: AT, actor: { kind: "user", id: "github:1" }, reason: "intake", changes: { stage: { from: "null", to: '"NEW"' } }, detail: null }],
  runs: [{ id: "run_c", kind: "implement", status: "failed", attempt: 1, started_at: AT, finished_at: AT, created_at: AT, tokens: 10, error: { code: "git_failed", detail: "git merge: boom" } }],
};
const RESPONSES: Record<string, unknown> = {
  "/api/v1/overview": overview,
  "/api/v1/items": items,
  "/api/v1/runs": runs,
  "/api/v1/queue": queue,
  "/api/v1/workers": { as_of: AT, workers: [{ owner: "host:7:0", running: 1 }] },
  "/api/v1/health": { checked_at: AT, checks: [{ status: "ok", msg: "store reachable" }, { status: "fail", msg: "push access denied" }] },
  "/api/v1/items/wi_1": detail,
  "/api/v1/unreviewed-merges": {
    as_of: AT,
    merges: [
      { project: "github.com/o/r", change_ref: "9", change_url: "https://github.com/o/r/pull/9", merge_sha: "abcdef1", merged_by: "github:7", recorded_at: AT },
      { project: "github.com/o/r", change_ref: "8", change_url: null, merge_sha: "1234567", merged_by: "unknown", recorded_at: AT },
    ],
  },
};
let fetched: string[] = [];
let posts: { url: string; headers: Record<string, string>; body: unknown }[] = [];
/** The answer to the next command POST. */
let postAnswer: { status: number; body: unknown } = { status: 202, body: { request_id: "app:x", seq: 9, command: "approve", work_item_id: "wi_1" } };
let hidden = false;

/** Browser storage for the test: Node 25's own experimental localStorage would otherwise shadow jsdom's. */
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

beforeEach(() => {
  // jsdom has no showModal: open and close by the attribute.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  fetched = [];
  posts = [];
  postAnswer = { status: 202, body: { request_id: "app:x", seq: 9, command: "approve", work_item_id: "wi_1" } };
  hidden = false;
  vi.stubGlobal("localStorage", new MemoryStorage());
  document.documentElement.classList.remove("dark");
  history.replaceState(null, "", "/app/");
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    fetched.push(url);
    if (init?.method === "POST") {
      posts.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(postAnswer.body), { status: postAnswer.status, headers: { "content-type": "application/json" } });
    }
    const body = RESPONSES[url.split("?")[0]!];
    if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  // The send confirmation lives on document.body, outside every rendered tree.
  document.querySelector("[data-toast]")?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  focusManager.setFocused(undefined);
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe("app shell", () => {
  it("shows the sidebar pages, Needs you (N) from /api/v1/overview, and fetches only /api/v1/* URLs", async () => {
    mount();
    expect(await screen.findByText("Needs you (4)")).toBeTruthy();
    const factory = screen.getByRole("navigation", { name: "Factory" });
    expect([...factory.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Needs you", "Work", "Activity"]);
    const nav = screen.getByRole("navigation", { name: "System" });
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Health", "Failures", "Rules", "Runners", "Queue", "Data"]);
    fireEvent.click(within(nav).getByText("Queue"));
    expect(await screen.findByRole("heading", { name: "Queue" })).toBeTruthy();
    expect(location.pathname).toBe("/app/queue");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((u) => u.startsWith("/api/v1/"))).toBe(true);
  });

  it("the sidebar top shows the mark and the wordmark Gongbang", async () => {
    mount();
    await screen.findByText("Needs you (4)");
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    const brand = sidebar.querySelector("p")!;
    expect(brand.textContent).toBe("Gongbang");
    const mark = within(brand).getByTestId("brand-mark");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.querySelector("path")!.getAttribute("fill-rule")).toBe("evenodd");
    const ember = mark.querySelector("circle")!;
    expect(ember.getAttribute("class")).toBe("fill-ember");
    expect([ember.getAttribute("cx"), ember.getAttribute("cy")]).toEqual(["800", "224"]);
    expect(Number(ember.getAttribute("r"))).toBeCloseTo((2.5 * 1024) / 24, 1);
  });

  it("polls every 3 s while visible and stops while the document is hidden", async () => {
    mount();
    await screen.findByText("Needs you (4)");
    const first = fetched.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS * 2 + 100)));
    expect(fetched.length).toBeGreaterThanOrEqual(first + 2);

    hidden = true;
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    const whileHidden = fetched.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS * 5)));
    expect(fetched.length).toBe(whileHidden);

    hidden = false;
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS + 100)));
    expect(fetched.length).toBeGreaterThan(whileHidden);
  });

  /** A matchMedia whose dark state a test can flip; counts the live "change" listeners. */
  function stubScheme(dark: boolean) {
    let matches = dark;
    const listeners = new Set<(e: { matches: boolean }) => void>();
    vi.stubGlobal("matchMedia", (q: string) => ({
      get matches() { return q.includes("dark") && matches; },
      addEventListener: (_: string, l: (e: { matches: boolean }) => void) => void listeners.add(l),
      removeEventListener: (_: string, l: (e: { matches: boolean }) => void) => void listeners.delete(l),
    }));
    return {
      set(next: boolean) { matches = next; for (const l of [...listeners]) l({ matches: next }); },
      listeners: () => listeners.size,
    };
  }
  const isDark = () => document.documentElement.classList.contains("dark");
  const choose = (name: string) => fireEvent.click(within(screen.getByRole("radiogroup", { name: "Theme" })).getByRole("radio", { name }));

  it("offers System, Light and Dark, System by default", async () => {
    mount();
    await screen.findByText("Needs you (4)");
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual(["System", "Light", "Dark"]);
    expect(within(group).getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
  });

  it("with no saved choice, a dark system scheme renders dark", async () => {
    stubScheme(true);
    mount();
    await screen.findByText("Needs you (4)");
    expect(isDark()).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("System follows a change of the system scheme with no reload", async () => {
    const scheme = stubScheme(false);
    mount();
    await screen.findByText("Needs you (4)");
    expect(isDark()).toBe(false);
    act(() => scheme.set(true));
    expect(isDark()).toBe(true);
    act(() => scheme.set(false));
    expect(isDark()).toBe(false);
  });

  it("Light or Dark overrides the system and removes the listener; System follows it again and clears the stored value", async () => {
    const scheme = stubScheme(false);
    mount();
    await screen.findByText("Needs you (4)");
    expect(scheme.listeners()).toBe(1);
    choose("Dark");
    expect(isDark()).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(scheme.listeners()).toBe(0);
    act(() => scheme.set(false));
    expect(isDark()).toBe(true);
    choose("Light");
    act(() => scheme.set(true));
    expect(isDark()).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    choose("System");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(isDark()).toBe(true);
    expect(scheme.listeners()).toBe(1);
    act(() => scheme.set(false));
    expect(isDark()).toBe(false);
  });

  it("the pre-render paint shows the system scheme without leaving a listener", () => {
    const scheme = stubScheme(true);
    paintChoice("system");
    expect(isDark()).toBe(true);
    expect(scheme.listeners()).toBe(0);
    paintChoice("light");
    expect(isDark()).toBe(false);
  });

  it("a saved light or dark value applies on load, over the system", async () => {
    stubScheme(true);
    localStorage.setItem(THEME_KEY, "light");
    mount();
    await screen.findByText("Needs you (4)");
    expect(isDark()).toBe(false);
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
  });

  it("the banner link takes the banner's own text token and is used by the revision banner", () => {
    expect(BANNER_LINK_CLASS).toMatch(/(?<![\w-])text-current(?![\w-])/);
    render(<RevisionBanner server="a" web="b" />);
    expect(screen.getByText("reload").className).toBe(BANNER_LINK_CLASS);
    expect(screen.getByTestId("revision-banner").className).toMatch(/(?<![\w-])text-pill-warn-fg(?![\w-])/);
  });

  it("keeps the stored choice ahead of the system preference", () => {
    stubScheme(true);
    localStorage.setItem(THEME_KEY, "light");
    expect(storedChoice()).toBe("light");
    paintChoice(storedChoice()); // what web/src/main.tsx does at startup
    mount();
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    cleanup();
    stubScheme(false);
    localStorage.setItem(THEME_KEY, "dark");
    expect(storedChoice()).toBe("dark");
    paintChoice(storedChoice());
    mount();
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("sidebar", () => {
  it("is sticky, full height and scrolls by itself on its own tint; the page behind it is the bg token", () => {
    mount();
    const side = screen.getByRole("complementary", { name: "Sidebar" });
    for (const c of ["sticky", "top-0", "h-dvh", "overflow-y-auto", "bg-(--sidebar)"]) expect(side.className.split(" ")).toContain(c);
    const wrapper = side.parentElement!.className.split(" ");
    expect(wrapper).toContain("bg-bg");
    expect(wrapper).not.toContain("bg-surface");
  });

  it("the Tasks and Factory groups show small grey titles that name them; the System chevron is hidden from screen readers", () => {
    mount();
    for (const name of ["Tasks", "Factory"]) {
      const nav = screen.getByRole("navigation", { name });
      const title = document.getElementById(nav.getAttribute("aria-labelledby")!)!;
      expect(title.textContent).toBe(name);
      expect(nav.firstElementChild).toBe(title);
      for (const c of ["text-xs", "text-text-3"]) expect(title.className.split(" ")).toContain(c);
    }
    const chevron = document.querySelector("aside summary [data-chevron]")!;
    expect(chevron.getAttribute("aria-hidden")).toBe("true");
    // Points right while closed and turns down when the group opens.
    expect(chevron.getAttribute("class")!.split(" ")).toContain("group-open:rotate-90");
    expect(chevron.closest("details")!.className.split(" ")).toContain("group");
  });

  it("Settings is a row at the bottom of the sidebar, selected while open, and no longer a top-bar link", async () => {
    mount();
    await screen.findByText("Needs you (4)");
    expect(within(document.querySelector("header")!).queryByRole("link", { name: "Settings" })).toBeNull();
    const side = screen.getByRole("complementary", { name: "Sidebar" });
    const row = within(side).getByRole("link", { name: "Settings" });
    expect(row.getAttribute("href")).toBe("/app/settings");
    expect(row.hasAttribute("aria-current")).toBe(false);
    expect(side.querySelector("details")!.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "System" }).contains(row)).toBe(false);
    fireEvent.click(row);
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    const open = within(side).getByRole("link", { name: "Settings" });
    expect(open.getAttribute("aria-current")).toBe("page");
    expect(open.className.split(" ")).toEqual(expect.arrayContaining(["bg-surface-2", "font-medium"]));
  });
});

describe("one queued count", () => {
  it("Work's queued count, the Queue page's count and overview.queued are the same number of queued runs", async () => {
    history.replaceState(null, "", "/app/items");
    mount();
    const summary = await screen.findByTestId("summary");
    expect(await within(summary).findByRole("button", { name: `${overview.queued} queued` })).toBeTruthy();
    cleanup();
    history.replaceState(null, "", "/app/queue");
    mount();
    const section = await screen.findByRole("region", { name: "Queued runs" });
    await vi.waitFor(() => expect(section.querySelector("h2 + span")?.textContent).toBe(String(overview.queued)));
    expect(queue.queue.length).toBe(overview.queued);
  });
});

describe("sidebar in the icon-only layout", () => {
  it("each link has a title and an accessible name, though its label is hidden", async () => {
    const wide = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      mount();
      await screen.findByText("Needs you (4)");
      for (const nav of [screen.getByRole("navigation", { name: "Factory" }), screen.getByRole("navigation", { name: "System" })]) {
        const links = [...nav.querySelectorAll("a")];
        expect(links.length).toBeGreaterThan(0);
        for (const a of links) {
          const label = a.querySelector("span")!.textContent!;
          expect(a.getAttribute("title")).toBe(label);
          expect(within(nav).getByRole("link", { name: label })).toBe(a);
        }
      }
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: wide });
    }
  });
});

describe("top bar on a narrow screen", () => {
  // jsdom has no layout, so this checks the classes that keep the bar inside a 390px screen (checked by screenshot).
  it("wraps, keeps the icon buttons at full size, and shows only Ns of the age, which still reads in full", async () => {
    mount();
    await screen.findByText("Needs you (4)");
    const header = document.querySelector("header")!;
    expect(header.className.split(" ")).toContain("flex-wrap");
    for (const el of [within(header).getByRole("button", { name: "Refresh" }), within(header).getByRole("radio", { name: "Dark" })]) {
      expect(el.className.split(" ")).toContain("shrink-0");
    }
    const age = header.querySelector("[aria-live]")!;
    expect(age.textContent).toMatch(/^updated \d+s ago$/);
    const hidden = [...age.querySelectorAll("span")].map((s) => [s.textContent, s.className]);
    expect(hidden).toEqual([["updated ", "max-sm:sr-only"], [" ago", "max-sm:sr-only"]]);
  });
});

describe("app pages", () => {
  it("Needs you shows the factory banner and what needs you; Activity shows what runs", async () => {
    mount();
    expect((await screen.findByTestId("factory-banner")).textContent).toContain("Update to bbbbbbb waits for npm run migrate (pending: schema 12)");
    expect(screen.getByRole("heading", { level: 1, name: "Needs you" })).toBeTruthy();
    const needs = await screen.findByRole("table", { name: "Needs you" });
    expect(within(needs).getByText("Spec waiting")).toBeTruthy();
    expect(within(needs).queryByText("Being built")).toBeNull();
    expect(screen.queryByRole("table", { name: "Running now" })).toBeNull();
    cleanup();
    history.replaceState(null, "", "/app/activity");
    mount();
    expect(screen.getByRole("heading", { level: 1, name: "Activity" })).toBeTruthy();
    const running = await screen.findByRole("table", { name: "Running now" });
    expect(within(running).getByText("Being built")).toBeTruthy();
  });

  it("the sidebar's Tasks group links the Tasks page, the System group is collapsed, and there is no Users", () => {
    mount();
    const tasks = screen.getByRole("navigation", { name: "Tasks" });
    expect([...tasks.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/app/tasks"]);
    expect(document.querySelector("aside details")!.hasAttribute("open")).toBe(false);
    expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
  });

  it("old paths redirect: /app/workers to Runners, /app/users to Needs you", async () => {
    history.replaceState(null, "", "/app/workers");
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "Runners" })).toBeTruthy();
    await vi.waitFor(() => expect(location.pathname).toBe("/app/runners"));
    cleanup();
    history.replaceState(null, "", "/app/users");
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "Needs you" })).toBeTruthy();
    await vi.waitFor(() => expect(location.pathname).toBe("/app/"));
  });

  it("each page's heading matches its menu name", async () => {
    const names: Record<string, string> = { items: "Work", activity: "Activity", runners: "Runners", queue: "Queue", health: "Health", failures: "Failures", data: "Data", settings: "Settings" };
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
    fireEvent.click(screen.getByRole("button", { name: /^Needs you/ }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(fetched).toContain("/api/v1/items?state=needs");
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
  it("Activity says how many PRs merged without review and links to Health; hidden at 0", async () => {
    history.replaceState(null, "", "/app/activity");
    mount();
    const line = await screen.findByTestId("unreviewed-merges-line");
    expect(line.textContent).toContain("2 PRs merged without review in the last 7 days");
    fireEvent.click(within(line).getByRole("link"));
    expect(location.pathname).toBe("/app/health");
    cleanup();
    (overview as { unreviewed_merges_7d: number }).unreviewed_merges_7d = 0;
    try {
      history.replaceState(null, "", "/app/activity");
      mount();
      await screen.findByRole("table", { name: "Running now" });
      expect(screen.queryByTestId("unreviewed-merges-line")).toBeNull();
    } finally {
      (overview as { unreviewed_merges_7d: number }).unreviewed_merges_7d = 2;
    }
  });

  it("Health lists them in a table: PR (linked only with a URL), merged by, short sha, when", async () => {
    history.replaceState(null, "", "/app/health");
    mount();
    const t = await screen.findByRole("table", { name: "Merged without review" });
    expect([...t.querySelectorAll("th")].map((h) => h.textContent)).toEqual(["PR", "Merged by", "Merge commit", "When"]);
    const rows = [...t.querySelectorAll("tbody tr")] as HTMLElement[];
    expect(rows.map((r) => r.children[0]!.textContent)).toEqual(["#9", "#8"]);
    expect(rows[0]!.querySelector("a")!.getAttribute("href")).toBe("https://github.com/o/r/pull/9");
    expect(rows[1]!.querySelector("a")).toBeNull();
    // A person shows by name ("a person"; "you" for the viewer), the ID behind it in a details element.
    const by = rows[0]!.children[1]!.querySelector("details")!;
    expect(by.querySelector("summary")!.textContent).toBe("a person");
    expect(by.textContent).toContain("github:7");
    expect(rows[0]!.children[2]!.textContent).toBe("abcdef1");
  });
});

// ---- ItemsTable (issue #240): title link, Issue and PR columns only with the GitHub plugin ----
const GH = { issues: "github" } as const;
const NONE = { issues: null } as const;
const trow = (n: number, extra: Partial<ItemRow> = {}): ItemRow => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title: `Title ${n}`,
  level: "running", badges: [], stage: "RUNNING", tier: 2, kind: null, blocked_on: "none", blocked_reason: null, close_reason: null,
  run_status: null, change_ref: null, change_url: null, issue: { number: n, url: `https://github.com/o/r/issues/${n}` }, since: AT,
  updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 }, ...extra,
});
const NOW_MS = Date.parse(AT);
const itemsTable = (items: ItemRow[], plugins?: typeof GH | typeof NONE) =>
  render(<ItemsTable items={items} now={NOW_MS} label="Work items" empty="none" plugins={plugins} />).container;
const heads = (c: HTMLElement) => [...c.querySelectorAll("th")].map((h) => h.textContent);
const cells = (c: HTMLElement) => [...c.querySelectorAll("tbody tr:first-child td")] as HTMLElement[];

describe("ItemsTable columns and links (issue #240)", () => {
  it("links the title to the item page and the Item cell not to GitHub", () => {
    const c = itemsTable([trow(1)], GH);
    const item = cells(c)[0]!;
    expect(item.querySelectorAll("a")).toHaveLength(1);
    expect(item.querySelector("a")!.getAttribute("href")).toBe("/app/items/wi_1");
    expect(item.textContent).toBe("Title 1");
  });

  it("shows the item's short number, never its ID, as the link text when there is no title", () => {
    const a = cells(itemsTable([trow(2, { title: null })], GH))[0]!.querySelector("a")!;
    expect(a.textContent).toBe("#2");
    expect(a.getAttribute("href")).toBe("/app/items/wi_2");
  });

  it("with GitHub: Issue links to the issue, PR to the PR, a dash when there is none", () => {
    const c = itemsTable([trow(3, { change_ref: "9", change_url: "https://github.com/o/r/pull/9" }), trow(4)], GH);
    expect(heads(c)).toEqual(["Item", "State", "Why", "Since", "Issue", "PR"]);
    const [r1, r2] = [...c.querySelectorAll("tbody tr")] as HTMLElement[];
    const t1 = [...r1!.querySelectorAll("td")];
    expect(t1[4]!.querySelector("a")!.getAttribute("href")).toBe("https://github.com/o/r/issues/3");
    expect(t1[4]!.textContent).toBe("#3");
    expect(t1[5]!.querySelector("a")!.getAttribute("href")).toBe("https://github.com/o/r/pull/9");
    expect(t1[5]!.textContent).toBe("#9");
    expect([...r2!.querySelectorAll("td")][5]!.textContent).toBe("–");
  });

  it("without GitHub: no Issue column; the PR column shows the stored link, or a dash with no change_ref", () => {
    for (const plugins of [NONE, undefined]) {
      const c = itemsTable([trow(5, { change_ref: "9", change_url: "https://forge.example/o/r/pull/9" }), trow(4)], plugins);
      expect(heads(c)).toEqual(["Item", "State", "Why", "Since", "PR"]);
      expect(c.innerHTML).not.toContain("github.com");
      const [r1, r2] = [...c.querySelectorAll("tbody tr")] as HTMLElement[];
      expect([...r1!.querySelectorAll("td")][4]!.querySelector("a")!.getAttribute("href")).toBe("https://forge.example/o/r/pull/9");
      expect([...r2!.querySelectorAll("td")][4]!.textContent).toBe("–");
      cleanup();
    }
  });

  it("an adopted PR shows a dash under Issue and its number under PR", () => {
    const c = itemsTable([trow(6, { issue: null, change_ref: "6", change_url: "https://github.com/o/r/pull/6" })], GH);
    const td = cells(c);
    expect(td[4]!.textContent).toBe("–");
    expect(td[5]!.textContent).toBe("#6");
  });

  it("a change_ref without a stored change_url shows the ref as text", () => {
    const td = cells(itemsTable([trow(7, { change_ref: "7", change_url: null })], GH));
    expect(td[5]!.textContent).toBe("#7");
    expect(td[5]!.querySelector("a")).toBeNull();
  });
});

describe("Running now and Queue", () => {
  it("keep the GitHub link on the source id beside the title", () => {
    const items = new Map([["wi_1", trow(1)]]);
    const run = { id: "run_a", status: "running", kind: "implement", work_item_id: "wi_1", attempt: 1, owner: "h:1:0", heartbeat_at: AT, started_at: AT, lease_expires_at: AT, created_at: AT };
    const q = { position: 1, id: "run_b", kind: "implement", work_item_id: "wi_1", attempt: 0, created_at: AT, not_before: null };
    const a = render(<RunningTable runs={[run] as never} items={items} now={NOW_MS} />).container;
    const links = [...a.querySelectorAll("tbody tr td:first-child a")].map((x) => [x.getAttribute("href"), x.textContent]);
    expect(links).toEqual([["https://github.com/o/r/issues/1", "#1"], ["/app/items/wi_1", "Title 1"]]);
    cleanup();
    const b = render(<QueueTable queue={[q] as never} items={items} now={NOW_MS} />).container;
    expect([...b.querySelectorAll("tbody tr td:nth-child(2) a")].map((x) => x.getAttribute("href"))).toEqual(["https://github.com/o/r/issues/1", "/app/items/wi_1"]);
  });
});

// ---- Item commands (issue #228): a button per command, the note box, the reject and revise dialogs (issue #527), the outcome ----
const cmd = (name: string) => ({ name, usage: `/${name}`, description: `${name} it`, allowed: true, reason: null as string | null });
const reply = (seq: number, command: string, handled: boolean, refusal: string | null = null) =>
  ({ seq, command, created_at: AT, handled_at: handled ? AT : null, refusal });
const SESSION = { as_of: AT, csrf_token: "tok-123", commands_enabled: true, actor: "local:me", actor_source: "environment" as const };

function mountCommands(commands = ["approve", "revise", "reject", "retry"].map(cmd), replies: ReturnType<typeof reply>[] = [], session: object | null = SESSION) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (session) client.setQueryData(["/api/v1/session"], session);
  return render(
    <QueryClientProvider client={client}>
      <ItemCommands id="wi_1" commands={commands} replies={replies} />
    </QueryClientProvider>,
  );
}
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const rowOf = (name: string) => document.querySelector(`[data-command="${name}"]`) as HTMLElement;
const typeNote = (text: string) => fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: text } });
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(10)));

describe("item commands", () => {
  it("shows one button per command, in the API's order, labelled with its name", () => {
    mountCommands(["retry", "approve", "budget"].map(cmd));
    expect([...document.querySelectorAll("[data-command] > button")].map((b) => b.textContent)).toEqual(["retry", "approve", "budget"]);
  });

  it("verdict shows Good, Bad and Feedback, each sending the verdict request; Feedback waits for the note box's text", async () => {
    mountCommands([cmd("verdict")]);
    expect([...document.querySelectorAll("[data-verdict-tap]")].map((b) => b.textContent)).toEqual(["Good", "Bad", "Feedback"]);
    expect(button("Feedback").disabled).toBe(true);
    fireEvent.click(button("Good"));
    await settle();
    fireEvent.click(button("Bad"));
    await settle();
    typeNote("the flag name is wrong");
    fireEvent.click(button("Feedback"));
    await settle();
    expect(posts.map((p) => p.body)).toEqual([
      { command: "verdict", note: "accept none" },
      { command: "verdict", note: "changes minor Bad" },
      { command: "verdict", note: "changes none the flag name is wrong" },
    ]);
  });

  it("with no command that applies (a running item), says so and offers no note box or button", () => {
    mountCommands([]);
    expect(document.querySelector("[data-commands-none]")?.textContent).toContain("No command applies now");
    expect(document.querySelectorAll("[data-command] > button")).toHaveLength(0);
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
  });

  it("the item page shows the buttons from the item API's commands list", async () => {
    RESPONSES["/api/v1/session"] = SESSION;
    (detail as Record<string, unknown>).commands = [cmd("approve"), cmd("reject")];
    (detail as Record<string, unknown>).replies = [];
    try {
      history.replaceState(null, "", "/app/items/wi_1");
      mount();
      expect(await screen.findByRole("button", { name: "approve" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "reject" })).toBeTruthy();
    } finally {
      delete RESPONSES["/api/v1/session"];
      delete (detail as Record<string, unknown>).commands;
      delete (detail as Record<string, unknown>).replies;
    }
  });

  it("revise and reject open a dialog, not the note box; the note box stays for the other commands", async () => {
    mountCommands();
    expect(screen.getByRole("textbox", { name: "Note" })).toBeTruthy();
    typeNote("tighten the tests");
    fireEvent.click(button("revise"));
    const dialog = screen.getByRole("dialog", { name: "Revise wi_1" });
    expect((within(dialog).getByRole("button", { name: "Send revise" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(button("reject"));
    expect(screen.getByRole("dialog", { name: "Reject wi_1" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Revise wi_1" })).toBeNull();
    await settle();
    expect(posts).toEqual([]);
    cleanup();
    // Only reject and revise: no note box at all.
    mountCommands(["revise", "reject"].map(cmd));
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
  });

  it("a send posts { command, note } with the session token; the note only when the box has text", async () => {
    mountCommands();
    fireEvent.click(button("approve"));
    await settle();
    typeNote("  more tests please ");
    fireEvent.click(button("retry"));
    await settle();
    fireEvent.click(button("revise"));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on Problem" }), { target: { value: "narrower" } });
    fireEvent.click(button("Send revise"));
    await settle();
    expect(posts.map((p) => [p.url, p.body])).toEqual([
      ["/api/v1/items/wi_1/commands", { command: "approve" }],
      ["/api/v1/items/wi_1/commands", { command: "retry", note: "more tests please" }],
      ["/api/v1/items/wi_1/commands", { command: "revise", note: "### Problem\nnarrower" }],
    ]);
    expect(posts[0]!.headers["x-csrf-token"]).toBe("tok-123");
    expect(posts[0]!.headers["content-type"]).toBe("application/json");
  });

  it("reject asks why and to confirm: cancel posts nothing, confirm posts the reason once", async () => {
    mountCommands();
    typeNote("not the reject reason");
    fireEvent.click(button("reject"));
    fireEvent.click(screen.getByRole("radio", { name: "duplicate" }));
    await settle();
    expect(posts).toEqual([]);
    fireEvent.click(button("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await settle();
    expect(posts).toEqual([]);
    fireEvent.click(button("reject"));
    fireEvent.click(screen.getByRole("radio", { name: "duplicate" }));
    fireEvent.click(button("Confirm reject"));
    await settle();
    expect(posts.map((p) => p.body)).toEqual([{ command: "reject", note: "duplicate" }]);
  });

  it("a 202 shows sent at once; a failed send shows its error next to its button", async () => {
    mountCommands();
    fireEvent.click(button("approve"));
    await settle();
    expect(within(rowOf("approve")).getByRole("status").textContent).toBe("sent");
    postAnswer = { status: 403, body: { error: "Missing or stale x-csrf-token; reload the page." } };
    fireEvent.click(button("retry"));
    await settle();
    expect(within(rowOf("retry")).getByRole("alert").textContent).toBe("Missing or stale x-csrf-token; reload the page.");
    expect(within(rowOf("approve")).getByRole("status").textContent).toBe("sent");
  });

  it("shows the latest request's outcome per command: its refusal, sent, or Done", () => {
    mountCommands(["approve", "retry", "revise", "reject"].map(cmd), [
      reply(1, "approve", true, "You may not approve this item."),
      reply(2, "retry", true),
      reply(3, "approve", false),
      reply(4, "revise", true),
      reply(5, "revise", true, "Nothing to revise."),
    ]);
    expect(rowOf("approve").querySelector("[data-outcome]")!.textContent).toBe("sent");
    expect(rowOf("retry").querySelector("[data-outcome]")!.textContent).toBe("Done");
    expect(rowOf("revise").querySelector("[data-outcome]")!.textContent).toBe("Nothing to revise.");
    expect(rowOf("reject").querySelector("[data-outcome]")).toBeNull();
  });

  it("a local send shows sent until a reply as new as it arrives", () => {
    const replies = [reply(4, "retry", true)];
    expect(commandOutcome(replies, "retry", { seq: 9 })).toEqual({ tone: "status", text: "sent" });
    expect(commandOutcome([...replies, reply(9, "retry", true)], "retry", { seq: 9 })).toEqual({ tone: "status", text: "Done" });
    expect(commandOutcome(replies, "retry", { error: "boom" })).toEqual({ tone: "error", text: "boom" });
  });

  it("with commands on the page says who it acts as and where that came from", () => {
    mountCommands(undefined, [], SESSION);
    const actor = document.querySelector("[data-commands-actor]")!;
    expect(actor.querySelector("summary")!.textContent).toBe("you");
    expect(actor.querySelector("details")!.textContent).toContain("local:me");
    expect(actor.textContent).toMatch(/^Acting as you.*\(from environment\)$/);
  });

  it("with commands off every button is disabled and the page says so", () => {
    mountCommands(undefined, [], { ...SESSION, commands_enabled: false, actor: null, actor_source: null });
    typeNote("some text");
    for (const b of document.querySelectorAll("[data-command] > button")) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Commands are off/)).toBeTruthy();
    // The notice links to the Settings page's section that says what to set.
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/app/settings#page-commands");
  });
});

describe("Floor item links (issue #228)", () => {
  it("Needs you and Work items rows link their title to the item page", async () => {
    mount();
    const needs = await screen.findByRole("table", { name: "Needs you" });
    expect(within(needs).getByRole("link", { name: "Spec waiting" }).getAttribute("href")).toBe("/app/items/wi_1");
    cleanup();
    localStorage.setItem(VIEW_KEY, "list");
    history.replaceState(null, "", "/app/items");
    mount();
    const all = await screen.findByRole("table", { name: "Work items" });
    expect(within(all).getByRole("link", { name: "Being built" }).getAttribute("href")).toBe("/app/items/wi_2");
  });
});

// ---- Why an item waits (issue #310): one sentence from the API, #N linked, on Floor, Items, Queue and the item page ----
describe("why an item waits (issue #310)", () => {
  const REF_URL = "https://github.com/o/r/issues/";
  const dep = { code: "dependency", text: "Waiting for #12 and #13 to merge", next_actor: "other_item" as const, refs: [12, 13], ref_url: REF_URL };
  const held = { code: "held", text: "Held behind #92, which has an open PR", next_actor: "other_item" as const, refs: [92], ref_url: REF_URL };
  const refLinks = (el: HTMLElement) => [...el.querySelectorAll("[data-why] a")].map((a) => [a.textContent, a.getAttribute("href")]);

  function withWhy(run: () => Promise<void>) {
    const saved = { items: items.items.map((i) => ({ ...i })), queue: queue.queue.map((q) => ({ ...q })), item: { ...detail.item } };
    (items.items[0] as Record<string, unknown>).why = dep;
    (items.items[2] as Record<string, unknown>).why = held;
    (queue.queue[0] as Record<string, unknown>).why = held;
    (detail.item as Record<string, unknown>).why = dep;
    return run().finally(() => {
      items.items.splice(0, items.items.length, ...saved.items);
      queue.queue.splice(0, queue.queue.length, ...saved.queue);
      delete (detail.item as Record<string, unknown>).why;
    });
  }
  const dependencyLinks = [["#12", `${REF_URL}12`], ["#13", `${REF_URL}13`]];

  it("Needs you shows the sentence with #N linked", () =>
    withWhy(async () => {
      mount();
      const needs = await screen.findByRole("table", { name: "Needs you" });
      expect(within(needs).getByText("Waiting for", { exact: false }).textContent).toBe(dep.text);
      expect(refLinks(needs)).toEqual(dependencyLinks);
    }));

  it("Work items and the Queue page show the same sentences, #N linked", () =>
    withWhy(async () => {
      localStorage.setItem(VIEW_KEY, "list");
      history.replaceState(null, "", "/app/items");
      mount();
      const all = await screen.findByRole("table", { name: "Work items" });
      expect(refLinks(all)).toEqual([...dependencyLinks, ["#92", `${REF_URL}92`]]);
      cleanup();
      history.replaceState(null, "", "/app/queue");
      mount();
      const q = await screen.findByRole("table", { name: "Queue" });
      expect(within(q).queryByText("now")).toBeNull();
      expect(refLinks(q)).toEqual([["#92", `${REF_URL}92`]]);
    }));

  it("the item page shows the full sentence, not cut off, #N linked, and no raw blocked_on row", () =>
    withWhy(async () => {
      history.replaceState(null, "", "/app/items/wi_1");
      mount();
      const why = await screen.findByTestId("why");
      expect(why.textContent).toBe(dep.text);
      expect(refLinks(why)).toEqual(dependencyLinks);
      for (let el: HTMLElement | null = why; el; el = el.parentElement) expect(el.className).not.toContain("truncate");
      expect(why.querySelector(".truncate")).toBeNull();
      expect(screen.queryByText("Blocked on")).toBeNull();
    }));

  it("a ref with no ref_url, or a number the API did not list, stays plain text", () => {
    const c = itemsTable([trow(1, { why: { ...dep, ref_url: null } }), trow(2, { why: { ...dep, refs: [12] } })]);
    const cells = [...c.querySelectorAll("[data-why]")] as HTMLElement[];
    expect(refLinks(cells[0]!)).toEqual([]);
    expect(refLinks(cells[1]!)).toEqual([["#12", `${REF_URL}12`]]);
    expect(cells[1]!.textContent).toBe(dep.text);
  });
});

describe("open alarms in Needs you and the why sentence (design 09-status-page)", () => {
  const ALARM = "Alarm: checks_failed failed 4 runs on several items";
  const action = { code: "alarm", text: `${ALARM}: npm test exited #`, command: "Failures page (/app/failures)", until: "2026-11-07T06:00:00.000Z", work_item_id: null };
  const alarmed = { code: "queued", text: `Queued at position 1. ${ALARM}`, next_actor: "factory" as const, refs: [], ref_url: null };
  const plain = { ...alarmed, text: "Queued at position 1" };

  /** Runs `run` with the overview's alarm and the why sentences set, then puts the fixtures back. */
  function withAlarm(run: () => Promise<void>) {
    const saved = { items: items.items.map((i) => ({ ...i })), item: { ...detail.item } };
    (overview as Record<string, unknown>).system_actions = [action];
    for (const i of items.items) (i as Record<string, unknown>).why = alarmed;
    (detail.item as Record<string, unknown>).why = alarmed;
    return run().finally(() => {
      delete (overview as Record<string, unknown>).system_actions;
      items.items.splice(0, items.items.length, ...saved.items);
      delete (detail.item as Record<string, unknown>).why;
    });
  }
  /** The next poll answers as if the alarm closed: no system action, sentences without it. */
  async function resolve() {
    (overview as Record<string, unknown>).system_actions = [];
    for (const i of items.items) (i as Record<string, unknown>).why = plain;
    (detail.item as Record<string, unknown>).why = plain;
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS + 10)));
  }

  it("the Floor's Needs you shows the open alarms as one line linking to Failures, and drops it once resolved", () =>
    withAlarm(async () => {
      mount();
      const list = await screen.findByRole("list", { name: "System actions" });
      const li = list.querySelector('[data-action="alarm"]') as HTMLElement;
      expect(li.textContent).toContain("Open alarms: 1.");
      expect(within(li).getByRole("link").getAttribute("href")).toBe("/app/failures");
      const needs = screen.getByRole("table", { name: "Needs you" });
      expect(within(needs).getByText(ALARM, { exact: false }).textContent).toBe(alarmed.text);
      await resolve();
      await vi.waitFor(() => expect(screen.queryByRole("list", { name: "System actions" })).toBeNull());
      expect(within(screen.getByRole("table", { name: "Needs you" })).queryByText(ALARM, { exact: false })).toBeNull();
    }));

  it("Work items and the item page name the alarm in the item's why, and drop it once it is resolved", () =>
    withAlarm(async () => {
      localStorage.setItem(VIEW_KEY, "list");
      history.replaceState(null, "", "/app/items");
      mount();
      const all = await screen.findByRole("table", { name: "Work items" });
      expect(within(all).getAllByText(ALARM, { exact: false }).length).toBeGreaterThan(0);
      cleanup();
      history.replaceState(null, "", "/app/items/wi_1");
      mount();
      const why = await screen.findByTestId("why");
      expect(why.textContent).toBe(alarmed.text);
      await resolve();
      await vi.waitFor(() => expect(screen.getByTestId("why").textContent).toBe(plain.text));
    }));
});

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
    await screen.findByText("Needs you (4)");
    await vi.waitFor(() => expect(document.title).toBe("(4) Needs you · Gongbang"));
    cleanup();
    const before = overview.needs_you;
    overview.needs_you = 0;
    try {
      mount();
      await screen.findByText("Needs you (0)");
      await vi.waitFor(() => expect(document.title).toBe("Needs you · Gongbang"));
    } finally {
      overview.needs_you = before;
    }
  });

  it("the Floor's Needs you lists each system action with its command", async () => {
    const actions = [
      { code: "migration_pending", text: "Schema at version 3 of 8", command: "npm run migrate", until: null, work_item_id: null },
      { code: "claim_pause", text: "Claim pause rate_limit in effect, until 2026-11-07T01:00:00.000Z", command: "factory resume rate_limit", until: "2026-11-07T01:00:00.000Z", work_item_id: null },
    ];
    (overview as Record<string, unknown>).system_actions = actions;
    try {
      mount();
      const list = await screen.findByRole("list", { name: "System actions" });
      const rows = [...list.querySelectorAll("li")];
      expect(rows.map((r) => r.getAttribute("data-action"))).toEqual(["migration_pending", "claim_pause"]);
      expect(rows[0]!.textContent).toContain("Schema at version 3 of 8");
      expect(rows[0]!.querySelector("code")!.textContent).toBe("npm run migrate");
      expect(rows[1]!.querySelector("code")!.textContent).toBe("factory resume rate_limit");
      // The section counts the item row and both actions.
      const needs = screen.getByRole("region", { name: "Needs you" });
      expect(within(needs).getByText("3")).toBeTruthy();
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

describe("Floor banner and Needs-you Why (claim pauses)", () => {
  const NOW = Date.parse(AT);
  const running = { state: "running", rev: "aaaaaaa1111", target_rev: "aaaaaaa1111", child_pid: 7, since: AT, workers: 3, error: null, pending: [] } as never;
  const bannerText = (pauses?: { name: string; ends_at: string; since?: string | null }[]) => {
    render(<FactoryBanner factory={running} now={NOW} pauses={pauses} />);
    return screen.getByTestId("factory-banner").textContent;
  };

  it("with no pause the banner is unchanged", () => {
    expect(bannerText([])).toContain("Factory running: revision aaaaaaa");
  });

  it.each(["forge_auth", "preflight_access", "rate_limit"])("a %s pause replaces 'Factory running' and says when it ends", (name) => {
    const text = bannerText([{ name, ends_at: "2026-11-07T01:00:00.000Z" }]);
    expect(text).toContain(name);
    expect(text).toContain("until 2026-11-07T01:00:00.000Z");
    expect(text).not.toContain("Factory running");
  });

  it("a model stall says when it began and when the next check is; a due check says so", () => {
    const pause = { name: "model_stall", since: "2026-11-06T23:00:00.000Z" };
    const soon = bannerText([{ ...pause, ends_at: "2026-11-07T00:30:00.000Z" }]);
    expect(soon).toContain("since 2026-11-06T23:00:00.000Z");
    expect(soon).toContain("next check at 2026-11-07T00:30:00.000Z");
    cleanup();
    const due = bannerText([{ ...pause, ends_at: "2026-11-06T23:30:00.000Z" }]);
    expect(due).toContain("the next check is due");
    expect(due).not.toContain("2026-11-06T23:30:00.000Z");
  });

  it("the Why column shows the need's reason, not the badges, and no command to type", () => {
    const need = { reason: "failed: diff_too_large" };
    const failed = { blocked_on: "human", blocked_reason: "run_failed:implement:diff_too_large", badges: ["failed"], need };
    render(<ItemsTable items={[row(1, "needs_human", "Failed one", failed) as unknown as ItemRow]} now={NOW} label="Needs you" empty="none" />);
    const cell = document.querySelector("[data-need]")!.closest("td")!;
    expect(cell.textContent).toBe("failed: diff_too_large");
  });
});

describe("Needs-you command buttons (issue #453)", () => {
  const NO_ROLE = "local:me has no role that allows it (`no_role`); the local owner can grant one with `factory users add local:me --role approver`";
  /** Needs you with one row whose commands are `commands`, as the items API lists them. */
  function mountNeeds(commands: ReturnType<typeof cmd>[], extra: object = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["/api/v1/session"], SESSION);
    const it = row(1, "needs_approval", "Spec waiting", { stage: "READY", blocked_on: "human", need: { reason: "spec ready", anchor: null }, commands, ...extra });
    return render(
      <QueryClientProvider client={client}>
        <ItemsTable items={[it as unknown as ItemRow]} now={Date.parse(AT)} label="Needs you" empty="none" actions />
      </QueryClientProvider>,
    );
  }

  const menu = () => screen.getByRole("button", { name: "More commands" });
  const pick = (name: string) => {
    fireEvent.click(menu());
    fireEvent.click(screen.getByRole("menuitem", { name }));
  };

  it("one primary button and one ⋯ menu per row, holding the other commands; Work items has none", () => {
    mountNeeds(["approve", "reject", "revise"].map(cmd));
    expect([...document.querySelectorAll("[data-need-commands] > [data-command] > button")].map((b) => b.textContent)).toEqual(["approve"]);
    expect(document.querySelectorAll("[data-need-commands] > span > button, [data-need-commands] > button")).toHaveLength(2);
    expect(screen.queryByRole("menuitem")).toBeNull();
    fireEvent.click(menu());
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["reject", "revise"]);
    cleanup();
    mountNeeds([cmd("retry"), cmd("reject")]);
    expect(rowOf("retry").textContent).toBe("retry");
    cleanup();
    mountNeeds([cmd("reject")]);
    expect(document.querySelector("[data-need-commands] [data-command] > button:not([role])")).toBeNull();
    cleanup();
    const it = row(1, "needs_approval", "Spec waiting", { need: { reason: "spec ready" }, commands: [cmd("approve")] });
    render(<ItemsTable items={[it as unknown as ItemRow]} now={Date.parse(AT)} label="Work items" empty="none" />);
    expect(document.querySelector("[data-need-commands]")).toBeNull();
  });

  it("approve, retry and resolve send at once, with no note; the row shows no sent text, a status message does", async () => {
    for (const name of ["approve", "retry", "resolve"]) {
      posts = [];
      mountNeeds([cmd(name)]);
      fireEvent.click(button(name));
      await settle();
      expect(posts.map((p) => [p.url, p.body]), name).toEqual([["/api/v1/items/wi_1/commands", { command: name }]]);
      expect(posts[0]!.headers["x-csrf-token"]).toBe("tok-123");
      expect(document.querySelector("tr")!.textContent).not.toContain("sent");
      expect(screen.getByRole("status").textContent).toBe(`Command sent: ${name}`);
      cleanup();
    }
  });

  it("the status message outlives a row that leaves the list after its send, then goes", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["/api/v1/session"], SESSION);
    const it = row(1, "needs_approval", "Spec waiting", { stage: "READY", blocked_on: "human", need: { reason: "spec ready", anchor: null }, commands: [cmd("approve")] });
    client.setQueryData(["/api/v1/items"], { ...items, items: [it] });
    function Listed() {
      const list = useApi<Items>(API.items, false).data;
      return <ItemsTable items={list?.items ?? []} now={Date.parse(AT)} label="Needs you" empty="none" actions />;
    }
    const saved = RESPONSES["/api/v1/items"];
    RESPONSES["/api/v1/items"] = { ...items, items: [] };
    try {
      render(
        <QueryClientProvider client={client}>
          <Listed />
        </QueryClientProvider>,
      );
      fireEvent.click(button("approve"));
      await settle();
      expect(posts.map((p) => p.body)).toEqual([{ command: "approve" }]);
      expect(document.querySelector("[data-need-commands]")).toBeNull();
      expect(screen.getByRole("status").textContent).toBe("Command sent: approve");
      await act(async () => void (await vi.advanceTimersByTimeAsync(STATUS_MS)));
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      RESPONSES["/api/v1/items"] = saved;
    }
  });

  it("opening reject, revise or verdict leaves the row's children as they were; the dialog sits outside the row", () => {
    mountNeeds(["approve", "reject", "revise", "verdict"].map(cmd));
    const tr = document.querySelector("tr")!;
    const before = [...tr.querySelectorAll("*")];
    for (const [name, title] of [["reject", "Reject wi_1"], ["revise", "Revise wi_1"], ["verdict", "Record a verdict on wi_1"]] as const) {
      pick(name);
      const dialog = screen.getByRole("dialog", { name: title });
      expect(tr.contains(dialog), name).toBe(false);
      expect([...tr.querySelectorAll("*")], name).toEqual(before);
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    }
  });

  it("reject opens the dialog and asks to confirm, naming the PR it closes; nothing is sent before the confirm", async () => {
    mountNeeds(["approve", "reject"].map(cmd), { change_ref: "42" });
    pick("reject");
    const dialog = screen.getByRole("dialog", { name: "Reject wi_1" });
    expect(dialog.textContent).toContain("Rejecting closes this item and its PR #42, without a merge.");
    fireEvent.click(within(dialog).getByRole("radio", { name: "duplicate" }));
    await settle();
    expect(posts).toEqual([]);
    fireEvent.click(button("Confirm reject"));
    await settle();
    expect(posts.map((p) => p.body)).toEqual([{ command: "reject", note: "duplicate" }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("revise opens its note fields and sends only once a section has text; Cancel sends nothing", async () => {
    mountNeeds([cmd("approve"), cmd("revise")]);
    pick("revise");
    const dialog = screen.getByRole("dialog", { name: "Revise wi_1" });
    expect((within(dialog).getByRole("button", { name: "Send revise" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await settle();
    expect(posts).toEqual([]);
    pick("revise");
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on Problem" }), { target: { value: "narrower" } });
    fireEvent.click(button("Send revise"));
    await settle();
    expect(posts.map((p) => p.body)).toEqual([{ command: "revise", note: "### Problem\nnarrower" }]);
  });

  it("verdict opens a one-line dialog; Send verdict sends what was typed", async () => {
    mountNeeds([cmd("approve"), cmd("verdict")]);
    pick("verdict");
    expect((button("Send verdict")).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Verdict" }), { target: { value: " accept none ok " } });
    fireEvent.click(button("Send verdict"));
    await settle();
    expect(posts.map((p) => p.body)).toEqual([{ command: "verdict", note: "accept none ok" }]);
  });

  it("a command the viewer may not send stays in the menu, disabled, with its reason in plain text", async () => {
    mountNeeds(["approve", "reject"].map((n) => ({ ...cmd(n), allowed: false, reason: NO_ROLE })));
    // Nothing allowed is primary, so approve is in the menu too.
    expect(document.querySelectorAll("[data-need-commands] [data-command] > button:not([role])")).toHaveLength(0);
    fireEvent.click(menu());
    for (const name of ["approve", "reject"]) {
      const item = screen.getByRole("menuitem", { name }) as HTMLButtonElement;
      expect(item.disabled, name).toBe(true);
      const li = item.closest("li")!;
      expect(li.textContent).toContain("local:me has no role that allows it (no_role)");
      expect(li.textContent).not.toContain("`");
    }
    fireEvent.click(screen.getByRole("menuitem", { name: "approve" }));
    await settle();
    expect(posts).toEqual([]);
  });
});
