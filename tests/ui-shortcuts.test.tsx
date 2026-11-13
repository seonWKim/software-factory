// @vitest-environment jsdom
// @ts-nocheck -- same reason as tests/data-page.test.tsx: tsconfig.test.json has no DOM and no JSX.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { GO_KEYS } from "../web/src/keys.js";

// The app's keyboard shortcuts (design §9): ⌘K search, g-keys, j/k/Enter on rows and ? for the list; none of them
// fires while focus is in a field.

const AT = "2026-11-07T00:00:00.000Z";
const row = (id: string, title: string, level: string) => ({
  id, title, level, since: AT, badges: [], source: { id: `local:${id}`, type: "local", link: "" }, change_ref: null, change_url: null, issue: null, why: null, need: null, commands: [], merge: null, stage: "SPEC", blocked_reason: null,
});
const RESPONSES: Record<string, unknown> = {
  "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 2, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, factory: null, system_actions: [] },
  "/api/v1/items": { as_of: AT, total: 2, items: [row("wi_1", "First spec", "needs_approval"), row("wi_2", "Second spec", "needs_approval")], facets: { state: {}, allStates: 2 } },
  "/api/v1/pauses": { as_of: AT, csrf_token: null, pauses: [] },
  "/api/v1/runs": { as_of: AT, runs: [] },
  "/api/v1/queue": { as_of: AT, queue: [] },
};

beforeEach(() => {
  history.replaceState(null, "", "/app/");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = RESPONSES[url.split("?")[0]!];
    return body === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <App />
      <input aria-label="field" />
      <textarea aria-label="area" />
      <select aria-label="pick"><option>a</option></select>
      <div aria-label="edit" contentEditable suppressContentEditableWarning tabIndex={0} />
    </QueryClientProvider>,
  );
}
const fields = () => [screen.getByLabelText("field"), screen.getByLabelText("area"), screen.getByLabelText("pick"), screen.getByLabelText("edit")];
const press = (key: string, init: KeyboardEventInit = {}, target: Element | Document = document.body) => fireEvent.keyDown(target, { key, ...init });

describe("shortcuts", () => {
  it("g n, g w and g a go to Needs you, Work and Activity; g i, g t and g u do nothing yet", async () => {
    mount();
    press("g");
    press("w");
    expect(location.pathname).toBe("/app/items");
    press("g");
    press("a");
    expect(location.pathname).toBe("/app/activity");
    press("g");
    press("n");
    expect(location.pathname).toBe("/app/");
    press("g");
    press("w");
    for (const k of ["i", "t", "u"]) {
      press("g");
      press(k);
      expect(location.pathname).toBe("/app/items");
    }
    expect(Object.keys(GO_KEYS)).not.toContain("i");
    press("q");
    expect(location.pathname).toBe("/app/items");
  });

  it("⌘K opens the search of pages and loaded items; choosing one goes there; Escape closes", async () => {
    mount();
    await screen.findByText("First spec");
    press("k", { metaKey: true });
    const box = await screen.findByRole("dialog", { name: "Search" });
    expect(box.textContent).toContain("Runners");
    expect(box.textContent).toContain("Second spec");
    fireEvent.change(screen.getByPlaceholderText("Search pages and items"), { target: { value: "second" } });
    fireEvent.click(screen.getByRole("option", { name: /Second spec/ }).querySelector("button")!);
    expect(location.pathname).toBe("/app/items/wi_2");
    expect(screen.queryByRole("dialog")).toBeNull();
    press("k", { metaKey: true });
    fireEvent.keyDown(screen.getByPlaceholderText("Search pages and items"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("? lists every shortcut, Escape closes it", () => {
    mount();
    press("?");
    const box = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(box.textContent).toContain("g a");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("j and k move the selected row, Enter opens it", async () => {
    mount();
    await screen.findByText("First spec");
    const rows = () => [...document.querySelectorAll("main [data-key]")];
    press("j");
    expect(rows().map((r) => r.getAttribute("data-selected"))).toEqual(["true", null]);
    press("j");
    expect(rows().map((r) => r.getAttribute("data-selected"))).toEqual([null, "true"]);
    press("k");
    expect(rows().map((r) => r.getAttribute("data-selected"))).toEqual(["true", null]);
    press("Enter");
    expect(location.pathname).toBe("/app/items/wi_1");
  });

  describe("none fires inside a field", () => {
    it("⌘K, ?, g-keys, j, k and Enter do nothing", async () => {
      mount();
      await screen.findByText("First spec");
      for (const f of fields()) {
        press("k", { metaKey: true }, f);
        press("?", {}, f);
        press("g", {}, f);
        press("w", {}, f);
        press("j", {}, f);
        press("k", {}, f);
        press("Enter", {}, f);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(location.pathname).toBe("/app/");
        expect(document.querySelector("[data-selected]")).toBeNull();
      }
    });
  });

  it("q focuses the Tasks page's quick-add field when no field has focus, and does nothing elsewhere or in a field", async () => {
    RESPONSES["/api/v1/tasks"] = { today_date: "2026-11-12", inbox: [], today: { overdue: [], due: [] }, upcoming: [], projects: [], csrf_token: "t", can_build: true };
    mount();
    press("q");
    expect(document.activeElement).toBe(document.body);
    history.pushState(null, "", "/app/tasks");
    dispatchEvent(new PopStateEvent("popstate"));
    const quick = await screen.findByPlaceholderText("e.g. rent friday p1 #home");
    const other = screen.getByLabelText("field");
    other.focus();
    press("q", {}, other);
    expect(document.activeElement).toBe(other);
    (document.activeElement as HTMLElement).blur();
    press("q");
    expect(document.activeElement).toBe(quick);
    delete RESPONSES["/api/v1/tasks"];
  });

  it("⌘Z on the Tasks page reopens the last task completed there; in a field it keeps the browser's own undo", async () => {
    RESPONSES["/api/v1/tasks"] = {
      today_date: "2026-11-12", inbox: [{ id: "tk_a", title: "pay rent", list: null, priority: null, due_date: null, due_time: null, recurrence: null, work_item_id: null }],
      today: { overdue: [], due: [] }, upcoming: [], projects: [], csrf_token: "t", can_build: true,
    };
    RESPONSES["/api/v1/tasks/done"] = { task_id: "tk_a", completed: true, next_id: null };
    RESPONSES["/api/v1/tasks/reopen"] = { task_id: "tk_a", reopened: true, removed_next: null };
    const reopens = () => vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/v1/tasks/reopen");
    history.pushState(null, "", "/app/tasks");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Inbox" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Complete: pay rent" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/v1/tasks/done")).toBe(true));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Complete: pay rent" }).hasAttribute("disabled")).toBe(false));
    for (const f of fields()) {
      expect(press("z", { metaKey: true }, f)).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(reopens()).toHaveLength(0);
    expect(press("z", { metaKey: true })).toBe(false);
    await waitFor(() => expect(reopens()).toHaveLength(1));
    expect(JSON.parse(String((reopens()[0]![1] as RequestInit).body))).toEqual({ id: "tk_a" });
    for (const k of ["/api/v1/tasks", "/api/v1/tasks/done", "/api/v1/tasks/reopen"]) delete RESPONSES[k];
  });

  it("lists ⌘Z in the shortcuts help", async () => {
    mount();
    press("?");
    const box = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(box.textContent).toContain("⌘Z");
    expect(box.textContent).toContain("Undo the last task completed on this page");
  });

  it("lists q in the shortcuts help", async () => {
    mount();
    press("?");
    expect(await screen.findByText("Add a task")).toBeTruthy();
  });
});
