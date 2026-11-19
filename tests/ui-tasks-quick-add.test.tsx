// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TasksView } from "../web/src/api.js";
import { SLOW, TOKEN, card, reset, row, s, show, show2, teardown, view } from "./ui-tasks-fixtures.js";

beforeEach(reset);
afterEach(teardown);

// Quick add and the submit key (design 02-tasks, quick add and tasks_add_key).

describe("quick add", () => {
  const field = () => screen.getByRole("textbox", { name: "Add a task" }) as HTMLInputElement;
  const type = (v: string) => fireEvent.change(field(), { target: { value: v } });
  const enter = () => fireEvent.submit(field().closest("form")!);

  it("Enter posts { id, words } with the token; the field clears, keeps focus and the new task shows", async () => {
    await show();
    s.answer = { status: 200, body: { id: "tk_new" } };
    type("pay rent friday p1 #home");
    s.current = view({ today: { overdue: [], due: [row("tk_rent", { title: "pay rent" })] } });
    enter();
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(s.posts[0]!.url).toBe("/api/v1/tasks");
    expect(new Headers(s.posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    const body = JSON.parse(String(s.posts[0]!.init.body));
    expect(body.words).toBe("pay rent friday p1 #home");
    expect(body.id).toMatch(/^tk_[A-Za-z0-9_-]{8,64}$/);
    await waitFor(() => expect(card("tk_rent")).not.toBeNull(), SLOW);
    await waitFor(() => expect(field().value).toBe(""));
    expect(document.activeElement).toBe(field());
  });

  it("on a project tab the POST carries the tab's project; on All projects it is { id, words }", async () => {
    await show();
    s.answer = { status: 200, body: { id: "tk_new" } };
    type("buy milk");
    enter();
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(Object.keys(JSON.parse(String(s.posts[0]!.init.body))).sort()).toEqual(["id", "words"]);
    cleanup();
    history.replaceState(null, "", "/app/tasks?project=home");
    s.current = view({ active_projects: [{ slug: "home", name: "Home" }] });
    s.filtered = { home: view({ active_projects: [{ slug: "home", name: "Home" }] }) };
    await show2();
    type("buy milk");
    enter();
    await waitFor(() => expect(s.posts).toHaveLength(2));
    expect(JSON.parse(String(s.posts[1]!.init.body))).toMatchObject({ words: "buy milk", project: "home" });
    history.replaceState(null, "", "/app/tasks");
  });

  it("a refusal shows its message beside the field, keeps the text and adds nothing; a retry sends the same id", async () => {
    await show();
    const before = document.querySelectorAll("[data-task]").length;
    s.answer = { status: 400, body: { error: "no title" } };
    type("p1");
    enter();
    expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toBe("no title");
    expect(field().value).toBe("p1");
    expect(document.querySelectorAll("[data-task]")).toHaveLength(before);
    enter();
    await waitFor(() => expect(s.posts).toHaveLength(2));
    expect(JSON.parse(String(s.posts[1]!.init.body)).id).toBe(JSON.parse(String(s.posts[0]!.init.body)).id);
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
    await waitFor(() => expect(s.posts).toHaveLength(1));
  });

  describe("the submit key (tasks_add_key, design 02-tasks)", () => {
    const press = (over: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(field(), { key: "Enter", ...over });
    const layout = () => [field().className, field().closest("form")!.className, field().parentElement!.className];

    it("enter (the default, and with no add_key): Enter adds the task, ⌘Enter does not, and the hint says Enter", async () => {
      await show();
      const before = layout();
      expect(field().placeholder).toBe("e.g. rent tomorrow !1 #home, then Enter");
      expect(field().getAttribute("aria-keyshortcuts")).toBe("Enter");
      type("buy milk");
      press({ metaKey: true });
      await new Promise((r) => setTimeout(r, 20));
      expect(s.posts).toHaveLength(0);
      press();
      await waitFor(() => expect(s.posts).toHaveLength(1));
      expect(JSON.parse(String(s.posts[0]!.init.body)).words).toBe("buy milk");
      expect(layout()).toEqual(before);
    });

    it("cmd-enter: ⌘Enter adds the task, plain Enter adds nothing, the hint says ⌘Enter, and the layout is the same", async () => {
      await show();
      const enterLayout = layout();
      cleanup();
      s.current = { ...view(), add_key: "cmd-enter" } as TasksView;
      await show();
      expect(field().placeholder).toBe("e.g. rent tomorrow !1 #home, then ⌘Enter");
      expect(field().getAttribute("aria-keyshortcuts")).toBe("Meta+Enter");
      expect(layout()).toEqual(enterLayout);
      type("buy milk");
      expect(press()).toBe(false); // the browser's own submit on Enter is prevented
      await new Promise((r) => setTimeout(r, 20));
      expect(s.posts).toHaveLength(0);
      expect(field().value).toBe("buy milk");
      press({ metaKey: true });
      await waitFor(() => expect(s.posts).toHaveLength(1));
      expect(JSON.parse(String(s.posts[0]!.init.body)).words).toBe("buy milk");
    });

    for (const add_key of ["enter", "cmd-enter"]) {
      it(`${add_key}: the Add button adds the task, and a refusal shows its reason beside the field and keeps the words`, async () => {
        s.current = { ...view(), add_key } as TasksView;
        await show();
        s.answer = { status: 400, body: { error: "no title" } };
        type("p1");
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
        expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toBe("no title");
        expect(field().value).toBe("p1");
        expect(s.posts).toHaveLength(1);
      });
    }
  });

  it("no longer hints at factory task add, and keeps the Build this line", async () => {
    await show();
    expect(document.body.textContent).not.toContain("factory task add");
    expect(document.body.textContent).toContain("Build this sends a task to the factory.");
  });
});
