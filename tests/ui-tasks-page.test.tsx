// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRow, ItemRow, TaskRow, TasksView } from "../web/src/api.js";
import { PAGES, routeFor } from "../web/src/pages.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-rules-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/tasks.js";
const { TasksPage, dayLabel } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { TasksPage: FunctionComponent; dayLabel: (date: string) => string };

// The Tasks page (design 02-tasks, one list): every task over GET /api/v1/tasks in the groups overdue (in red), today,
// later days by date and no date, paged 20 to a page; a done task is struck through, with Reopen; Build this posts the
// task's ID once, a built task links to its item.

const TOKEN = "tok_tasks";
const SLOW = { timeout: 5_000 };

const row = (id: string, over: Partial<TaskRow> = {}): TaskRow => ({
  id, title: id, list: null, priority: null, due_date: null, due_time: null, recurrence: null, work_item_id: null, ...over,
});
const view = (over: Partial<TasksView> = {}): TasksView => ({
  today_date: "2026-11-12",
  today: { overdue: [row("tk_late", { due_date: "2026-11-10" })], due: [row("tk_now", { due_date: "2026-11-12", due_time: "09:00" })] },
  // The server's upcoming starts at today; the page shows the days after it.
  upcoming: [
    { date: "2026-11-12", tasks: [row("tk_now", { due_date: "2026-11-12", due_time: "09:00" })] },
    { date: "2026-11-13", tasks: [row("tk_soon", { due_date: "2026-11-13", list: "home" })] },
  ],
  projects: [{ list: "home", tasks: [row("tk_soon", { due_date: "2026-11-13", list: "home" })] }, { list: null, tasks: [row("tk_built", { work_item_id: "wi_1" }), row("tk_inbox")] }],
  csrf_token: TOKEN,
  can_build: true,
  ...over,
});
const item = (id: string, over: Partial<ItemRow> = {}): ItemRow => ({
  id, source: { type: "local", id: `local:${id}` }, title: `Work ${id}`, level: "needs_you", badges: [], stage: "REVIEW", tier: null, kind: null,
  blocked_on: "human", blocked_reason: null, close_reason: null, run_status: null, change_ref: null, change_url: null, since: "2026-11-12T00:00:00.000Z",
  updated_at: "2026-11-12T00:00:00.000Z", version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 }, commands: [], ...over,
} as ItemRow);
let items: ItemRow[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let current: TasksView;
/** GET /api/v1/tasks?project=<slug>'s answer by slug (the project switcher); an unlisted slug answers 404. */
let filtered: Record<string, TasksView>;
let posts: { url: string; init: RequestInit }[];
let answer: { status: number; body: unknown };
/** The item commands POSTs' answers in order (the last repeats); empty: `answer`. */
let commandAnswers: { status: number; body: unknown }[];
/** The csrf_token of each GET /api/v1/session, in order (the last repeats). */
let sessionTokens: string[];
let sessionReads: number;

beforeEach(() => {
  current = view();
  filtered = {};
  history.replaceState(null, "", "/app/tasks");
  items = [];
  posts = [];
  answer = { status: 200, body: { task_id: "tk_now", work_item_id: "wi_9", created: true } };
  commandAnswers = [];
  sessionTokens = [TOKEN];
  sessionReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
      const commands = posts.filter((p) => p.url.endsWith("/commands")).length;
      const a = url.endsWith("/commands") && commandAnswers.length > 0 ? commandAnswers[Math.min(commands, commandAnswers.length) - 1]! : answer;
      return json(a.status, a.body);
    }
    if (url === "/api/v1/session") {
      const token = sessionTokens[Math.min(sessionReads++, sessionTokens.length - 1)]!;
      return json(200, { as_of: "2026-11-12T00:00:00.000Z", csrf_token: token, commands_enabled: true, actor: "local:me", actor_source: "environment" });
    }
    if (url === "/api/v1/tasks") return json(200, current);
    if (url.startsWith("/api/v1/tasks?project=")) {
      const slug = decodeURIComponent(url.slice("/api/v1/tasks?project=".length));
      return filtered[slug] ? json(200, filtered[slug]) : json(404, { error: `no project "${slug}"` });
    }
    if (url === "/api/v1/items") return json(200, { as_of: "2026-11-12T00:00:00.000Z", total: items.length, items, facets: {} });
    if (url === "/api/v1/pauses") return json(200, { pauses: [], csrf_token: null });
    if (url === "/api/v1/overview") return json(200, { as_of: "2026-11-12T00:00:00.000Z", stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, system_actions: [] });
    if (url === "/api/v1/session") return json(200, { as_of: "2026-11-12T00:00:00.000Z", csrf_token: TOKEN, commands_enabled: true, actor: "local:me", actor_source: "environment" });
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The page once its tasks show (for a view with no overdue group). */
async function show2() {
  render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(TasksPage)));
  await waitFor(() => expect(document.querySelector("[data-task]")).not.toBeNull(), SLOW);
}

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
  await screen.findByRole("list", { name: "Overdue" }, SLOW);
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-task="${id}"]`)!;

describe("Tasks page", () => {
  it("is a sidebar page at /app/tasks", () => {
    expect(routeFor("/app/tasks").page.label).toBe("Tasks");
    expect(PAGES.map((p) => p.path)).toContain("tasks");
  });

  it("has no view tabs: no Task view control and no Today, Upcoming or All button", async () => {
    await show();
    expect(screen.queryByRole("group", { name: "Task view" })).toBeNull();
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    for (const name of ["Today", "Upcoming", "All"]) expect(names).not.toContain(name);
  });

  it("lists overdue tasks first, in red, then today's", async () => {
    await show();
    const cards = [...document.querySelectorAll<HTMLElement>("[data-task]")].map((e) => e.dataset.task);
    expect(cards.slice(0, 2)).toEqual(["tk_late", "tk_now"]);
    expect(card("tk_late").hasAttribute("data-overdue")).toBe(true);
    expect(card("tk_late").querySelector("p")!.className).toContain("text-pill-bad-fg");
    expect(card("tk_late").textContent).toContain("Overdue");
    expect(card("tk_now").hasAttribute("data-overdue")).toBe(false);
    expect(card("tk_now").querySelector("p")!.className).not.toContain("text-pill-bad-fg");
  });

  it("shows later days by date and undated tasks under No date; a built task links to its work item", async () => {
    await show();
    expect(within(screen.getByRole("list", { name: dayLabel("2026-11-13") })).getByText("tk_soon")).toBeTruthy();
    expect(card("tk_soon").textContent).toContain("#home");
    expect(screen.getByRole("list", { name: "No date" }).textContent).toContain("tk_inbox");
    const built = within(card("tk_built"));
    expect(built.getByRole("link", { name: "wi_1" }).getAttribute("href")).toBe("/app/items/wi_1");
    expect(built.queryByRole("button", { name: /Build this/ })).toBeNull();
  });

  it("groups come in the order overdue, today, later days by date, no date, with today on the first page", async () => {
    current = view({
      today: { overdue: [row("tk_late", { due_date: "2026-11-10" })], due: [row("tk_now", { due_date: "2026-11-12" })] },
      projects: [{ list: null, tasks: [row("tk_none"), row("tk_far", { due_date: "2026-12-01" }), row("tk_next", { due_date: "2026-11-13" })] }],
    });
    await show();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent).filter((h) => !h!.startsWith("Timeline"));
    expect(headings).toEqual(["Overdue", `Today, ${dayLabel("2026-11-12")}`, dayLabel("2026-11-13"), dayLabel("2026-12-01"), "No date"]);
    expect([...document.querySelectorAll<HTMLElement>("[data-task]")].map((e) => e.dataset.task)).toEqual(["tk_late", "tk_now", "tk_next", "tk_far", "tk_none"]);
    // Everything fits on the first page: there is no pager.
    expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
  });

  describe("pagination", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => row(`tk_n${String(i).padStart(2, "0")}`, { due_date: "2026-11-20" }));
    const shown = () => [...document.querySelectorAll<HTMLElement>("[data-task]")].map((e) => e.dataset.task);

    it("pages the list: Next shows the following tasks, Previous goes back, and the ends are disabled", async () => {
      current = view({ today: { overdue: [], due: [row("tk_now", { due_date: "2026-11-12" })] }, projects: [{ list: null, tasks: many(25) }] });
      await show2();
      const first = shown();
      expect(first[0]).toBe("tk_now");
      expect(first.length).toBeGreaterThan(1);
      const nav = screen.getByRole("navigation", { name: "Pagination" });
      expect(within(nav).getByText("Page 1 of 2")).toBeTruthy();
      expect((within(nav).getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(within(nav).getByRole("button", { name: "Next" }));
      expect(within(nav).getByText("Page 2 of 2")).toBeTruthy();
      const second = shown();
      expect(second.length).toBeGreaterThan(0);
      expect(second.filter((id) => first.includes(id))).toEqual([]);
      expect(first.length + second.length).toBe(26);
      expect((within(nav).getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(within(nav).getByRole("button", { name: "Previous" }));
      expect(shown()).toEqual(first);
    });

    it("a group that crosses the page boundary keeps its heading on both pages", async () => {
      current = view({ today: { overdue: [], due: [] }, projects: [{ list: null, tasks: many(25) }] });
      await show2();
      const heading = dayLabel("2026-11-20");
      expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    });
  });

  it("Build this posts the task's ID with the token; a refusal stays beside the button", async () => {
    await show();
    fireEvent.click(within(card("tk_now")).getByRole("button", { name: "Build this: tk_now" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("/api/v1/tasks/build");
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ id: "tk_now" });
    answer = { status: 409, body: { error: "no project is stored yet" } };
    fireEvent.click(within(card("tk_late")).getByRole("button", { name: "Build this: tk_late" }));
    expect((await within(card("tk_late")).findByRole("alert", undefined, SLOW)).textContent).toBe("no project is stored yet");
  });

  describe("⌘Z undoes this page's completions (design 02-tasks, undo a completion)", () => {
    const undo = (init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key: "z", metaKey: true, ...init });
    const gets = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/v1/tasks" && (init as RequestInit | undefined)?.method !== "POST").length;

    it("reopens the task the checkbox completed, then reloads the list so it shows open again", async () => {
      await show();
      const today = current.today;
      answer = { status: 200, body: { task_id: "tk_now", completed: true, next_id: null } };
      current = view({ today: { ...today, due: [] } });
      fireEvent.click(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" }));
      await waitFor(() => expect(document.querySelector('[data-task="tk_now"]')).toBeNull(), SLOW);
      answer = { status: 200, body: { task_id: "tk_now", reopened: true, removed_next: null } };
      current = view();
      const before = gets();
      undo();
      await waitFor(() => expect(posts).toHaveLength(2));
      expect(posts[1]!.url).toBe("/api/v1/tasks/reopen");
      expect(new Headers(posts[1]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
      expect(JSON.parse(String(posts[1]!.init.body))).toEqual({ id: "tk_now" });
      await waitFor(() => expect(gets()).toBeGreaterThan(before));
      expect(await screen.findByRole("checkbox", { name: "Complete: tk_now" }, SLOW)).toBeTruthy();
      // That completion is undone: a second ⌘Z has nothing left and sends nothing.
      undo();
      await new Promise((r) => setTimeout(r, 20));
      expect(posts).toHaveLength(2);
    });

    it("with nothing completed on this page it does nothing and sends no request; Ctrl, Alt or Shift is no undo", async () => {
      await show();
      undo();
      fireEvent.click(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" }));
      await waitFor(() => expect(posts).toHaveLength(1));
      for (const init of [{ metaKey: false, ctrlKey: true }, { altKey: true }, { shiftKey: true }]) undo(init);
      await new Promise((r) => setTimeout(r, 20));
      expect(posts.map((p) => p.url)).toEqual(["/api/v1/tasks/done"]);
    });

    it("a refusal shows its reason", async () => {
      await show();
      fireEvent.click(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" }));
      await waitFor(() => expect(posts).toHaveLength(1));
      answer = { status: 409, body: { error: "its next occurrence is done: undo that one first" } };
      undo();
      expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toBe("its next occurrence is done: undo that one first");
    });
  });

  describe("done tasks stay, struck through (design 02-tasks, done tasks stay)", () => {
    const AT = "2026-11-12T09:10:00.000Z";
    const done = (id: string, over: Partial<TaskRow> = {}): TaskRow => row(id, { done_at: AT, ...over });
    const title = (id: string) => within(card(id)).getByText(id, { selector: "p" });
    /** Today's tk_now as the server places it, done or open. */
    const withNow = (now: TaskRow) => view({ today: { overdue: view().today.overdue, due: [now] } });

    it("a task marked done from the list stays in it: its title struck through, Reopen in place of the checkbox", async () => {
      await show();
      answer = { status: 200, body: { task_id: "tk_now", completed: true, next_id: null } };
      current = withNow(done("tk_now", { due_date: "2026-11-12", due_time: "09:00" }));
      fireEvent.click(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" }));
      await waitFor(() => expect(within(card("tk_now")).queryByRole("button", { name: "Reopen: tk_now" })).not.toBeNull(), SLOW);
      expect(title("tk_now").className.split(" ")).toContain("line-through");
      expect(within(card("tk_now")).queryByRole("checkbox")).toBeNull();
      expect(card("tk_now").hasAttribute("data-done")).toBe(true);
      expect([...document.querySelectorAll<HTMLElement>("[data-task]")].map((e) => e.dataset.task).slice(0, 2)).toEqual(["tk_late", "tk_now"]);
    });

    it("a task whose factory work merged shows struck through, with its work item and Reopen, not removed", async () => {
      items = [item("wi_1", { level: "closed", close_reason: "completed", stage: "CLOSED" })];
      current = view({ projects: [{ list: null, tasks: [done("tk_built", { work_item_id: "wi_1" }), row("tk_inbox")] }] });
      await show();
      expect(title("tk_built").className.split(" ")).toContain("line-through");
      expect(within(card("tk_built")).getByRole("link", { name: "wi_1" })).toBeTruthy();
      expect(within(card("tk_built")).getByRole("button", { name: "Reopen: tk_built" })).toBeTruthy();
      expect(card("tk_built").textContent).toContain("done 2026-11-12");
      expect(title("tk_inbox").className.split(" ")).not.toContain("line-through");
    });

    it("Reopen posts { id } to the reopen route with the token; the row shows open again", async () => {
      current = withNow(done("tk_now", { due_date: "2026-11-12" }));
      await show();
      answer = { status: 200, body: { task_id: "tk_now", reopened: true, removed_next: null } };
      const reopened = withNow(row("tk_now", { due_date: "2026-11-12" }));
      fireEvent.click(within(card("tk_now")).getByRole("button", { name: "Reopen: tk_now" }));
      current = reopened;
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]!.url).toBe("/api/v1/tasks/reopen");
      expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
      expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ id: "tk_now" });
      await waitFor(() => expect(within(card("tk_now")).queryByRole("button", { name: "Reopen: tk_now" })).toBeNull(), SLOW);
      expect(title("tk_now").className.split(" ")).not.toContain("line-through");
      expect(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" })).toBeTruthy();
    });

    it("a done row offers only Reopen: no checkbox, Build this, edit, sub-task, projects or delete; and it is not styled overdue", async () => {
      current = view({ today: { overdue: [done("tk_late", { due_date: "2026-11-10" })], due: [] } });
      await show();
      const c = within(card("tk_late"));
      expect(c.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Reopen: tk_late"]);
      expect(c.queryByRole("checkbox")).toBeNull();
      expect(card("tk_late").hasAttribute("data-overdue")).toBe(false);
      expect(card("tk_late").getAttribute("draggable")).not.toBe("true");
      expect(title("tk_late").className).not.toContain("text-pill-bad-fg");
      expect(card("tk_late").textContent).not.toContain("Overdue");
      card("tk_late").focus();
      fireEvent.keyDown(card("tk_late"), { key: "e" });
      fireEvent.keyDown(card("tk_late"), { key: "Delete" });
      expect(card("tk_late").querySelector("form")).toBeNull();
      expect(document.querySelector("[data-dialog]")).toBeNull();
    });

    it("a refused reopen shows its reason in the row, and the row stays done", async () => {
      current = withNow(done("tk_now", { recurrence: "week" }));
      await show();
      answer = { status: 409, body: { error: "its next occurrence is done: undo that one first" } };
      fireEvent.click(within(card("tk_now")).getByRole("button", { name: "Reopen: tk_now" }));
      expect((await within(card("tk_now")).findByRole("alert", undefined, SLOW)).textContent).toBe("its next occurrence is done: undo that one first");
      expect(title("tk_now").className.split(" ")).toContain("line-through");
    });

    it("there is no Show done switch and no done list read", async () => {
      await show();
      expect(screen.queryByRole("switch")).toBeNull();
      expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).startsWith("/api/v1/tasks/done") && (init as RequestInit | undefined)?.method !== "POST")).toBe(false);
    });

    it("with no commands actor a done row has no Reopen button", async () => {
      current = view({ can_build: false, projects: [{ list: null, tasks: [done("tk_a")] }] });
      await show();
      expect(title("tk_a").className.split(" ")).toContain("line-through");
      expect(screen.queryByRole("button", { name: /Reopen/ })).toBeNull();
    });
  });

  it("with no commands actor there is no Build this button", async () => {
    current = view({ can_build: false });
    await show();
    expect(screen.queryByRole("button", { name: /Build this/ })).toBeNull();
  });

  describe("calendar events leave the Tasks list (design 02-tasks)", () => {
    const ev = (id: string, time: string | null): EventRow => ({ kind: "event", source: "google-calendar", id, title: `event ${id}`, all_day: time === null, time });

    it("the list shows no event row and no stale-sync notice", async () => {
      current = view({
        today: { overdue: [], due: [ev("holiday", null), row("tk_call", { due_date: "2026-11-12", due_time: "11:00" })] },
        upcoming: [{ date: "2026-11-13", tasks: [ev("dentist", "08:00"), row("tk_soon", { due_date: "2026-11-13" })] }],
        calendar: [{ source: "google-calendar", synced_at: null, failed: true }],
      });
      render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(TasksPage)));
      await screen.findByText("tk_call", undefined, SLOW);
      expect(document.querySelector("[data-event]")).toBeNull();
      expect(document.querySelector("[data-calendar-stale]")).toBeNull();
      expect(card("tk_call")).not.toBeNull();
      expect(document.body.textContent).not.toContain("event holiday");
    });
  });

  describe("today's timeline (design 02-tasks, schedule a task)", () => {
    const slot = (time: string) => document.querySelector<HTMLElement>(`[data-slot="${time}"]`)!;
    const block = (id: string) => document.querySelector<HTMLElement>(`[data-block="${id}"]`)!;
    /** A drag carrying `id`, as a task row's drag start sets it. */
    const carrying = (id: string) => ({ dataTransfer: { getData: (type: string) => (type === "text/plain" ? id : ""), setData: () => {} } });
    /** The timeline starts collapsed; its control (aria-expanded) opens it. */
    const expand = () => fireEvent.click(screen.getByRole("button", { name: "Show timeline" }));

    it("is collapsed by default and expands on a control with aria-expanded", async () => {
      await show();
      const control = screen.getByRole("button", { name: "Show timeline" });
      expect(control.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("[data-slot]")).toBeNull();
      fireEvent.click(control);
      expect(screen.getByRole("button", { name: "Hide timeline" }).getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelectorAll("[data-slot]").length).toBeGreaterThan(0);
    });

    it("dragging a task onto a slot posts its ID with today's date and the slot's time", async () => {
      await show();
      expand();
      const data = new Map<string, string>();
      fireEvent.dragStart(card("tk_late"), { dataTransfer: { setData: (type: string, v: string) => data.set(type, v), getData: () => "" } });
      expect(data.get("text/plain")).toBe("tk_late");
      fireEvent.dragOver(slot("15:30"), carrying("tk_late"));
      fireEvent.drop(slot("15:30"), carrying("tk_late"));
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]!.url).toBe("/api/v1/tasks/schedule");
      expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
      expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ id: "tk_late", date: "2026-11-12", time: "15:30" });
    });

    it("shows once, above the list; a refusal shows above the timeline", async () => {
      await show();
      expect(screen.getAllByRole("button", { name: "Show timeline" })).toHaveLength(1);
      expand();
      answer = { status: 409, body: { error: "the task is done: a done task cannot be scheduled" } };
      fireEvent.drop(slot("09:00"), carrying("tk_late"));
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ id: "tk_late", date: "2026-11-12", time: "09:00" });
      expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toBe("the task is done: a done task cannot be scheduled");
    });

    it("draws a timed task with no stored duration as 30 minutes and a stored duration as its length; an event is not drawn", async () => {
      current = view({
        today: { overdue: [], due: [row("tk_call", { due_date: "2026-11-12", due_time: "15:00" }), row("tk_gym", { due_date: "2026-11-12", due_time: "18:00", duration_minutes: 90 })] },
        timeline: [
          { kind: "task", id: "tk_call", title: "call", start: "15:00", end: "15:30", offset: 900, minutes: 30 },
          { kind: "task", id: "tk_gym", title: "gym", start: "18:00", end: "19:30", offset: 1080, minutes: 90 },
          { kind: "event", id: "work:ev1", title: "standup", start: "09:00", end: "09:15", offset: 540, minutes: 15 },
        ],
      });
      render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(TasksPage)));
      await screen.findByRole("list", { name: /^Today/ }, SLOW);
      expand();
      expect(card("tk_call").textContent).toContain("30 min");
      expect(card("tk_gym").textContent).toContain("90 min");
      // A slot is 1.5rem per 30 minutes: 15:00 is 45rem down, 30 minutes 1.5rem high; 90 minutes 4.5rem.
      expect([block("tk_call").style.top, block("tk_call").style.height]).toEqual(["45rem", "1.5rem"]);
      expect(block("tk_call").textContent).toContain("15:00–15:30");
      expect(block("tk_gym").style.height).toBe("4.5rem");
      expect(block("tk_gym").textContent).toContain("18:00–19:30");
      expect(block("work:ev1")).toBeNull();
      expect(within(screen.getByRole("list", { name: "Scheduled today" })).queryByRole("button")).toBeNull();
    });

    it("with no commands actor a row is not draggable and a drop posts nothing", async () => {
      current = view({ can_build: false });
      await show();
      expect(card("tk_late").getAttribute("draggable")).toBe("false");
      expand();
      fireEvent.drop(slot("15:00"), carrying("tk_late"));
      expect(posts).toEqual([]);
    });
  });

  describe("quick add", () => {
    const field = () => screen.getByRole("textbox", { name: "Add a task" }) as HTMLInputElement;
    const type = (v: string) => fireEvent.change(field(), { target: { value: v } });
    const enter = () => fireEvent.submit(field().closest("form")!);

    it("Enter posts { id, words } with the token; the field clears, keeps focus and the new task shows", async () => {
      await show();
      answer = { status: 200, body: { id: "tk_new" } };
      type("pay rent friday p1 #home");
      current = view({ today: { overdue: [], due: [row("tk_rent", { title: "pay rent" })] } });
      enter();
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]!.url).toBe("/api/v1/tasks");
      expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
      const body = JSON.parse(String(posts[0]!.init.body));
      expect(body.words).toBe("pay rent friday p1 #home");
      expect(body.id).toMatch(/^tk_[A-Za-z0-9_-]{8,64}$/);
      await waitFor(() => expect(card("tk_rent")).not.toBeNull(), SLOW);
      await waitFor(() => expect(field().value).toBe(""));
      expect(document.activeElement).toBe(field());
    });

    it("a refusal shows its message beside the field, keeps the text and adds nothing; a retry sends the same id", async () => {
      await show();
      const before = document.querySelectorAll("[data-task]").length;
      answer = { status: 400, body: { error: "no title" } };
      type("p1");
      enter();
      expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toBe("no title");
      expect(field().value).toBe("p1");
      expect(document.querySelectorAll("[data-task]")).toHaveLength(before);
      enter();
      await waitFor(() => expect(posts).toHaveLength(2));
      expect(JSON.parse(String(posts[1]!.init.body)).id).toBe(JSON.parse(String(posts[0]!.init.body)).id);
    });

    it("a network error shows its message and keeps the text", async () => {
      await show();
      const ok = fetch;
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") throw new Error("offline");
        return ok(url, init);
      }));
      type("call bank");
      enter();
      expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toBe("offline");
      expect(field().value).toBe("call bank");
    });

    it("the Add button submits, and Esc clears the field", async () => {
      await show();
      type("buy milk");
      fireEvent.keyDown(field(), { key: "Escape" });
      expect(field().value).toBe("");
      type("buy milk");
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(posts).toHaveLength(1));
    });

    describe("the submit key (tasks_add_key, design 02-tasks)", () => {
      const press = (over: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(field(), { key: "Enter", ...over });
      const layout = () => [field().className, field().closest("form")!.className, field().parentElement!.className];

      it("enter (the default, and with no add_key): Enter adds the task, ⌘Enter does not, and the hint says Enter", async () => {
        await show();
        const before = layout();
        expect(field().placeholder).toBe("e.g. rent friday p1 #home, then Enter");
        expect(field().getAttribute("aria-keyshortcuts")).toBe("Enter");
        type("buy milk");
        press({ metaKey: true });
        await new Promise((r) => setTimeout(r, 20));
        expect(posts).toHaveLength(0);
        press();
        await waitFor(() => expect(posts).toHaveLength(1));
        expect(JSON.parse(String(posts[0]!.init.body)).words).toBe("buy milk");
        expect(layout()).toEqual(before);
      });

      it("cmd-enter: ⌘Enter adds the task, plain Enter adds nothing, the hint says ⌘Enter, and the layout is the same", async () => {
        await show();
        const enterLayout = layout();
        cleanup();
        current = { ...view(), add_key: "cmd-enter" } as TasksView;
        await show();
        expect(field().placeholder).toBe("e.g. rent friday p1 #home, then ⌘Enter");
        expect(field().getAttribute("aria-keyshortcuts")).toBe("Meta+Enter");
        expect(layout()).toEqual(enterLayout);
        type("buy milk");
        expect(press()).toBe(false); // the browser's own submit on Enter is prevented
        await new Promise((r) => setTimeout(r, 20));
        expect(posts).toHaveLength(0);
        expect(field().value).toBe("buy milk");
        press({ metaKey: true });
        await waitFor(() => expect(posts).toHaveLength(1));
        expect(JSON.parse(String(posts[0]!.init.body)).words).toBe("buy milk");
      });

      for (const add_key of ["enter", "cmd-enter"]) {
        it(`${add_key}: the Add button adds the task, and a refusal shows its reason beside the field and keeps the words`, async () => {
          current = { ...view(), add_key } as TasksView;
          await show();
          answer = { status: 400, body: { error: "no title" } };
          type("p1");
          fireEvent.click(screen.getByRole("button", { name: "Add" }));
          expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toBe("no title");
          expect(field().value).toBe("p1");
          expect(posts).toHaveLength(1);
        });
      }
    });

    it("no longer hints at factory task add, and keeps the Build this line", async () => {
      await show();
      expect(document.body.textContent).not.toContain("factory task add");
      expect(document.body.textContent).toContain("Build this sends a task to the factory.");
    });
  });

  describe("polish (UI review)", () => {
    const BUILD = "Build this sends a task to the factory.";
    const ev = (id: string): EventRow => ({ kind: "event", source: "google-calendar", id, title: `event ${id}`, all_day: true, time: null });

    it("the page stacks the project tabs, Quick add, Needs you, then the list, with no mb-/mt- on Quick add or Needs you", async () => {
      items = [item("wi_x", { title: "Approve the spec", level: "needs_approval" })];
      await show();
      const factory = await screen.findByRole("region", { name: "Needs you" }, SLOW);
      const picker = screen.getByRole("tablist", { name: "Project" });
      expect(screen.queryByRole("combobox")).toBeNull();
      const form = screen.getByLabelText("Add a task").closest("form")!;
      const view = screen.getByRole("region", { name: "Open tasks" });
      const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      expect(follows(picker, form) && follows(form, factory) && follows(factory, view)).toBe(true);
      expect(form.className).not.toMatch(/\bm[bt]-/);
      expect(factory.parentElement!.className).not.toMatch(/\bm[bt]-/);
      // The count shows with a word or not at all: never a bare number.
      expect(view.firstElementChild!.querySelector("span")).toBeNull();
    });

    it("an empty list shows its message only, saying to add a task in the field above, with no button", async () => {
      current = view({ today: { overdue: [], due: [] }, upcoming: [], projects: [] });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
      const message = await screen.findByText("No open task. Add a task in the field above.", {}, SLOW);
      expect(within(message.parentElement!).queryByRole("button")).toBeNull();
      expect(screen.queryByRole("button", { name: /Add one above/ })).toBeNull();
    });

    it("shows the Build line only when the list holds a task and can_build is true", async () => {
      await show();
      expect(document.body.textContent).toContain(BUILD);
      cleanup();
      current = view({ can_build: false });
      await show();
      expect(document.body.textContent).not.toContain(BUILD);
      cleanup();
      current = view({ today: { overdue: [], due: [ev("e1")] }, projects: [] });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
      await screen.findByText("No open task. Add a task in the field above.", {}, SLOW);
      expect(document.body.textContent).not.toContain(BUILD);
    });

    it("hides the Build line while loading", async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
      expect(document.body.textContent).not.toContain(BUILD);
      await screen.findByRole("list", { name: "Overdue" }, SLOW);
      expect(document.body.textContent).toContain(BUILD);
    });

    it("the overdue label is a StatusBadge", async () => {
      current = view({ today: { overdue: [row("tk_late", { due_date: "2026-11-10" })], due: [] } });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
      await screen.findByRole("list", { name: "Overdue" }, SLOW);
      const overdue = within(card("tk_late")).getByText("Overdue");
      expect(overdue.className).toContain("rounded-pill");
      expect(overdue.getAttribute("data-level")).toBe("stuck");
    });
  });

  describe("task projects (design 09-dashboard-app, project switcher and dialog)", () => {
    const PROJECTS = [{ slug: "home", name: "Home" }, { slug: "garden", name: "Garden" }];
    const projectTab = (name: string) => screen.getByRole("tab", { name });
    const selectedProject = () => screen.getAllByRole("tab").filter((b) => b.getAttribute("aria-selected") === "true").map((b) => b.textContent);
    const reads = () => vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter((u) => u.startsWith("/api/v1/tasks"));
    const homeOnly = () =>
      view({
        today: { overdue: [], due: [row("tk_now", { due_date: "2026-11-12", projects: ["home"] })] },
        upcoming: [],
        projects: [{ list: null, tasks: [row("tk_inbox", { projects: ["home"] }), row("tk_now", { due_date: "2026-11-12", projects: ["home"] }), row("tk_fixed", { projects: ["home"], done_at: "2026-11-11T10:00:00.000Z" })] }],
        active_projects: PROJECTS,
      });

    it("the switcher lists All projects first, then the active projects, and reads its value from ?project= on load", async () => {
      current = view({ active_projects: PROJECTS });
      filtered = { home: homeOnly() };
      history.replaceState(null, "", "/app/tasks?project=home");
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
      await waitFor(() => expect(document.querySelector('[data-task="tk_now"]')).not.toBeNull(), SLOW);
      expect(screen.getAllByRole("tab").map((b) => b.textContent)).toEqual(["All projects", "Home", "Garden"]);
      expect(selectedProject()).toEqual(["Home"]);
      expect(reads()).toContain("/api/v1/tasks?project=home");
      expect(reads()).not.toContain("/api/v1/tasks");
    });

    it("choosing a project sets ?project= and filters the one list, done rows too; All projects clears it", async () => {
      current = view({ active_projects: PROJECTS });
      filtered = { home: homeOnly() };
      await show();
      expect(selectedProject()).toEqual(["All projects"]);
      fireEvent.click(projectTab("Home"));
      expect(selectedProject()).toEqual(["Home"]);
      expect(new URLSearchParams(location.search).get("project")).toBe("home");
      expect(location.pathname).toBe("/app/tasks");
      await waitFor(() => expect([...document.querySelectorAll<HTMLElement>("[data-task]")].map((e) => e.dataset.task)).toEqual(["tk_now", "tk_inbox", "tk_fixed"]), SLOW);
      expect(card("tk_fixed").hasAttribute("data-done")).toBe(true);
      fireEvent.click(projectTab("All projects"));
      expect(location.search).toBe("");
      expect(await screen.findByRole("list", { name: "Overdue" }, SLOW)).toBeTruthy();
    });

    it("ArrowRight on a project tab selects the next one: the filtered read, the URL and aria-selected follow", async () => {
      current = view({ active_projects: PROJECTS });
      filtered = { home: homeOnly() };
      await show();
      projectTab("All projects").focus();
      fireEvent.keyDown(projectTab("All projects"), { key: "ArrowRight" });
      expect(selectedProject()).toEqual(["Home"]);
      expect(document.activeElement).toBe(projectTab("Home"));
      expect(new URLSearchParams(location.search).get("project")).toBe("home");
      await waitFor(() => expect(reads()).toContain("/api/v1/tasks?project=home"), SLOW);
      fireEvent.keyDown(projectTab("Home"), { key: "ArrowLeft" });
      expect(selectedProject()).toEqual(["All projects"]);
      expect(location.search).toBe("");
    });

    it("a ?project= slug that is not active stays listed by its slug", async () => {
      current = view({ active_projects: PROJECTS });
      history.replaceState(null, "", "/app/tasks?project=gone");
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
      await screen.findByRole("tab", { name: "+gone" }, SLOW);
      expect(selectedProject()).toEqual(["+gone"]);
    });

    it("Projects… opens the project dialog outside the row; a checkbox adds or removes the task's link", async () => {
      current = view({ projects: [{ list: null, tasks: [row("tk_inbox", { projects: ["home"] })] }], active_projects: PROJECTS });
      answer = { status: 200, body: { task_id: "tk_inbox", project: "garden", changed: true } };
      await show();
      fireEvent.click(within(card("tk_inbox")).getByRole("button", { name: "More actions: tk_inbox" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Projects…" }));
      const dialog = document.querySelector<HTMLElement>("[data-dialog]")!;
      expect(card("tk_inbox").contains(dialog)).toBe(false);
      const box = (name: string) => within(dialog).getByRole("checkbox", { name });
      expect(box("Home").getAttribute("aria-checked")).toBe("true");
      expect(box("Garden").getAttribute("aria-checked")).toBe("false");
      fireEvent.click(box("Garden"));
      await waitFor(() => expect(box("Garden").getAttribute("aria-checked")).toBe("true"), SLOW);
      fireEvent.click(box("Home"));
      await waitFor(() => expect(box("Home").getAttribute("aria-checked")).toBe("false"), SLOW);
      const sent = posts.filter((p) => p.url === "/api/v1/tasks/project").map((p) => JSON.parse(String(p.init.body)));
      expect(sent).toEqual([{ id: "tk_inbox", project: "garden", add: true }, { id: "tk_inbox", project: "home", add: false }]);
      expect((posts[0]!.init.headers as Record<string, string>)["x-csrf-token"]).toBe(TOKEN);
    });

    it("New project creates the project, then puts the task in it; a refusal stays in the dialog", async () => {
      current = view({ active_projects: [] });
      await show();
      fireEvent.click(within(card("tk_inbox")).getByRole("button", { name: "More actions: tk_inbox" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Projects…" }));
      const dialog = document.querySelector<HTMLElement>("[data-dialog]")!;
      expect(within(dialog).getByText("No project yet: create the first one below.")).toBeTruthy();
      answer = { status: 409, body: { error: 'project "home" exists already' } };
      fireEvent.change(within(dialog).getByLabelText("New project"), { target: { value: "Home" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
      expect((await within(dialog).findByRole("alert", {}, SLOW)).textContent).toBe('project "home" exists already');
      expect(posts.filter((p) => p.url === "/api/v1/tasks/project")).toEqual([]);
      answer = { status: 200, body: { project: { slug: "garden", name: "Garden" }, task_id: "tk_inbox", changed: true } };
      fireEvent.change(within(dialog).getByLabelText("New project"), { target: { value: "Garden" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
      await waitFor(() => expect(posts.some((p) => p.url === "/api/v1/tasks/project")).toBe(true), SLOW);
      const creates = posts.filter((p) => p.url === "/api/v1/projects").map((p) => JSON.parse(String(p.init.body)) as { id: string; name: string });
      expect(creates.map((c) => c.name)).toEqual(["Home", "Garden"]);
      expect(creates.every((c) => /^pj_[0-9a-f]{32}$/.test(c.id))).toBe(true);
      expect(JSON.parse(String(posts.at(-1)!.init.body))).toEqual({ id: "tk_inbox", project: "garden", add: true });
      expect((within(dialog).getByLabelText("New project") as HTMLInputElement).value).toBe("");
    });

    it("+ (Add project) after the last tab opens a name dialog; Create posts { id, name } and selects the new tab", async () => {
      current = view({ active_projects: PROJECTS });
      filtered = { garden: view({ active_projects: PROJECTS }), orchard: view({ active_projects: [...PROJECTS, { slug: "orchard", name: "Orchard" }] }) };
      await show();
      const add = screen.getByRole("button", { name: "Add project" });
      expect(add.textContent).toBe("+");
      expect(add.previousElementSibling).toBe(screen.getByRole("tablist", { name: "Project" }));
      fireEvent.click(add);
      const dialog = document.querySelector<HTMLElement>("[data-dialog]")!;
      const create = within(dialog).getByRole("button", { name: "Create project" }) as HTMLButtonElement;
      expect(create.disabled).toBe(true);
      answer = { status: 201, body: { project: { slug: "orchard", name: "Orchard" } } };
      fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "Orchard" } });
      expect(create.disabled).toBe(false);
      fireEvent.click(create);
      await waitFor(() => expect(document.querySelector("[data-dialog]")).toBeNull(), SLOW);
      const sent = posts.filter((p) => p.url === "/api/v1/projects").map((p) => JSON.parse(String(p.init.body)) as { id: string; name: string });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.name).toBe("Orchard");
      expect(sent[0]!.id).toMatch(/^pj_[0-9a-f]{32}$/);
      expect(new URLSearchParams(location.search).get("project")).toBe("orchard");
      await waitFor(() => expect(selectedProject()).toEqual(["Orchard"]), SLOW);
    });

    it("a refused create keeps the Add project dialog open with the reason and keeps the ID for a retry; Cancel sends nothing", async () => {
      current = view({ active_projects: PROJECTS });
      await show();
      fireEvent.click(screen.getByRole("button", { name: "Add project" }));
      const dialog = document.querySelector<HTMLElement>("[data-dialog]")!;
      answer = { status: 409, body: { error: 'project "home" exists already' } };
      fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "Home" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
      expect((await within(dialog).findByRole("alert", {}, SLOW)).textContent).toBe('project "home" exists already');
      expect(document.querySelector("[data-dialog]")).toBe(dialog);
      expect(selectedProject()).toEqual(["All projects"]);
      expect(location.search).toBe("");
      fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
      await waitFor(() => expect(posts.filter((p) => p.url === "/api/v1/projects")).toHaveLength(2), SLOW);
      const ids = posts.map((p) => (JSON.parse(String(p.init.body)) as { id: string }).id);
      expect(ids[1]).toBe(ids[0]);
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(document.querySelector("[data-dialog]")).toBeNull();
      expect(posts).toHaveLength(2);
    });

    it("a done row has no Projects… item", async () => {
      current = view({ projects: [{ list: null, tasks: [row("tk_old", { done_at: "2026-11-11T10:00:00.000Z" })] }] });
      await show();
      expect(within(card("tk_old")).queryByRole("button", { name: /More actions/ })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Projects…" })).toBeNull();
    });
  });

  describe("Needs you", () => {
    const section = () => screen.findByRole("region", { name: "Needs you" }, SLOW);

    it("lists a waiting item with no task as one compact list under its group label, with its count, its state once, its one primary action and no table header", async () => {
      items = [item("wi_x", { title: "Approve the spec", level: "needs_approval", commands: [{ name: "approve", usage: "/approve", description: "approve", allowed: true, reason: null }] }), item("wi_run", { title: "Busy", level: "running" })];
      await show();
      const el = await section();
      expect(within(el).getByText("Approve the spec")).toBeTruthy();
      expect(within(el).getByRole("heading", { name: "Approve" })).toBeTruthy();
      expect(el.querySelector("h2 + span")!.textContent).toBe("1");
      expect(within(el).getAllByText("Needs approval")).toHaveLength(1);
      expect(within(el).getByRole("button", { name: "Approve" })).toBeTruthy();
      expect(within(el).queryByText("Busy")).toBeNull();
      expect(el.querySelector("table, thead, th")).toBeNull();
      expect(el.textContent).not.toMatch(/Mergeable|spec ready/);
    });

    it("is not rendered when nothing waits", async () => {
      items = [item("wi_run", { title: "Busy", level: "running" })];
      await show();
      await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => u === "/api/v1/items")).toBe(true));
      expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    });

    it("a task whose work waits on a merge shows Merge on its row, and the item is not in the section", async () => {
      items = [item("wi_1", { title: "Ship it", level: "ready_to_merge", merge: { enabled: true, reason: null }, merge_check: { state: "mergeable", conflicts: [], head_sha: "a", base_sha: "b", checked_at: "2026-11-12T00:00:00.000Z" } } as Partial<ItemRow>)];
      await show();
      expect(await within(card("tk_built")).findByRole("button", { name: "Merge" }, SLOW)).toBeTruthy();
      expect(within(card("tk_built")).getByText("Ready to merge")).toBeTruthy();
      expect(within(card("tk_built")).queryByRole("button", { name: "Work item state: tk_built" })).toBeNull();
      expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    });

    it("a waiting item whose task is done stays in the section; the done row keeps its plain state", async () => {
      items = [item("wi_1", { title: "Ship it", level: "needs_approval" })];
      current = view({ projects: [{ list: null, tasks: [{ ...row("tk_built", { work_item_id: "wi_1" }), done_at: "2026-11-12T08:00:00.000Z" }, row("tk_inbox")] }] });
      await show();
      expect(within(await section()).getByText("Ship it")).toBeTruthy();
      expect(await within(card("tk_built")).findByRole("button", { name: "Work item state: tk_built" }, SLOW)).toBeTruthy();
      expect(within(card("tk_built")).queryByRole("link", { name: "Open" })).toBeNull();
      expect(within(card("tk_built")).queryByRole("button", { name: "Approve" })).toBeNull();
    });

    it("an item with a waiting task row and one with no task are listed once each, the first on its row only", async () => {
      items = [item("wi_1", { title: "Linked", level: "needs_approval" }), item("wi_x", { title: "Loose", level: "needs_approval" })];
      await show();
      const el = await section();
      expect([...el.querySelectorAll<HTMLElement>("li[data-key]")].map((r) => r.dataset.key)).toEqual(["wi_x"]);
      expect(el.querySelector("h2 + span")!.textContent).toBe("1");
    });

    it("a built task shows its work item's state", async () => {
      items = [item("wi_1", { level: "ready_to_merge" })];
      await show();
      expect(await within(card("tk_built")).findByText("Ready to merge", {}, SLOW)).toBeTruthy();
    });

    it("a merged item reads Merged, and the state opens a dialog with the full-page link", async () => {
      items = [item("wi_1", { level: "closed", close_reason: "completed", stage: "CLOSED" })];
      await show();
      expect(await within(card("tk_built")).findByText("Merged", {}, SLOW)).toBeTruthy();
      fireEvent.click(within(card("tk_built")).getByRole("button", { name: "Work item state: tk_built" }));
      const dialog = document.querySelector<HTMLElement>("[data-dialog]")!;
      expect(within(dialog).getByRole("link", { name: "Open the full item page" }).getAttribute("href")).toBe("/app/items/wi_1");
    });

    const STALE = { error: "Missing or stale x-csrf-token; reload the page.", code: "stale_csrf" };
    const mergeRow = () => item("wi_m", { title: "Task title that keeps its space", level: "ready_to_merge", merge: { enabled: true, reason: null } });
    const workRow = async (id: string) => {
      return (await section()).querySelector<HTMLElement>(`li[data-key="${id}"]`)!;
    };
    const pressMerge = async (row: HTMLElement) => {
      const button = within(row).getByRole("button", { name: "Merge" });
      await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false), SLOW);
      fireEvent.click(button);
    };

    it("a Merge refused for a stale token reads the session once, retries with the new token and shows the merge state, not the error", async () => {
      items = [mergeRow()];
      sessionTokens = [TOKEN, "tok_fresh"];
      commandAnswers = [{ status: 403, body: STALE }, { status: 202, body: { request_id: "app:1", seq: 1, command: "merge", work_item_id: "wi_m" } }];
      await show();
      const row = await workRow("wi_m");
      await pressMerge(row);
      await waitFor(() => expect(within(row).getByRole("button", { name: "Merging…" })).toBeTruthy(), SLOW);
      const sent = posts.filter((p) => p.url.endsWith("/commands")).map((p) => new Headers(p.init.headers).get("x-csrf-token"));
      expect(sent).toEqual([TOKEN, "tok_fresh"]);
      expect(sessionReads).toBe(2);
      expect(row.textContent).not.toContain(STALE.error);
    });

    it("a Merge whose retry is refused again shows the error once, on its own full-width line below the row, outside the actions", async () => {
      items = [mergeRow()];
      commandAnswers = [{ status: 403, body: STALE }];
      await show();
      const row = await workRow("wi_m");
      await pressMerge(row);
      const error = await within(row).findByRole("alert", {}, SLOW);
      expect(error.textContent).toBe(STALE.error);
      expect(posts.filter((p) => p.url.endsWith("/commands")).map((p) => new Headers(p.init.headers).get("x-csrf-token"))).toEqual([TOKEN, TOKEN]);
      const actions = row.querySelector<HTMLElement>("[data-need-commands]")!;
      expect(actions.contains(error)).toBe(false);
      // Its own line: a direct child of the row that takes the full width, after the content and the actions.
      const line = error.closest<HTMLElement>("[data-row-error]")!;
      expect(line.parentElement).toBe(row);
      expect(line.className.split(" ")).toContain("basis-full");
      const children = [...row.children];
      expect(children.indexOf(line)).toBeGreaterThan(children.indexOf(actions.closest("li > *")!));
      // The title keeps its space: it grows from a fixed basis instead of shrinking to nothing beside the actions.
      const title = within(row).getByRole("link", { name: "Task title that keeps its space" });
      expect(title.closest("li > div")!.className.split(" ")).toEqual(expect.arrayContaining(["grow", "basis-64"]));
    });

    it("a checkbox still completes a task with the section on the page", async () => {
      items = [item("wi_1")];
      await show();
      fireEvent.click(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" }));
      await waitFor(() => expect(posts.some((p) => p.url.includes("done"))).toBe(true), SLOW);
    });
  });
});
