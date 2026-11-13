// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoneRow, DoneView, EventRow, ItemRow, TaskRow, TasksView } from "../web/src/api.js";
import { PAGES, routeFor } from "../web/src/pages.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-rules-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/tasks.js";
const { TasksPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { TasksPage: FunctionComponent };

// The Tasks page (design 02-tasks, issue #607): Inbox, Today (overdue first, in red), Upcoming (by day) and List
// tabs over GET /api/v1/tasks, which places each task; Build this posts the task's ID once, a built task links to its item.

const TOKEN = "tok_tasks";
const SLOW = { timeout: 5_000 };

const row = (id: string, over: Partial<TaskRow> = {}): TaskRow => ({
  id, title: id, list: null, priority: null, due_date: null, due_time: null, recurrence: null, work_item_id: null, ...over,
});
const view = (over: Partial<TasksView> = {}): TasksView => ({
  today_date: "2026-11-12",
  inbox: [row("tk_inbox")],
  today: { overdue: [row("tk_late", { due_date: "2026-11-10" })], due: [row("tk_now", { due_date: "2026-11-12", due_time: "09:00" })] },
  upcoming: [{ date: "2026-11-13", tasks: [row("tk_soon", { due_date: "2026-11-13", list: "home" })] }],
  projects: [{ list: "home", tasks: [row("tk_soon", { due_date: "2026-11-13", list: "home" })] }, { list: null, tasks: [row("tk_built", { work_item_id: "wi_1" })] }],
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
/** GET /api/v1/tasks/done's answer by its full URL (the first read, then each Show older); an unlisted URL reads empty. */
let donePages: Record<string, DoneView>;
let posts: { url: string; init: RequestInit }[];
let answer: { status: number; body: unknown };

beforeEach(() => {
  current = view();
  filtered = {};
  history.replaceState(null, "", "/app/tasks");
  items = [];
  donePages = {};
  posts = [];
  answer = { status: 200, body: { task_id: "tk_now", work_item_id: "wi_9", created: true } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
      return json(answer.status, answer.body);
    }
    if (url === "/api/v1/tasks") return json(200, current);
    if (url.startsWith("/api/v1/tasks?project=")) {
      const slug = decodeURIComponent(url.slice("/api/v1/tasks?project=".length));
      return filtered[slug] ? json(200, filtered[slug]) : json(404, { error: `no project "${slug}"` });
    }
    if (url === "/api/v1/items") return json(200, { as_of: "2026-11-12T00:00:00.000Z", total: items.length, items, facets: {} });
    if (url.startsWith("/api/v1/tasks/done")) return json(200, donePages[url] ?? { tasks: [], older: false, next_before: "2026-10-13T00:00:00.000Z" });
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
  await screen.findByRole("list", { name: "Overdue" }, SLOW);
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-task="${id}"]`)!;
const tab = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("Tasks page", () => {
  it("is a sidebar page at /app/tasks", () => {
    expect(routeFor("/app/tasks").page.label).toBe("Tasks");
    expect(PAGES.map((p) => p.path)).toContain("tasks");
  });

  it("the view picker is one segmented control in one row, Today selected first, the clicked view selected next", async () => {
    await show();
    const group = screen.getByRole("group", { name: "Task view" });
    expect([...group.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Inbox", "Today", "Upcoming", "List", "Done"]);
    expect(group.className.split(" ")).toContain("flex-nowrap");
    expect(group.className.split(" ")).not.toContain("flex-wrap");
    const selected = () => [...group.querySelectorAll("button[aria-pressed=true]")].map((b) => b.textContent);
    expect(selected()).toEqual(["Today"]);
    tab("List");
    expect(selected()).toEqual(["List"]);
  });

  it("Today lists overdue tasks first, in red, then today's", async () => {
    await show();
    const cards = [...document.querySelectorAll<HTMLElement>("[data-task]")].map((e) => e.dataset.task);
    expect(cards).toEqual(["tk_late", "tk_now"]);
    expect(card("tk_late").hasAttribute("data-overdue")).toBe(true);
    expect(card("tk_late").querySelector("p")!.className).toContain("text-pill-bad-fg");
    expect(card("tk_late").textContent).toContain("Overdue");
    expect(card("tk_now").hasAttribute("data-overdue")).toBe(false);
    expect(card("tk_now").querySelector("p")!.className).not.toContain("text-pill-bad-fg");
  });

  it("Inbox, Upcoming and List show their own tasks; a built task links to its work item instead of Build this", async () => {
    await show();
    tab("Inbox");
    expect(screen.getByRole("list", { name: "Inbox" }).textContent).toContain("tk_inbox");
    tab("Upcoming");
    expect(card("tk_soon").textContent).toContain("#home");
    expect(document.querySelectorAll("[data-task]")).toHaveLength(1);
    tab("List");
    expect(screen.getByRole("list", { name: "#home" }).textContent).toContain("tk_soon");
    const built = within(screen.getByRole("list", { name: "No list" }));
    expect(built.getByRole("link", { name: "wi_1" }).getAttribute("href")).toBe("/app/items/wi_1");
    expect(built.queryByRole("button", { name: /Build this/ })).toBeNull();
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

  describe("the Done tab (design 02-tasks, Done view)", () => {
    /** A done row, done at the local time `y-m-d h:min`. */
    const doneRow = (id: string, at: [number, number, number, number, number], over: Partial<TaskRow> = {}): DoneRow => ({
      ...row(id, over), done_at: new Date(at[0], at[1] - 1, at[2], at[3], at[4]).toISOString(),
    });
    const FIRST = "/api/v1/tasks/done";
    const doneCard = (id: string) => document.querySelector<HTMLElement>(`[data-done="${id}"]`);
    const doneIds = () => [...document.querySelectorAll<HTMLElement>("[data-done]")].map((e) => e.dataset.done);
    const openDone = async () => {
      await show();
      tab("Done");
    };

    it("lists every list's done tasks in one list, in the server's order, each with its list label and done date and time", async () => {
      donePages[FIRST] = {
        tasks: [doneRow("tk_b", [2026, 11, 13, 9, 5], { list: "home" }), doneRow("tk_a", [2026, 11, 2, 18, 30])],
        older: false, next_before: "2026-11-02T00:00:00.000Z",
      };
      await openDone();
      await waitFor(() => expect(doneIds()).toEqual(["tk_b", "tk_a"]), SLOW);
      expect(screen.getAllByRole("list")).toHaveLength(1);
      expect(doneCard("tk_b")!.textContent).toContain("done 2026-11-13 09:05");
      expect(doneCard("tk_b")!.textContent).toContain("#home");
      expect(doneCard("tk_a")!.textContent).toContain("done 2026-11-02 18:30");
      expect(doneCard("tk_a")!.textContent).toContain("No list");
      expect(within(doneCard("tk_a")!).queryByRole("checkbox")).toBeNull();
      expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
    });

    it("Show older reads the 30 days before the oldest row shown and adds them below; it hides when none is older", async () => {
      const cursor = "2026-10-20T08:00:00.000Z";
      donePages[FIRST] = { tasks: [doneRow("tk_new", [2026, 11, 10, 8, 0])], older: true, next_before: cursor };
      donePages[`${FIRST}?before=${encodeURIComponent(cursor)}`] = { tasks: [doneRow("tk_old", [2026, 10, 1, 8, 0])], older: false, next_before: "2026-10-01T00:00:00.000Z" };
      await openDone();
      fireEvent.click(await screen.findByRole("button", { name: "Show older" }, SLOW));
      await waitFor(() => expect(doneIds()).toEqual(["tk_new", "tk_old"]), SLOW);
      expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toContain(`${FIRST}?before=${encodeURIComponent(cursor)}`);
      expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
    });

    it("Reopen posts { id } to the reopen route with the token; the row leaves Done and the open views reload", async () => {
      donePages[FIRST] = { tasks: [doneRow("tk_a", [2026, 11, 13, 9, 0])], older: false, next_before: "2026-11-13T00:00:00.000Z" };
      await openDone();
      const opens = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/v1/tasks" && (init as RequestInit | undefined)?.method !== "POST").length;
      const before = opens();
      answer = { status: 200, body: { task_id: "tk_a", reopened: true, removed_next: null } };
      donePages[FIRST] = { tasks: [], older: false, next_before: "2026-10-15T00:00:00.000Z" };
      fireEvent.click(await screen.findByRole("button", { name: "Reopen: tk_a" }, SLOW));
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]!.url).toBe("/api/v1/tasks/reopen");
      expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
      expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ id: "tk_a" });
      await waitFor(() => expect(doneCard("tk_a")).toBeNull(), SLOW);
      expect(opens()).toBeGreaterThan(before);
      expect(screen.getByText("No task done in the last 30 days.")).toBeTruthy();
    });

    it("a refused reopen (its next occurrence is done) shows its reason above the Done list, and the row stays", async () => {
      donePages[FIRST] = { tasks: [doneRow("tk_r", [2026, 11, 13, 9, 0], { recurrence: "week" })], older: false, next_before: "2026-11-13T00:00:00.000Z" };
      await openDone();
      answer = { status: 409, body: { error: "its next occurrence is done: undo that one first" } };
      fireEvent.click(await screen.findByRole("button", { name: "Reopen: tk_r" }, SLOW));
      const alert = await screen.findByRole("alert", undefined, SLOW);
      expect(alert.textContent).toBe("its next occurrence is done: undo that one first");
      const list = screen.getByRole("list", { name: "Done" });
      expect(alert.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(doneCard("tk_r")).not.toBeNull();
    });

    it("a task completed with its checkbox shows in Done once the route answers, with no page reload", async () => {
      await openDone();
      await screen.findByText("No task done in the last 30 days.", {}, SLOW);
      tab("Today");
      answer = { status: 200, body: { task_id: "tk_now", completed: true, next_id: null } };
      donePages[FIRST] = { tasks: [doneRow("tk_now", [2026, 11, 12, 9, 10])], older: false, next_before: "2026-11-12T00:00:00.000Z" };
      fireEvent.click(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" }));
      await waitFor(() => expect(posts).toHaveLength(1));
      tab("Done");
      await waitFor(() => expect(doneIds()).toEqual(["tk_now"]), SLOW);
    });

    it("with no commands actor a done row has no Reopen button", async () => {
      current = view({ can_build: false });
      donePages[FIRST] = { tasks: [doneRow("tk_a", [2026, 11, 13, 9, 0])], older: false, next_before: "2026-11-13T00:00:00.000Z" };
      await openDone();
      await waitFor(() => expect(doneIds()).toEqual(["tk_a"]), SLOW);
      expect(screen.queryByRole("button", { name: /Reopen/ })).toBeNull();
    });
  });

  it("with no commands actor there is no Build this button", async () => {
    current = view({ can_build: false });
    await show();
    expect(screen.queryByRole("button", { name: /Build this/ })).toBeNull();
  });

  describe("calendar events (design 02-tasks, calendar views)", () => {
    const ev = (id: string, time: string | null, source = "google-calendar"): EventRow => ({ kind: "event", source, id, title: `event ${id}`, all_day: time === null, time });
    /** Every task and event card in the page, in document order. */
    const entries = () => [...document.querySelectorAll<HTMLElement>("[data-task], [data-event]")].map((e) => e.dataset.task ?? `event:${e.dataset.event}`);

    it("Today shows the all-day events at the top, then the timed tasks and events in time order, then the untimed tasks", async () => {
      current = view({
        today: {
          overdue: [],
          due: [
            ev("holiday", null),
            ev("standup", "09:30"),
            row("tk_call", { due_date: "2026-11-12", due_time: "11:00" }),
            ev("lunch", "12:00"),
            row("tk_untimed", { due_date: "2026-11-12" }),
          ],
        },
      });
      render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(TasksPage)));
      await screen.findByRole("list", { name: /^Today/ }, SLOW);
      expect(entries()).toEqual(["event:google-calendar:holiday", "event:google-calendar:standup", "tk_call", "event:google-calendar:lunch", "tk_untimed"]);
      const holiday = document.querySelector<HTMLElement>('[data-event="google-calendar:holiday"]')!;
      expect(holiday.textContent).toContain("event holiday");
      expect(holiday.textContent).toContain("all day");
      expect(document.querySelector('[data-event="google-calendar:standup"]')!.textContent).toContain("09:30");
      // An event is read-only: no Build this, no edit.
      expect(within(holiday).queryByRole("button")).toBeNull();
    });

    it("Upcoming shows each day's calendar events next to its tasks", async () => {
      current = view({
        upcoming: [
          { date: "2026-11-13", tasks: [ev("dentist", "08:00"), row("tk_soon", { due_date: "2026-11-13", due_time: "10:00" })] },
          { date: "2026-11-14", tasks: [ev("trip", null)] },
        ],
      });
      await show();
      tab("Upcoming");
      expect(entries()).toEqual(["event:google-calendar:dentist", "tk_soon", "event:google-calendar:trip"]);
      const lists = screen.getAllByRole("list");
      expect(lists).toHaveLength(2);
      expect(within(lists[0]!).getByText("event dentist")).toBeTruthy();
      expect(lists[0]!.querySelector('[data-task="tk_soon"]')).not.toBeNull();
      expect(lists[1]!.textContent).toContain("all day");
    });

    it("a source whose last sync failed is named above Today and Upcoming, with its stored events still shown", async () => {
      current = view({ today: { overdue: [], due: [ev("standup", "09:30")] }, calendar: [{ source: "google-calendar", synced_at: null, failed: true }] });
      render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(TasksPage)));
      expect((await screen.findByText(/google-calendar: showing the stored events/, undefined, SLOW)).closest("[data-calendar-stale]")).not.toBeNull();
      expect(entries()).toEqual(["event:google-calendar:standup"]);
    });
  });

  describe("today's timeline (design 02-tasks, schedule a task)", () => {
    const slot = (time: string) => document.querySelector<HTMLElement>(`[data-slot="${time}"]`)!;
    const block = (id: string) => document.querySelector<HTMLElement>(`[data-block="${id}"]`)!;
    /** A drag carrying `id`, as a task row's drag start sets it. */
    const carrying = (id: string) => ({ dataTransfer: { getData: (type: string) => (type === "text/plain" ? id : ""), setData: () => {} } });

    it("dragging a task onto a slot posts its ID with today's date and the slot's time", async () => {
      await show();
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

    it("an inbox task is dragged onto the timeline from the Inbox tab; a refusal shows above the timeline", async () => {
      await show();
      tab("Inbox");
      answer = { status: 409, body: { error: "the task is done: a done task cannot be scheduled" } };
      fireEvent.drop(slot("09:00"), carrying("tk_inbox"));
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ id: "tk_inbox", date: "2026-11-12", time: "09:00" });
      expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toBe("the task is done: a done task cannot be scheduled");
    });

    it("draws a timed task with no stored duration as 30 minutes and a stored duration as its length; an event is read-only", async () => {
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
      expect(card("tk_call").textContent).toContain("30 min");
      expect(card("tk_gym").textContent).toContain("90 min");
      // A slot is 1.5rem per 30 minutes: 15:00 is 45rem down, 30 minutes 1.5rem high; 90 minutes 4.5rem.
      expect([block("tk_call").style.top, block("tk_call").style.height]).toEqual(["45rem", "1.5rem"]);
      expect(block("tk_call").textContent).toContain("15:00–15:30");
      expect(block("tk_gym").style.height).toBe("4.5rem");
      expect(block("tk_gym").textContent).toContain("18:00–19:30");
      expect(block("work:ev1").textContent).toContain("standup");
      expect(block("work:ev1").getAttribute("draggable")).toBeNull();
      expect(within(screen.getByRole("list", { name: "Scheduled today" })).queryByRole("button")).toBeNull();
    });

    it("with no commands actor a row is not draggable and a drop posts nothing", async () => {
      current = view({ can_build: false });
      await show();
      expect(card("tk_late").getAttribute("draggable")).toBe("false");
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
      answer = { status: 400, body: { error: "no title" } };
      type("p1");
      enter();
      expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toBe("no title");
      expect(field().value).toBe("p1");
      expect(document.querySelectorAll("[data-task]")).toHaveLength(2);
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

    it("the view switcher has no bottom margin, and the section shows the count only, named by the tab", async () => {
      await show();
      expect(screen.getByRole("group", { name: "Task view" }).className.split(" ")).not.toContain("mb-6");
      const section = screen.getByRole("region", { name: "Today" });
      expect(section.querySelector("h2")).toBeNull();
      expect(section.querySelector("span.tabular-nums")!.textContent).toBe("2");
      tab("Inbox");
      expect(screen.getByRole("region", { name: "Inbox" })).not.toBeNull();
    });

    it("every empty tab shows its message as the title and Add one above (press q), which focuses the quick-add field", async () => {
      current = view({ inbox: [], today: { overdue: [], due: [] }, upcoming: [], projects: [] });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
      const titles: Record<string, string> = {
        Inbox: "No open task without a due date.",
        Today: "Nothing is due, overdue or on the calendar today.",
        Upcoming: "Nothing is due or on the calendar from today through the next 7 days.",
        List: "No open task.",
      };
      for (const [name, title] of Object.entries(titles)) {
        tab(name);
        await screen.findByText(title, {}, SLOW);
        const action = screen.getByRole("button", { name: "Add one above (press q)" });
        (document.activeElement as HTMLElement).blur();
        fireEvent.click(action);
        expect(document.activeElement).toBe(screen.getByLabelText("Add a task"));
      }
    });

    it("shows the Build line only when the tab lists a task and can_build is true", async () => {
      await show();
      expect(document.body.textContent).toContain(BUILD);
      cleanup();
      current = view({ can_build: false });
      await show();
      expect(document.body.textContent).not.toContain(BUILD);
      cleanup();
      current = view({ today: { overdue: [], due: [ev("e1")] } });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
      await screen.findByText("event e1", {}, SLOW);
      expect(document.body.textContent).not.toContain(BUILD);
    });

    it("hides the Build line while loading and on an empty tab", async () => {
      current = view({ inbox: [] });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
      expect(document.body.textContent).not.toContain(BUILD);
      await screen.findByRole("list", { name: "Overdue" }, SLOW);
      expect(document.body.textContent).toContain(BUILD);
      tab("Inbox");
      expect(screen.getByRole("button", { name: "Add one above (press q)" })).not.toBeNull();
      expect(document.body.textContent).not.toContain(BUILD);
    });

    it("the overdue and event labels are StatusBadges", async () => {
      current = view({ today: { overdue: [row("tk_late", { due_date: "2026-11-10" })], due: [ev("e1")] } });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
      await screen.findByRole("list", { name: "Overdue" }, SLOW);
      const overdue = within(card("tk_late")).getByText("Overdue");
      expect(overdue.className).toContain("rounded-pill");
      expect(overdue.getAttribute("data-level")).toBe("stuck");
      const event = within(document.querySelector<HTMLElement>("[data-event]")!).getByText("Event");
      expect(event.className).toContain("rounded-pill");
    });
  });

  describe("task projects (design 09-dashboard-app, project switcher and dialog)", () => {
    const PROJECTS = [{ slug: "home", name: "Home" }, { slug: "garden", name: "Garden" }];
    const switcher = () => screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement;
    const reads = () => vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter((u) => u.startsWith("/api/v1/tasks"));
    const homeOnly = () =>
      view({
        inbox: [row("tk_inbox", { projects: ["home"] })],
        today: { overdue: [], due: [row("tk_now", { due_date: "2026-11-12", projects: ["home"] })] },
        upcoming: [],
        projects: [{ list: null, tasks: [row("tk_inbox", { projects: ["home"] }), row("tk_now", { due_date: "2026-11-12", projects: ["home"] })] }],
        active_projects: PROJECTS,
      });

    it("the switcher lists All projects first, then the active projects, and reads its value from ?project= on load", async () => {
      current = view({ active_projects: PROJECTS });
      filtered = { home: homeOnly() };
      history.replaceState(null, "", "/app/tasks?project=home");
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
      await waitFor(() => expect(document.querySelector('[data-task="tk_now"]')).not.toBeNull(), SLOW);
      expect([...switcher().options].map((o) => o.textContent)).toEqual(["All projects", "Home", "Garden"]);
      expect(switcher().value).toBe("home");
      expect(reads()).toContain("/api/v1/tasks?project=home");
      expect(reads()).not.toContain("/api/v1/tasks");
    });

    it("choosing a project sets ?project= and filters Inbox, Today, Upcoming and List; All projects clears it; Done is not filtered", async () => {
      current = view({ active_projects: PROJECTS });
      filtered = { home: homeOnly() };
      await show();
      expect(switcher().value).toBe("");
      fireEvent.change(switcher(), { target: { value: "home" } });
      expect(new URLSearchParams(location.search).get("project")).toBe("home");
      expect(location.pathname).toBe("/app/tasks");
      await waitFor(() => expect([...document.querySelectorAll<HTMLElement>("[data-task]")].map((e) => e.dataset.task)).toEqual(["tk_now"]), SLOW);
      tab("Inbox");
      expect(screen.getByRole("list", { name: "Inbox" }).textContent).toContain("tk_inbox");
      tab("Upcoming");
      expect(document.querySelectorAll("[data-task]")).toHaveLength(0);
      tab("List");
      expect([...document.querySelectorAll<HTMLElement>("[data-task]")].map((e) => e.dataset.task)).toEqual(["tk_inbox", "tk_now"]);
      tab("Done");
      await waitFor(() => expect(reads()).toContain("/api/v1/tasks/done"), SLOW);
      expect(reads().filter((u) => u.startsWith("/api/v1/tasks/done")).every((u) => !u.includes("project"))).toBe(true);
      fireEvent.change(switcher(), { target: { value: "" } });
      expect(location.search).toBe("");
      tab("Today");
      expect(await screen.findByRole("list", { name: "Overdue" }, SLOW)).toBeTruthy();
    });

    it("Projects… opens the project dialog outside the row; a checkbox adds or removes the task's link", async () => {
      current = view({ inbox: [row("tk_inbox", { projects: ["home"] })], active_projects: PROJECTS });
      answer = { status: 200, body: { task_id: "tk_inbox", project: "garden", changed: true } };
      await show();
      tab("Inbox");
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
      current = view({ inbox: [row("tk_inbox")], active_projects: [] });
      await show();
      tab("Inbox");
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

    it("a done row has no Projects… item", async () => {
      donePages = { "/api/v1/tasks/done": { tasks: [{ ...row("tk_old"), done_at: "2026-11-11T10:00:00.000Z" }], older: false, next_before: "2026-10-12T00:00:00.000Z" } };
      await show();
      tab("Done");
      const done = await screen.findByText("tk_old", {}, SLOW);
      const li = done.closest("[data-done]")!;
      expect(within(li as HTMLElement).queryByRole("button", { name: /More actions/ })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Projects…" })).toBeNull();
    });
  });

  describe("Factory work", () => {
    it("lists a work item that needs the owner above the tabs, in a Needs-you group", async () => {
      items = [item("wi_1", { title: "Approve the spec", level: "needs_approval" }), item("wi_run", { title: "Busy", level: "running" })];
      await show();
      const section = (await screen.findByRole("heading", { name: /Factory work/ }, SLOW)).closest("section")!;
      expect(within(section).getByText("Approve the spec")).toBeTruthy();
      expect(within(section).getByText("Approve")).toBeTruthy();
      expect(within(section).queryByText("Busy")).toBeNull();
      const tabs = screen.getByRole("group", { name: "Task view" });
      expect(section.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("a built task shows its work item's state", async () => {
      items = [item("wi_1", { level: "ready_to_merge" })];
      await show();
      tab("List");
      expect(await within(card("tk_built")).findByText("Ready to merge", {}, SLOW)).toBeTruthy();
    });

    it("a merged item reads Merged, and the state opens a dialog with the full-page link", async () => {
      items = [item("wi_1", { level: "closed", close_reason: "completed", stage: "CLOSED" })];
      await show();
      tab("List");
      expect(await within(card("tk_built")).findByText("Merged", {}, SLOW)).toBeTruthy();
      fireEvent.click(within(card("tk_built")).getByRole("button", { name: "Work item state: tk_built" }));
      const dialog = document.querySelector<HTMLElement>("[data-dialog]")!;
      expect(within(dialog).getByRole("link", { name: "Open the full item page" }).getAttribute("href")).toBe("/app/items/wi_1");
    });

    it("a checkbox still completes a task with the section on the page", async () => {
      items = [item("wi_1")];
      await show();
      fireEvent.click(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" }));
      await waitFor(() => expect(posts.some((p) => p.url.includes("done"))).toBe(true), SLOW);
    });
  });
});
