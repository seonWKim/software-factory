// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Failures, WorkersView } from "../web/src/api.js";

// The Workers, Failures and Floor pages (issue #312): one row per worker process with a draining badge and
// slot counts, the effective worker count once, failed runs grouped by code, and the Floor's failed count
// linking to the Failures view. Built with createElement and a loader the node check skips, as the Settings
// page test does (tsconfig.test.json is checked without JSX).
const mod = async (name: string) => (await import(/* @vite-ignore */ `../web/src/views/${name}.js`)) as Record<string, FunctionComponent>;
const pages = await mod("pages");
const WorkersPage = pages.RunnersPage!;
const ActivityPage = pages.ActivityPage!;
const FailuresPage = (await mod("failures")).FailuresPage!;

const AT = new Date().toISOString();
const proc = (n: number, extra: object = {}) => ({
  process_id: `h${n}:${n}`, pid: 100 + n, host: `host-${n}`, slots: 3, max_slots: 4, busy: 1, idle: 2, index_base: 0, started_at: AT, reported_at: AT, runs: [], ...extra,
});
const workers: WorkersView = {
  as_of: AT,
  workers: [],
  processes: [
    proc(1, { runs: [{ id: "run_1", kind: "implement", work_item_id: "wi_1", worker_id: "h1:1:0", started_at: AT }] }),
    proc(2, { slots: 0, busy: 2, idle: 0, max_slots: 4 }),
  ],
};
const overview = {
  as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 1, failed: 7, tokens: 0 },
  factory: { state: "running", rev: "aaaaaaa1111", target_rev: null, child_pid: 7, since: AT, workers: 10, workers_source: "override", error: null, pending: [] },
};
const group = (code: string, description: string | null, n: number) => ({
  code, description, count: n, last_seen: AT, items: 1,
  runs: Array.from({ length: n }, (_, i) => ({ id: `r_${code}_${i}`, work_item_id: "wi_9", kind: "implement", attempt: i + 1, detail: `${code} detail ${i}`, worker: "h1:1:0", finished_at: AT })),
});
const failures = (window: string): Failures => ({
  as_of: AT, window: window as "24h", cap: 500, total: 3, capped: false,
  groups: [group("tests_failed", "The checks or tests failed.", 2), group("made_up_code", null, 1)],
});

let fetched: string[] = [];
let overrides: Record<string, unknown> = {};
beforeEach(() => {
  fetched = [];
  overrides = {};
  history.replaceState(null, "", "/app/");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetched.push(url);
    const body: Record<string, unknown> = {
      "/api/v1/workers": workers, "/api/v1/overview": overview, "/api/v1/runs": { as_of: AT, runs: [] }, "/api/v1/queue": { as_of: AT, queue: [] },
      "/api/v1/items": { as_of: AT, total: 0, items: [], facets: { allStates: 0, state: {} } }, "/api/v1/pauses": { pauses: [], csrf_token: null },
      "/api/v1/failures?window=24h": failures("24h"), "/api/v1/failures?window=7d": failures("7d"), ...overrides,
    };
    return url in body
      ? new Response(JSON.stringify(body[url]), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(page: FunctionComponent) {
  render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(page)));
}

describe("Workers page", () => {
  it("shows a row per process; the draining one has a badge and 0 slots", async () => {
    show(WorkersPage);
    const rows = await screen.findAllByTestId("worker-process");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).not.toContain("draining");
    expect(rows[1]!.textContent).toContain("draining");
    expect(rows[1]!.querySelector("[data-slots]")!.textContent).toBe("2 busy, 0 idle, 0 slots, max 4");
  });

  it("shows busy, idle, max slots, host, pid, start time and the process's runs", async () => {
    show(WorkersPage);
    const first = (await screen.findAllByTestId("worker-process"))[0]!;
    expect(first.querySelector("[data-slots]")!.textContent).toBe("1 busy, 2 idle, 3 slots, max 4");
    expect(first.textContent).toContain("host-1");
    expect(first.textContent).toContain("pid 101");
    expect(first.textContent).toContain("started");
    expect(within(first).getByRole("link", { name: "wi_1" }).getAttribute("href")).toBe("/app/items/wi_1");
  });

  it("shows the effective worker count once, with its source", async () => {
    show(WorkersPage);
    await screen.findAllByTestId("worker-process");
    const line = await screen.findByTestId("effective-workers");
    expect(line.textContent).toBe("Worker setting: 10 (override)");
    // No other place on the page states a worker count.
    expect(document.body.textContent!.match(/\b10\b/g)).toHaveLength(1);
    expect(screen.getByTestId("factory-banner").textContent).not.toMatch(/workers/);
  });

  it("answers without `processes` (an older server) with an empty list", async () => {
    overrides["/api/v1/workers"] = { as_of: AT, workers: [] };
    show(WorkersPage);
    expect(await screen.findByText("No worker process is reporting.")).not.toBeNull();
  });
});

describe("Activity", () => {
  it("links the failed count in the last 24 hours to Failures with the 24h window", async () => {
    show(ActivityPage);
    const link = await screen.findByRole("link", { name: "7" });
    expect(link.getAttribute("href")).toBe("/app/failures?window=24h");
  });
});

describe("Failures page", () => {
  it("lists groups with count, items, last seen and a description for a known code only", async () => {
    show(FailuresPage);
    const groups = await screen.findAllByTestId("failure-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]!.textContent).toContain("tests_failed");
    expect(groups[0]!.textContent).toContain("2 runs");
    expect(groups[0]!.textContent).toContain("1 item");
    expect(groups[0]!.textContent).toContain("The checks or tests failed.");
    expect(groups[1]!.textContent).toContain("made_up_code");
    expect(fetched).toContain("/api/v1/failures?window=24h");
  });

  it("expands a group to its runs, each item linked to its page", async () => {
    show(FailuresPage);
    const g = (await screen.findAllByTestId("failure-group"))[0]!;
    expect(within(g).queryByRole("table")).toBeNull();
    fireEvent.click(within(g).getByRole("button"));
    const table = within(g).getByRole("table", { name: "Runs failed with tests_failed" });
    expect(table.textContent).toContain("tests_failed detail 1");
    expect(table.textContent).toContain("h1:1:0");
    expect(within(table).getAllByRole("link", { name: "wi_9" })[0]!.getAttribute("href")).toBe("/app/items/wi_9");
  });

  it("reads the window from the link and switches to 7 days", async () => {
    history.replaceState(null, "", "/app/failures?window=7d");
    show(FailuresPage);
    await screen.findAllByTestId("failure-group");
    expect(fetched).toContain("/api/v1/failures?window=7d");
    fireEvent.click(screen.getByRole("button", { name: "Last 24 hours" }));
    await vi.waitFor(() => expect(fetched).toContain("/api/v1/failures?window=24h"));
  });

  it("states the cap when runs were left out", async () => {
    overrides["/api/v1/failures?window=24h"] = { ...failures("24h"), total: 800, capped: true };
    show(FailuresPage);
    expect((await screen.findByTestId("failures-cap")).textContent).toBe("Showing the newest 500 of 800 failed runs in this window.");
  });
});
