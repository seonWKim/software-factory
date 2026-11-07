// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemsTable, QueueTable, RunningTable } from "../web/src/views/common.js";
import type { ItemRow } from "../web/src/api.js";
import { App } from "../web/src/App.js";
import { POLL_MS } from "../web/src/api.js";
import { THEME_KEY } from "../web/src/theme.js";

// The app shell (step 2 of #124, design §9): it fetches only /api/v1/*, polls every 3 s while the document is
// visible and not while it is hidden, and keeps the light/dark choice in browser storage.

const AT = "2026-11-07T00:00:00.000Z";
const overview = {
  as_of: AT, stages: { NEW: 1, RUNNING: 2 }, needs_you: 4, running: 1, queued: 2, last_24h: { succeeded: 3, failed: 1, tokens: 1500 },
  factory: { state: "migration_pending", rev: "aaaaaaa1111", target_rev: "bbbbbbb2222", child_pid: 7, since: AT, workers: 3, error: null, pending: ["schema 12"] },
};
const row = (n: number, level: string, title: string, extra: object = {}) => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title, level,
  badges: [], stage: "RUNNING", tier: 2, kind: null, blocked_on: "none", blocked_reason: null, close_reason: null, run_status: null,
  pr_number: null, pr_url: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 }, ...extra,
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
};
let fetched: string[] = [];
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
  fetched = [];
  hidden = false;
  vi.stubGlobal("localStorage", new MemoryStorage());
  document.documentElement.classList.remove("dark");
  history.replaceState(null, "", "/app/");
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetched.push(url);
    const body = RESPONSES[url.split("?")[0]!];
    if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
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
    const nav = screen.getByRole("navigation", { name: "Pages" });
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Floor", "Work items", "Workers", "Queue", "Health", "Settings"]);
    fireEvent.click(within(nav).getByText("Queue"));
    expect(await screen.findByRole("heading", { name: "Queue" })).toBeTruthy();
    expect(location.pathname).toBe("/app/queue");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((u) => u.startsWith("/api/v1/"))).toBe(true);
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

  it("the theme toggle switches light and dark and keeps the choice in browser storage", async () => {
    mount();
    await screen.findByText("Needs you (4)");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBe("light");

    cleanup();
    localStorage.setItem(THEME_KEY, "dark");
    mount();
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeTruthy();
  });
});

describe("app pages", () => {
  it("the Floor shows the factory banner, what needs you, what runs and the queue, in that order", async () => {
    mount();
    expect((await screen.findByTestId("factory-banner")).textContent).toContain("Update to bbbbbbb waits for npm run migrate (pending: schema 12)");
    const needs = await screen.findByRole("table", { name: "Needs you" });
    expect(within(needs).getByText("Spec waiting")).toBeTruthy();
    expect(within(needs).queryByText("Being built")).toBeNull();
    const running = await screen.findByRole("table", { name: "Running now" });
    expect(within(running).getByText("Being built")).toBeTruthy();
    const q = await screen.findByRole("table", { name: "Queue" });
    expect(within(q).getByText("Waiting its turn")).toBeTruthy();
    const order = [...document.querySelectorAll("section[aria-label]")].map((e) => e.getAttribute("aria-label"));
    expect(order.slice(0, 3)).toEqual(["Needs you", "Running now", "Queue"]);
  });

  it("an item link opens its page: runs with their error, the timeline, and a way back", async () => {
    mount();
    fireEvent.click(await screen.findByText("Spec waiting"));
    expect(location.pathname).toBe("/app/items/wi_1");
    expect(await screen.findByText("git_failed")).toBeTruthy();
    expect(screen.getByText(": git merge: boom", { exact: false })).toBeTruthy();
    expect(screen.getByText("intake")).toBeTruthy();
    // The breadcrumb back to the list (the sidebar's entry is the current page).
    fireEvent.click(screen.getByRole("link", { name: "Work items", current: false }));
    expect(location.pathname).toBe("/app/items");
  });

  it("the items page filters by state through the API's state parameter", async () => {
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

// ---- ItemsTable (issue #240): title link, Issue and PR columns only with the GitHub plugin ----
const GH = { issues: "github", prs: "github" } as const;
const NONE = { issues: null, prs: null } as const;
const trow = (n: number, extra: Partial<ItemRow> = {}): ItemRow => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title: `Title ${n}`,
  level: "running", badges: [], stage: "RUNNING", tier: 2, kind: null, blocked_on: "none", blocked_reason: null, close_reason: null,
  run_status: null, pr_number: null, pr_url: null, issue: { number: n, url: `https://github.com/o/r/issues/${n}` }, since: AT,
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

  it("shows the item id as the link text when there is no title", () => {
    const a = cells(itemsTable([trow(2, { title: null })], GH))[0]!.querySelector("a")!;
    expect(a.textContent).toBe("wi_2");
    expect(a.getAttribute("href")).toBe("/app/items/wi_2");
  });

  it("with GitHub: Issue links to the issue, PR to the PR, a dash when there is none", () => {
    const c = itemsTable([trow(3, { pr_number: 9, pr_url: "https://github.com/o/r/pull/9" }), trow(4)], GH);
    expect(heads(c)).toEqual(["Item", "State", "Why", "Since", "Issue", "PR"]);
    const [r1, r2] = [...c.querySelectorAll("tbody tr")] as HTMLElement[];
    const t1 = [...r1!.querySelectorAll("td")];
    expect(t1[4]!.querySelector("a")!.getAttribute("href")).toBe("https://github.com/o/r/issues/3");
    expect(t1[4]!.textContent).toBe("#3");
    expect(t1[5]!.querySelector("a")!.getAttribute("href")).toBe("https://github.com/o/r/pull/9");
    expect(t1[5]!.textContent).toBe("#9");
    expect([...r2!.querySelectorAll("td")][5]!.textContent).toBe("–");
  });

  it("without GitHub: no Issue or PR column and no link to github.com", () => {
    for (const plugins of [NONE, undefined]) {
      const c = itemsTable([trow(5, { pr_number: 9, pr_url: "https://github.com/o/r/pull/9" })], plugins);
      expect(heads(c)).toEqual(["Item", "State", "Why", "Since"]);
      expect(c.innerHTML).not.toContain("github.com");
      cleanup();
    }
  });

  it("an adopted PR shows a dash under Issue and its number under PR", () => {
    const c = itemsTable([trow(6, { issue: null, pr_number: 6, pr_url: "https://github.com/o/r/pull/6" })], GH);
    const td = cells(c);
    expect(td[4]!.textContent).toBe("–");
    expect(td[5]!.textContent).toBe("#6");
  });

  it("a PR without a link (unknown project label) shows its number as text", () => {
    const td = cells(itemsTable([trow(7, { pr_number: 7, pr_url: null })], GH));
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
