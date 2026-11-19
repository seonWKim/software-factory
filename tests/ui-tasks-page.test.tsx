// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventRow } from "../web/src/api.js";
import { PAGES, routeFor } from "../web/src/pages.js";
import { SLOW, TOKEN, TasksPage, card, item, reset, row, s, show, show2, teardown, view } from "./ui-tasks-fixtures.js";

// dayLabel lives in the groups module; the specifier is one the node type check skips (the page module is loaded the same way).
const GROUPS_MODULE = "../web/src/views/tasks/groups.js";
const { dayLabel } = (await import(/* @vite-ignore */ GROUPS_MODULE)) as { dayLabel: (date: string) => string };

beforeEach(reset);
afterEach(teardown);
// The Tasks page core (design 02-tasks-page, 02-tasks): every task over GET /api/v1/tasks in the groups overdue (in red), today,
// later days by date and no date, paged 20 to a page; Build this posts the task's ID once, a built task links to its item;
// calendar events and a timeline are gone. The other topics are in tests/ui-tasks-*.test.tsx; the shared stub is in tests/ui-tasks-fixtures.ts.

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
    s.current = view({
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
      s.current = view({ today: { overdue: [], due: [row("tk_now", { due_date: "2026-11-12" })] }, projects: [{ list: null, tasks: many(25) }] });
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
      s.current = view({ today: { overdue: [], due: [] }, projects: [{ list: null, tasks: many(25) }] });
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
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(s.posts[0]!.url).toBe("/api/v1/tasks/build");
    expect(new Headers(s.posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(JSON.parse(String(s.posts[0]!.init.body))).toEqual({ id: "tk_now" });
    s.answer = { status: 409, body: { error: "no project is stored yet" } };
    fireEvent.click(within(card("tk_late")).getByRole("button", { name: "Build this: tk_late" }));
    expect((await within(card("tk_late")).findByRole("alert", undefined, SLOW)).textContent).toBe("no project is stored yet");
  });

  it("with no commands actor there is no Build this button", async () => {
    s.current = view({ can_build: false });
    await show();
    expect(screen.queryByRole("button", { name: /Build this/ })).toBeNull();
  });

  describe("calendar events leave the Tasks list (design 02-tasks)", () => {
    const ev = (id: string, time: string | null): EventRow => ({ kind: "event", source: "google-calendar", id, title: `event ${id}`, all_day: time === null, time });

    it("the list shows no event row and no stale-sync notice", async () => {
      s.current = view({
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

  describe("no timeline (design 02-tasks)", () => {
    it("shows no timeline control or slots, and no row is draggable", async () => {
      await show();
      expect(screen.queryByRole("button", { name: /timeline/i })).toBeNull();
      expect(document.querySelector("[data-slot], [data-block]")).toBeNull();
      expect(document.querySelectorAll("[data-task]").length).toBeGreaterThan(0);
      for (const r of document.querySelectorAll("[data-task]")) expect(r.hasAttribute("draggable")).toBe(false);
    });

    it("a timed row still shows its duration: 30 minutes when none is stored, else the stored one", async () => {
      s.current = view({
        today: { overdue: [], due: [row("tk_call", { due_date: "2026-11-12", due_time: "15:00" }), row("tk_gym", { due_date: "2026-11-12", due_time: "18:00", duration_minutes: 90 })] },
      });
      await show2();
      expect(card("tk_call").textContent).toContain("30 min");
      expect(card("tk_gym").textContent).toContain("90 min");
    });
  });

  describe("polish (UI review)", () => {
    const BUILD = "Build this sends a task to the factory.";
    const ev = (id: string): EventRow => ({ kind: "event", source: "google-calendar", id, title: `event ${id}`, all_day: true, time: null });

    it("the page stacks the project tabs, Quick add, Needs you, then the list, with no mb-/mt- on Quick add or Needs you", async () => {
      s.items = [item("wi_x", { title: "Approve the spec", item_phase: "needs_approval" })];
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
      // The Card's title row (its count) is a span straight under one of its divs.
      expect([...view.querySelectorAll(":scope > div > span")].map((x) => x.textContent)).not.toContainEqual(expect.stringMatching(/^\d+$/));
    });

    it("an empty list shows its message only, saying to add a task in the field above, with no button", async () => {
      s.current = view({ today: { overdue: [], due: [] }, upcoming: [], projects: [] });
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
      s.current = view({ can_build: false });
      await show();
      expect(document.body.textContent).not.toContain(BUILD);
      cleanup();
      s.current = view({ today: { overdue: [], due: [ev("e1")] }, projects: [] });
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

    it("the overdue label is a Badge", async () => {
      s.current = view({ today: { overdue: [row("tk_late", { due_date: "2026-11-10" })], due: [] } });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
      await screen.findByRole("list", { name: "Overdue" }, SLOW);
      const overdue = within(card("tk_late")).getByText("Overdue");
      expect(overdue.className).toContain("rounded-pill");
      expect(overdue.getAttribute("data-level")).toBe("stuck");
    });
  });
});

describe("the description dialog (design 02-tasks and 09-dashboard-tasks)", () => {
  const open = (id: string) => fireEvent.click(within(card(id)).getByRole("button", { name: `Description: ${id}` }));
  const dialog = () => document.querySelector<HTMLDialogElement>("dialog[data-dialog]");

  it("the title opens a dialog with the stored description in a textarea, outside the row, so the row keeps its children", async () => {
    s.current = view({ today: { overdue: [row("tk_late", { due_date: "2026-11-10", body: "the old notes" })], due: [] } });
    await show();
    const before = card("tk_late").innerHTML;
    open("tk_late");
    const d = dialog()!;
    expect(d).not.toBeNull();
    expect(card("tk_late").contains(d)).toBe(false);
    expect(card("tk_late").innerHTML).toBe(before);
    expect((within(d).getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value).toBe("the old notes");
    expect(within(d).getByRole("button", { name: "Save" })).toBeTruthy();
    expect(within(d).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(d.textContent).toContain("Build this sends the title and this description");
  });

  it("Save posts { id, body } with the token and closes the dialog", async () => {
    await show();
    open("tk_late");
    fireEvent.change(within(dialog()!).getByRole("textbox", { name: "Description" }), { target: { value: "call before noon" } });
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(s.posts[0]!.url).toBe("/api/v1/tasks/body");
    expect(new Headers(s.posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(JSON.parse(String(s.posts[0]!.init.body))).toEqual({ id: "tk_late", body: "call before noon" });
    await waitFor(() => expect(dialog()).toBeNull(), SLOW);
  });

  it("a refusal stays in the dialog with its reason", async () => {
    await show();
    s.answer = { status: 409, body: { error: "the task is done: a done task's description cannot be edited" } };
    open("tk_late");
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Save" }));
    expect((await within(dialog()!).findByRole("alert", undefined, SLOW)).textContent).toContain("a done task's description");
  });

  it("Cancel closes it and posts nothing", async () => {
    await show();
    open("tk_late");
    fireEvent.change(within(dialog()!).getByRole("textbox", { name: "Description" }), { target: { value: "not saved" } });
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Cancel" }));
    expect(dialog()).toBeNull();
    expect(s.posts).toEqual([]);
  });

  it("a built task's title opens the dialog too, which says the work item keeps the text it was built with; the ID still links", async () => {
    await show();
    expect(within(card("tk_built")).getByRole("link", { name: "wi_1" }).getAttribute("href")).toBe("/app/items/wi_1");
    open("tk_built");
    expect(dialog()!.textContent).toContain("Built as wi_1: the work item keeps the text it was built with");
  });

  it("with no commands actor the title opens nothing", async () => {
    s.current = view({ csrf_token: null, can_build: false });
    await show();
    expect(within(card("tk_late")).queryByRole("button", { name: "Description: tk_late" })).toBeNull();
  });
});
