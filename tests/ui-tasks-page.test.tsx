// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRow, TaskRow, TasksView } from "../web/src/api.js";
import { PAGES, routeFor } from "../web/src/pages.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-rules-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/tasks.js";
const { TasksPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { TasksPage: FunctionComponent };

// The Tasks page (design 02-tasks, issue #607): Inbox, Today (overdue first, in red), Upcoming (by day) and Project
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
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let current: TasksView;
let posts: { url: string; init: RequestInit }[];
let answer: { status: number; body: unknown };

beforeEach(() => {
  current = view();
  posts = [];
  answer = { status: 200, body: { task_id: "tk_now", work_item_id: "wi_9", created: true } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
      return json(answer.status, answer.body);
    }
    if (url === "/api/v1/tasks") return json(200, current);
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
    expect([...group.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Inbox", "Today", "Upcoming", "Project"]);
    expect(group.className.split(" ")).toContain("flex-nowrap");
    expect(group.className.split(" ")).not.toContain("flex-wrap");
    const selected = () => [...group.querySelectorAll("button[aria-pressed=true]")].map((b) => b.textContent);
    expect(selected()).toEqual(["Today"]);
    tab("Project");
    expect(selected()).toEqual(["Project"]);
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

  it("Inbox, Upcoming and Project show their own tasks; a built task links to its work item instead of Build this", async () => {
    await show();
    tab("Inbox");
    expect(screen.getByRole("list", { name: "Inbox" }).textContent).toContain("tk_inbox");
    tab("Upcoming");
    expect(card("tk_soon").textContent).toContain("#home");
    expect(document.querySelectorAll("[data-task]")).toHaveLength(1);
    tab("Project");
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
    const field = () => screen.getByPlaceholderText("Add a task, e.g. pay rent friday p1 #home") as HTMLInputElement;
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

    it("no longer hints at factory task add, and keeps the Build this line", async () => {
      await show();
      expect(document.body.textContent).not.toContain("factory task add");
      expect(document.body.textContent).toContain("Build this sends a task to the factory.");
    });
  });
});
