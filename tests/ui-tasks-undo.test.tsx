// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLOW, TOKEN, card, reset, s, show, teardown, view } from "./ui-tasks-fixtures.js";

beforeEach(reset);
afterEach(teardown);

// ⌘Z undoes this page's completions (design 02-tasks, undo a completion).

describe("⌘Z undoes this page's completions (design 02-tasks, undo a completion)", () => {
  const undo = (init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key: "z", metaKey: true, ...init });
  const gets = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/v1/tasks" && (init as RequestInit | undefined)?.method !== "POST").length;

  it("reopens the task the checkbox completed, then reloads the list so it shows open again", async () => {
    await show();
    const today = s.current.today;
    s.answer = { status: 200, body: { task_id: "tk_now", completed: true, next_id: null } };
    s.current = view({ today: { ...today, due: [] } });
    fireEvent.click(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" }));
    await waitFor(() => expect(document.querySelector('[data-task="tk_now"]')).toBeNull(), SLOW);
    s.answer = { status: 200, body: { task_id: "tk_now", reopened: true, removed_next: null } };
    s.current = view();
    const before = gets();
    undo();
    await waitFor(() => expect(s.posts).toHaveLength(2));
    expect(s.posts[1]!.url).toBe("/api/v1/tasks/reopen");
    expect(new Headers(s.posts[1]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(JSON.parse(String(s.posts[1]!.init.body))).toEqual({ id: "tk_now" });
    await waitFor(() => expect(gets()).toBeGreaterThan(before));
    expect(await screen.findByRole("checkbox", { name: "Complete: tk_now" }, SLOW)).toBeTruthy();
    // That completion is undone: a second ⌘Z has nothing left and sends nothing.
    undo();
    await new Promise((r) => setTimeout(r, 20));
    expect(s.posts).toHaveLength(2);
  });

  it("with nothing completed on this page it does nothing and sends no request; Ctrl, Alt or Shift is no undo", async () => {
    await show();
    undo();
    fireEvent.click(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" }));
    await waitFor(() => expect(s.posts).toHaveLength(1));
    for (const init of [{ metaKey: false, ctrlKey: true }, { altKey: true }, { shiftKey: true }]) undo(init);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.posts.map((p) => p.url)).toEqual(["/api/v1/tasks/done"]);
  });

  it("a refusal shows its reason", async () => {
    await show();
    fireEvent.click(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" }));
    await waitFor(() => expect(s.posts).toHaveLength(1));
    s.answer = { status: 409, body: { error: "its next occurrence is done: undo that one first" } };
    undo();
    expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toBe("its next occurrence is done: undo that one first");
  });
});
