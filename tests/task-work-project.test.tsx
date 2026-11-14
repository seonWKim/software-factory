// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemRow, TaskRow, TasksView } from "../web/src/api.js";

// tsconfig.test.json checks this file without JSX, so the pages are built with createElement and their .tsx modules are
// loaded by a specifier the node check skips (as tests/ui-tasks-page.test.tsx does).
const TASKS_MODULE = "../web/src/views/tasks.js";
const APP_MODULE = "../web/src/App.js";
const { TasksPage } = (await import(/* @vite-ignore */ TASKS_MODULE)) as { TasksPage: FunctionComponent };
const { App } = (await import(/* @vite-ignore */ APP_MODULE)) as { App: FunctionComponent };

// Factory work follows the project switcher (design 09-dashboard-app): with a project picked it reads
// GET /api/v1/items?project=<slug>, the items built from that project's tasks; with All projects, every item.
// Needs you (the Factory page at /app/) keeps the unfiltered read.

const AT = "2026-11-14T00:00:00.000Z";
const SLOW = { timeout: 5_000 };
const PROJECTS = [{ slug: "home", name: "Home" }, { slug: "wonderful-ai-demo", name: "Wonderful AI demo" }];

const row = (id: string): TaskRow => ({ id, title: id, list: null, priority: null, due_date: null, due_time: null, recurrence: null, work_item_id: null });
const view: TasksView = {
  today_date: "2026-11-14", today: { overdue: [], due: [] }, upcoming: [], projects: [{ list: null, tasks: [row("tk_inbox")] }],
  csrf_token: "tok", can_build: true, active_projects: PROJECTS,
};
const item = (id: string, title: string): ItemRow => ({
  id, source: { type: "local", id: `local:${id}`, link: "" }, title, level: "needs_approval", badges: [], stage: "REVIEW", tier: null, kind: null,
  blocked_on: "human", blocked_reason: null, close_reason: null, run_status: null, change_ref: null, change_url: null, since: AT,
  updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 }, commands: [], need: { reason: `Reason of ${title}`, anchor: null },
} as ItemRow);
/** Built from a task in Home and in Wonderful AI demo. */
const BOTH = item("wi_both", "Both projects");
/** Built from a task in Home only. */
const HOME = item("wi_home", "Home only");
/** Built from a task in no project. */
const BARE = item("wi_bare", "No project");
/** No source task. */
const PLAIN = item("wi_plain", "No task");
/** The items read's answer by its `project` parameter, as the server filters it ("" for none). */
const BY_PROJECT: Record<string, ItemRow[]> = { "": [BOTH, HOME, BARE, PLAIN], home: [BOTH, HOME], "wonderful-ai-demo": [BOTH] };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const overview = {
  as_of: AT, stages: {}, needs_you: 4, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, system_actions: [],
  factory: { state: "running", rev: "0ff810f1234", target_rev: "0ff810f1234", child_pid: 1, since: AT, workers: 1, workers_source: "default", error: null, pending: [] },
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/v1/items") {
      const list = BY_PROJECT[url.searchParams.get("project") ?? ""];
      return list ? json({ as_of: AT, total: list.length, items: list, facets: { allStates: list.length, state: {} } }) : json({ error: "no project" }, 404);
    }
    if (url.pathname === "/api/v1/tasks") return json(view);
    if (url.pathname === "/api/v1/overview") return json(overview);
    if (url.pathname === "/api/v1/pauses") return json({ pauses: [], csrf_token: null });
    if (url.pathname === "/api/v1/session") return json({ as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" });
    return json({ error: "Not found." }, 404);
  }));
  vi.stubGlobal("scrollTo", () => undefined);
  vi.stubGlobal("innerWidth", 1280);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const itemReads = () => vi.mocked(fetch).mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/v1/items"));
const switcher = () => screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement;
const factoryWork = async () => (await screen.findByRole("heading", { name: /Factory work/ }, SLOW)).closest("section")!;
/** The work item IDs Factory work lists, in page order. */
const listed = async () => [...(await factoryWork()).querySelectorAll<HTMLElement>("li[data-key]")].map((r) => r.dataset.key).sort();

function showTasks(path: string) {
  history.replaceState(null, "", path);
  render(createElement(QueryClientProvider, { client: client() }, createElement(TasksPage)));
}

describe("Factory work on the Tasks page follows the project switcher", () => {
  it("with a project picked on load, lists only the items built from that project's tasks", async () => {
    showTasks("/app/tasks?project=home");
    await waitFor(async () => expect(await listed()).toEqual(["wi_both", "wi_home"]), SLOW);
    expect(itemReads()).toContain("/api/v1/items?project=home");
    expect(within(await factoryWork()).queryByText("No task")).toBeNull();
    expect(within(await factoryWork()).queryByText("No project")).toBeNull();
  });

  it("an item built from a task in two projects shows under each; an item with no task or no project shows under All only", async () => {
    showTasks("/app/tasks");
    await waitFor(async () => expect(await listed()).toEqual(["wi_bare", "wi_both", "wi_home", "wi_plain"]), SLOW);
    expect(itemReads()).toContain("/api/v1/items");
    fireEvent.change(switcher(), { target: { value: "wonderful-ai-demo" } });
    await waitFor(async () => expect(await listed()).toEqual(["wi_both"]), SLOW);
    fireEvent.change(switcher(), { target: { value: "home" } });
    await waitFor(async () => expect(await listed()).toEqual(["wi_both", "wi_home"]), SLOW);
    fireEvent.change(switcher(), { target: { value: "" } });
    await waitFor(async () => expect(await listed()).toEqual(["wi_bare", "wi_both", "wi_home", "wi_plain"]), SLOW);
  });
});

describe("Needs you (the Factory page at /app/)", () => {
  it("is unchanged: it lists every item that needs the owner and reads the items with no project filter", async () => {
    history.replaceState(null, "", "/app/?project=home");
    render(createElement(QueryClientProvider, { client: client() }, createElement(App)));
    const tables = await screen.findAllByRole("table", { name: "Needs you" }, SLOW);
    const keys = tables.flatMap((t) => [...t.querySelectorAll<HTMLElement>("tr[data-key]")].map((r) => r.dataset.key)).sort();
    expect(keys).toEqual(["wi_bare", "wi_both", "wi_home", "wi_plain"]);
    expect(itemReads().length).toBeGreaterThan(0);
    expect(itemReads().every((u) => !u.includes("project"))).toBe(true);
  });
});
