// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLOW, TOKEN, TasksPage, card, reset, row, s, show, teardown, view } from "./ui-tasks-fixtures.js";

beforeEach(reset);
afterEach(teardown);

// Task projects: the project tabs, the Projects… dialog and Add project (design 09-dashboard-app, project switcher and dialog).

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
    s.current = view({ active_projects: PROJECTS });
    s.filtered = { home: homeOnly() };
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
    s.current = view({ active_projects: PROJECTS });
    s.filtered = { home: homeOnly() };
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
    s.current = view({ active_projects: PROJECTS });
    s.filtered = { home: homeOnly() };
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
    s.current = view({ active_projects: PROJECTS });
    history.replaceState(null, "", "/app/tasks?project=gone");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
    await screen.findByRole("tab", { name: "+gone" }, SLOW);
    expect(selectedProject()).toEqual(["+gone"]);
  });

  it("Projects… opens the project dialog outside the row; a checkbox adds or removes the task's link", async () => {
    s.current = view({ projects: [{ list: null, tasks: [row("tk_inbox", { projects: ["home"] })] }], active_projects: PROJECTS });
    s.answer = { status: 200, body: { task_id: "tk_inbox", project: "garden", changed: true } };
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
    const sent = s.posts.filter((p) => p.url === "/api/v1/tasks/project").map((p) => JSON.parse(String(p.init.body)));
    expect(sent).toEqual([{ id: "tk_inbox", project: "garden", add: true }, { id: "tk_inbox", project: "home", add: false }]);
    expect((s.posts[0]!.init.headers as Record<string, string>)["x-csrf-token"]).toBe(TOKEN);
  });

  it("New project creates the project, then puts the task in it; a refusal stays in the dialog", async () => {
    s.current = view({ active_projects: [] });
    await show();
    fireEvent.click(within(card("tk_inbox")).getByRole("button", { name: "More actions: tk_inbox" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Projects…" }));
    const dialog = document.querySelector<HTMLElement>("[data-dialog]")!;
    expect(within(dialog).getByText("No project yet: create the first one below.")).toBeTruthy();
    s.answer = { status: 409, body: { error: 'project "home" exists already' } };
    fireEvent.change(within(dialog).getByLabelText("New project"), { target: { value: "Home" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect((await within(dialog).findByRole("alert", {}, SLOW)).textContent).toBe('project "home" exists already');
    expect(s.posts.filter((p) => p.url === "/api/v1/tasks/project")).toEqual([]);
    s.answer = { status: 200, body: { project: { slug: "garden", name: "Garden" }, task_id: "tk_inbox", changed: true } };
    fireEvent.change(within(dialog).getByLabelText("New project"), { target: { value: "Garden" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(s.posts.some((p) => p.url === "/api/v1/tasks/project")).toBe(true), SLOW);
    const creates = s.posts.filter((p) => p.url === "/api/v1/projects").map((p) => JSON.parse(String(p.init.body)) as { id: string; name: string });
    expect(creates.map((c) => c.name)).toEqual(["Home", "Garden"]);
    expect(creates.every((c) => /^pj_[0-9a-f]{32}$/.test(c.id))).toBe(true);
    expect(JSON.parse(String(s.posts.at(-1)!.init.body))).toEqual({ id: "tk_inbox", project: "garden", add: true });
    expect((within(dialog).getByLabelText("New project") as HTMLInputElement).value).toBe("");
  });

  it("+ (Add project) after the last tab opens a name dialog; Create posts { id, name } and selects the new tab", async () => {
    s.current = view({ active_projects: PROJECTS });
    s.filtered = { garden: view({ active_projects: PROJECTS }), orchard: view({ active_projects: [...PROJECTS, { slug: "orchard", name: "Orchard" }] }) };
    await show();
    const add = screen.getByRole("button", { name: "Add project" });
    expect(add.textContent).toBe("+");
    expect(add.previousElementSibling).toBe(screen.getByRole("tablist", { name: "Project" }));
    fireEvent.click(add);
    const dialog = document.querySelector<HTMLElement>("[data-dialog]")!;
    const create = within(dialog).getByRole("button", { name: "Create project" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    s.answer = { status: 201, body: { project: { slug: "orchard", name: "Orchard" } } };
    fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "Orchard" } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(document.querySelector("[data-dialog]")).toBeNull(), SLOW);
    const sent = s.posts.filter((p) => p.url === "/api/v1/projects").map((p) => JSON.parse(String(p.init.body)) as { id: string; name: string });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe("Orchard");
    expect(sent[0]!.id).toMatch(/^pj_[0-9a-f]{32}$/);
    expect(new URLSearchParams(location.search).get("project")).toBe("orchard");
    await waitFor(() => expect(selectedProject()).toEqual(["Orchard"]), SLOW);
  });

  it("a refused create keeps the Add project dialog open with the reason and keeps the ID for a retry; Cancel sends nothing", async () => {
    s.current = view({ active_projects: PROJECTS });
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    const dialog = document.querySelector<HTMLElement>("[data-dialog]")!;
    s.answer = { status: 409, body: { error: 'project "home" exists already' } };
    fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "Home" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect((await within(dialog).findByRole("alert", {}, SLOW)).textContent).toBe('project "home" exists already');
    expect(document.querySelector("[data-dialog]")).toBe(dialog);
    expect(selectedProject()).toEqual(["All projects"]);
    expect(location.search).toBe("");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(s.posts.filter((p) => p.url === "/api/v1/projects")).toHaveLength(2), SLOW);
    const ids = s.posts.map((p) => (JSON.parse(String(p.init.body)) as { id: string }).id);
    expect(ids[1]).toBe(ids[0]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(document.querySelector("[data-dialog]")).toBeNull();
    expect(s.posts).toHaveLength(2);
  });

  it("a done row has no Projects… item", async () => {
    s.current = view({ projects: [{ list: null, tasks: [row("tk_old", { done_at: "2026-11-11T10:00:00.000Z" })] }] });
    await show();
    expect(within(card("tk_old")).queryByRole("button", { name: /More actions/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Projects…" })).toBeNull();
  });
});
