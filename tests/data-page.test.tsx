// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json (no DOM, no JSX) would reject this file, and web/tsconfig.json lists only
// tests/ui-shell.test.tsx; both configs were outside this change's allowed paths. Once web/tsconfig.json
// includes this file and tsconfig.test.json excludes it, drop this line. It typechecks clean under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { POLL_MS } from "../web/src/api.js";
import { CELL_MAX } from "../web/src/views/data.js";

// The Data page (design §9, issue #239): the table list, one page of rows, links, copy as JSON, long cells cut
// with "Show all", and no polling: it reads again only when Refresh is pressed.

const AT = "2026-11-07T00:00:00.000Z";
const LONG = "x".repeat(CELL_MAX + 100);
const overview = { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } };
const tables = {
  as_of: AT,
  tables: [
    { name: "run_attempts", rows: 1, columns: ["run_id", "attempt", "lease_token", "worker_id", "error_code"], hidden: ["lease_token"] },
    { name: "work_items", rows: 2, columns: ["id", "title", "problem", "version"], hidden: [] },
  ],
};
const workItems = {
  as_of: AT, table: "work_items", columns: ["id", "title", "problem", "version"], hidden: [], order_by: ["created_at", "id"], filter: null,
  total: 2, page: 1, limit: 50, run_items: {},
  rows: [
    { id: "wi_2", title: "[withheld: github_token]", problem: LONG, version: 3 },
    { id: "wi_1", title: "Plain", problem: "short", version: 1 },
  ],
};
const attempts = {
  as_of: AT, table: "run_attempts", columns: ["run_id", "attempt", "lease_token", "worker_id", "error_code"], hidden: ["lease_token"], order_by: ["started_at"],
  filter: null, total: 1, page: 1, limit: 50, run_items: { run_a: "wi_7" },
  rows: [{ run_id: "run_a", attempt: 1, lease_token: "[hidden]", worker_id: "host:1:0", error_code: null }],
};
const RESPONSES: Record<string, unknown> = {
  "/api/v1/overview": overview,
  "/api/v1/data/tables": tables,
  "/api/v1/data/tables/work_items": workItems,
  "/api/v1/data/tables/run_attempts": attempts,
};
let fetched: string[] = [];
let client: QueryClient;
let clip: string[] = [];

beforeEach(() => {
  fetched = [];
  clip = [];
  history.replaceState(null, "", "/app/");
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => "visible");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetched.push(url);
    const body = RESPONSES[url.split("?")[0]!];
    if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async (t: string) => void clip.push(t)) },
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

const dataReads = () => fetched.filter((u) => u.startsWith("/api/v1/data/"));

async function openTable(name: string) {
  const list = await screen.findByRole("navigation", { name: "Tables" });
  fireEvent.click(await within(list).findByText(name));
  return screen.findByRole("table", { name });
}

describe("Data page", () => {
  it("the Data entry is in the sidebar after Settings and shows the table list beside the rows", async () => {
    mount();
    const side = screen.getByRole("complementary", { name: "Sidebar" });
    const links = [...side.querySelectorAll("a")].map((a) => a.textContent);
    expect(links.slice(-2)).toEqual(["Settings", "Data"]);
    fireEvent.click(within(side).getByText("Data"));
    expect(location.pathname).toBe("/app/data");
    expect(await screen.findByRole("heading", { name: "Data" })).toBeTruthy();
    expect(await screen.findByRole("navigation", { name: "Tables" })).toBeTruthy();
    expect(screen.getByText("Choose a table to see its rows, newest first.")).toBeTruthy();
  });

  it("the table list shows row counts, and choosing a table loads its first page", async () => {
    history.replaceState(null, "", "/app/data");
    mount();
    const list = await screen.findByRole("navigation", { name: "Tables" });
    const entry = (await within(list).findByText("work_items")).closest("button")!;
    expect(entry.textContent).toBe("work_items2");
    const t = await openTable("work_items");
    expect(dataReads()).toContain("/api/v1/data/tables/work_items");
    expect(within(t).getByText("Plain")).toBeTruthy();
    expect(screen.getByTestId("data-range").textContent).toBe("1–2 of 2");
    expect([...t.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["Copy", "id", "title", "problem", "version"]);
  });

  it("sets no refetch interval: it reads again only when Refresh is pressed", async () => {
    history.replaceState(null, "", "/app/data");
    mount();
    await openTable("work_items");
    const data = client.getQueryCache().findAll().filter((q) => String(q.queryKey[0]).startsWith("/api/v1/data/"));
    expect(data.length).toBe(2);
    for (const q of data) expect((q.options as { refetchInterval?: unknown }).refetchInterval).toBeFalsy();
    const before = dataReads().length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS * 20)));
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(dataReads().length).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(dataReads().length).toBe(before + 2);
  });

  it("a wi_ value links to its item, a run_ value to the item that owns the run", async () => {
    history.replaceState(null, "", "/app/data");
    mount();
    let t = await openTable("work_items");
    expect(within(t).getByRole("link", { name: "wi_2" }).getAttribute("href")).toBe("/app/items/wi_2");
    t = await openTable("run_attempts");
    expect(within(t).getByRole("link", { name: "run_a" }).getAttribute("href")).toBe("/app/items/wi_7");
    expect(within(t).getByText("[hidden]")).toBeTruthy();
  });

  it("Copy row as JSON copies the values as shown, markers included, never a raw value", async () => {
    history.replaceState(null, "", "/app/data");
    mount();
    let t = await openTable("run_attempts");
    fireEvent.click(within(t).getByRole("button", { name: "Copy row as JSON" }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(JSON.parse(clip[0]!)).toEqual({ run_id: "run_a", attempt: 1, lease_token: "[hidden]", worker_id: "host:1:0", error_code: null });
    t = await openTable("work_items");
    fireEvent.click(within(t).getAllByRole("button", { name: "Copy row as JSON" })[0]!);
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(JSON.parse(clip[1]!)).toMatchObject({ id: "wi_2", title: "[withheld: github_token]" });
  });

  it("a cell over 300 characters is cut, and Show all expands that one cell", async () => {
    history.replaceState(null, "", "/app/data");
    mount();
    const t = await openTable("work_items");
    const cell = within(t).getByRole("button", { name: /^Show all/ }).closest("td")!;
    expect(cell.textContent).toContain(`${"x".repeat(CELL_MAX)}…`);
    expect(cell.textContent).not.toContain(LONG);
    expect(within(t).getAllByRole("button", { name: /^Show all/ })).toHaveLength(1);
    fireEvent.click(within(cell).getByRole("button", { name: /^Show all/ }));
    expect(cell.textContent).toBe(LONG);
    expect(within(t).queryByRole("button", { name: /^Show all/ })).toBeNull();
  });

  it("the filter sends col and val; paging is not shown past the last page", async () => {
    history.replaceState(null, "", "/app/data");
    mount();
    await openTable("work_items");
    fireEvent.change(screen.getByRole("combobox", { name: "Filter column" }), { target: { value: "problem" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter value" }), { target: { value: "it's" } });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(dataReads()).toContain("/api/v1/data/tables/work_items?col=problem&val=it%27s");
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
