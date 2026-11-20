// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRow } from "../web/src/api.js";
import { SLOW, TOKEN, card, chooseMenu, item, menuItems, reset, row, s, show, show2, teardown, view } from "./ui-tasks-fixtures.js";

beforeEach(reset);
afterEach(teardown);

// Done tasks stay in the Tasks list, struck through, with Reopen (design 02-tasks, done tasks stay).

describe("done tasks stay, struck through (design 02-tasks, done tasks stay)", () => {
  const AT = "2026-11-12T09:10:00.000Z";
  const done = (id: string, over: Partial<TaskRow> = {}): TaskRow => row(id, { done_at: AT, ...over });
  const title = (id: string) => within(card(id)).getByText(id, { selector: "p" });
  /** Today's tk_now as the server places it, done or open. */
  const withNow = (now: TaskRow) => view({ today: { overdue: view().today.overdue, due: [now] } });

  it("a task marked done from the list stays in it: its title struck through, Reopen in its menu and no checkbox", async () => {
    await show();
    s.answer = { status: 200, body: { task_id: "tk_now", completed: true, next_id: null } };
    s.current = withNow(done("tk_now", { due_date: "2026-11-12", due_time: "09:00" }));
    fireEvent.click(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" }));
    await waitFor(() => expect(card("tk_now").hasAttribute("data-done")).toBe(true), SLOW);
    expect(menuItems(card("tk_now"))).toEqual(["Reopen"]);
    expect(title("tk_now").className.split(" ")).toContain("line-through");
    expect(within(card("tk_now")).queryByRole("checkbox")).toBeNull();
    expect(card("tk_now").hasAttribute("data-done")).toBe(true);
    expect([...document.querySelectorAll<HTMLElement>("[data-task]")].map((e) => e.dataset.task).slice(0, 2)).toEqual(["tk_late", "tk_now"]);
  });

  it("a task whose factory work merged shows struck through, with its work item and Reopen, not removed", async () => {
    s.items = [item("wi_1", { item_phase: "closed", close_reason: "completed", stage: "CLOSED" })];
    s.current = view({ projects: [{ list: null, tasks: [done("tk_built", { work_item_id: "wi_1" }), row("tk_inbox")] }] });
    await show();
    expect(title("tk_built").className.split(" ")).toContain("line-through");
    // Its title links to the work item; the raw ID is not shown (design-system/writing.md).
    expect(within(card("tk_built")).getByRole("link", { name: "tk_built" }).getAttribute("href")).toBe("/app/items/wi_1");
    expect(card("tk_built").textContent).not.toContain("wi_1");
    expect(menuItems(card("tk_built"))).toEqual(["Reopen"]);
    expect(card("tk_built").textContent).toContain("Done 2026-11-12");
    expect(title("tk_inbox").className.split(" ")).not.toContain("line-through");
  });

  it("a task whose work item closed without a merge shows the item's close reason in the row's details, done or open", async () => {
    s.current = view({
      projects: [{
        list: null,
        tasks: [
          done("tk_closed", { work_item_id: "wi_c", close_reason: "completed" }), done("tk_merged", { work_item_id: "wi_m", close_reason: null }),
          done("tk_old", { work_item_id: "wi_o", close_reason: "rejected" }),
          row("tk_rejected", { work_item_id: "wi_r", close_reason: "rejected" }), row("tk_wont", { work_item_id: "wi_w", close_reason: "wont_do" }), row("tk_open"),
        ],
      }],
    });
    await show();
    // A rejected or wont_do close leaves the task open: not struck through, its checkbox still there, the reason beside it.
    expect(title("tk_rejected").className.split(" ")).not.toContain("line-through");
    expect(within(card("tk_rejected")).getByRole("checkbox", { name: "Complete: tk_rejected" })).toBeTruthy();
    expect(within(card("tk_rejected")).getByText("Rejected")).toBeTruthy();
    expect(within(card("tk_wont")).getByText("Not planned")).toBeTruthy();
    expect(within(card("tk_wont")).getByRole("checkbox", { name: "Complete: tk_wont" })).toBeTruthy();
    // A done task keeps its reason beside the done time (a task closed before 2026-11-19 by a rejected item).
    expect(within(card("tk_closed")).getByText("Closed")).toBeTruthy();
    expect(within(card("tk_old")).getByText("Rejected").parentElement).toBe(within(card("tk_old")).getByText("Done 2026-11-12", { exact: false }).parentElement);
    for (const id of ["tk_merged", "tk_open"]) for (const reason of ["Rejected", "Not planned", "Closed"]) expect(within(card(id)).queryByText(reason)).toBeNull();
  });

  it("Reopen posts { id } to the reopen route with the token; the row shows open again", async () => {
    s.current = withNow(done("tk_now", { due_date: "2026-11-12" }));
    await show();
    s.answer = { status: 200, body: { task_id: "tk_now", reopened: true, removed_next: null } };
    const reopened = withNow(row("tk_now", { due_date: "2026-11-12" }));
    chooseMenu(card("tk_now"), "Reopen");
    s.current = reopened;
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(s.posts[0]!.url).toBe("/api/v1/tasks/reopen");
    expect(new Headers(s.posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(JSON.parse(String(s.posts[0]!.init.body))).toEqual({ id: "tk_now" });
    await waitFor(() => expect(card("tk_now").hasAttribute("data-done")).toBe(false), SLOW);
    expect(menuItems(card("tk_now"))).not.toContain("Reopen");
    expect(title("tk_now").className.split(" ")).not.toContain("line-through");
    expect(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" })).toBeTruthy();
  });

  it("a done row's only control is its menu, holding only Reopen: no checkbox, Build this, edit, sub-task, projects or delete; and it is not styled overdue", async () => {
    // A done task the server still sent as overdue is listed under Done, so the page has no Overdue list to wait for.
    s.current = view({ today: { overdue: [done("tk_late", { due_date: "2026-11-10" })], due: [] } });
    await show2();
    const c = within(card("tk_late"));
    expect(c.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["More actions: tk_late"]);
    expect(menuItems(card("tk_late"))).toEqual(["Reopen"]);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(c.queryByRole("checkbox")).toBeNull();
    expect(card("tk_late").hasAttribute("data-overdue")).toBe(false);
    expect(title("tk_late").className).not.toContain("text-pill-bad-fg");
    expect(card("tk_late").textContent).not.toContain("Overdue");
    card("tk_late").focus();
    fireEvent.keyDown(card("tk_late"), { key: "e" });
    fireEvent.keyDown(card("tk_late"), { key: "Delete" });
    expect(card("tk_late").querySelector("form")).toBeNull();
    expect(document.querySelector("[data-dialog]")).toBeNull();
  });

  it("a done past-due task is under Done, after No date, struck through with its done time; never under Overdue", async () => {
    s.current = view({
      today: { overdue: [row("tk_late", { due_date: "2026-11-10" }), done("tk_sent", { due_date: "2026-11-09" })], due: [done("tk_now", { due_date: "2026-11-12" })] },
      projects: [{ list: null, tasks: [done("tk_past", { due_date: "2026-11-11" }), done("tk_soon", { due_date: "2026-11-13" }), row("tk_inbox")] }],
    });
    await show();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent).filter((h) => !h!.startsWith("Timeline"));
    expect(headings.slice(-2)).toEqual(["No date", "Done"]);
    const group = (name: string) => screen.getByRole("heading", { name }).parentElement!;
    const ids = (name: string) => [...group(name).querySelectorAll<HTMLElement>("[data-task]")].map((e) => e.dataset.task);
    expect(ids("Overdue")).toEqual(["tk_late"]);
    expect(ids("Done")).toEqual(expect.arrayContaining(["tk_past", "tk_sent"]));
    expect(ids("Done")).not.toContain("tk_now");
    expect(ids("Done")).not.toContain("tk_soon");
    expect(title("tk_past").className.split(" ")).toContain("line-through");
    expect(card("tk_past").textContent).toContain("Done 2026-11-12");
  });

  it("a refused reopen shows its reason in the row, and the row stays done", async () => {
    s.current = withNow(done("tk_now", { recurrence: "week" }));
    await show();
    s.answer = { status: 409, body: { error: "its next occurrence is done: undo that one first" } };
    chooseMenu(card("tk_now"), "Reopen");
    expect((await within(card("tk_now")).findByRole("alert", undefined, SLOW)).textContent).toBe("its next occurrence is done: undo that one first");
    expect(title("tk_now").className.split(" ")).toContain("line-through");
  });

  it("there is no Show done switch and no done list read", async () => {
    await show();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).startsWith("/api/v1/tasks/done") && (init as RequestInit | undefined)?.method !== "POST")).toBe(false);
  });

  it("with no commands actor a done row has no Reopen button", async () => {
    s.current = view({ can_build: false, projects: [{ list: null, tasks: [done("tk_a")] }] });
    await show();
    expect(title("tk_a").className.split(" ")).toContain("line-through");
    expect(screen.queryByRole("button", { name: /Reopen/ })).toBeNull();
  });
});
