// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Fragment, type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Failures, WorkersView } from "../web/src/api.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";

// Health's Runners tab (formerly the Runners page, design 09-dashboard-runners), Failures and Work's Activity (issue
// #312): one row per worker process with its running count and a
// "Finishing up" badge while it drains, the effective worker count once, failed runs grouped by code, and the Floor's failed count
// linking to the Failures view. Built with createElement and a loader the node check skips, as the Settings
// page test does (tsconfig.test.json is checked without JSX).
const mod = async (name: string) => (await import(/* @vite-ignore */ `../web/src/views/${name}.js`)) as Record<string, FunctionComponent>;
const pages = await mod("pages");
const WorkersPage = pages.RunnersTab!;
// The code-revision line Health shows once above its tabs (the Runners page drew it before 2026-11-22).
const CodeRevision = pages.CodeRevision as unknown as FunctionComponent<{ factory: unknown }>;
const ActivityPage = pages.ActivityPage!;
const PluginsPage = (await mod("plugins")).PluginsPage!;
const failuresMod = await mod("failures");
const FailuresSection = failuresMod.FailuresSection!;
// Health's wiring: the window lives in the page (`?window=`), its switch in the page toolbar, the section reads it.
const useFailuresWindow = failuresMod.useFailuresWindow as unknown as () => [string, (w: string) => void];
const FailuresWindowSwitch = failuresMod.FailuresWindowSwitch as FunctionComponent<{ value: string; onChange: (w: string) => void }>;
const WindowedFailures: FunctionComponent = () => {
  const [win, setWin] = useFailuresWindow();
  return createElement(Fragment, null, createElement(FailuresWindowSwitch, { value: win, onChange: setWin }), createElement(FailuresSection as FunctionComponent<{ win: string }>, { win }));
};

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
// The Plugins page's read: a pack MCP server, a broker tool with its own description, and an imported server that did not start.
const plugins = {
  as_of: AT, csrf_token: "tok",
  mcp: [{ name: "docs", description: "Searches the docs.", source: "pack", status: "approved" }],
  skills: [],
  tools: [
    { name: "git.store_branch", description: new LocalToolBroker({} as never).allTools()[0]!.description, read_only: false, origin: "broker", roles: [], last_used: null },
    { name: "mcp:chrome-devtools", description: "Couldn't start chrome-devtools", read_only: false, origin: "mcp", roles: [], last_used: null },
  ],
};
const group = (code: string, n: number) => ({
  code, count: n, last_seen: AT, items: 1,
  runs: Array.from({ length: n }, (_, i) => ({ id: `r_${code}_${i}`, work_item_id: "wi_9", kind: "implement", attempt: i + 1, detail: `${code} detail ${i}`, worker: "h1:1:0", finished_at: AT })),
});
const failures = (window: string): Failures => ({
  as_of: AT, window: window as "24h", cap: 500, total: 3, capped: false,
  groups: [group("tests_failed", 2), group("made_up_code", 1)],
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
      "/api/v1/items": { as_of: AT, total: 0, items: [], facets: { allStates: 0, state: {} }, counts: { open: 0, running: 1 } }, "/api/v1/pauses": { pauses: [], csrf_token: null }, "/api/v1/plugins": plugins,
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

/** snake_case tokens and the internal words of the plain-words list: pid, slots, override, draining, revision, HEAD, outbound, origin/main. */
const INTERNAL_WORDS = /\b[a-z]+_[a-z_]+\b|\b(pid|slots?|override|draining|revision|HEAD|outbound)\b|origin\/main/i;

/** The page's text without its Details disclosures and code elements, text nodes joined by a space. */
function visibleText(root: HTMLElement, skip?: string): string {
  const copy = root.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(["[data-raw], code, script, style", skip].filter(Boolean).join(", ")).forEach((n) => n.remove());
  const words: string[] = [];
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) words.push(n.textContent ?? "");
  return words.join(" ");
}

function show(page: FunctionComponent) {
  render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(page)));
}

describe("Health's Runners tab", () => {
  it("shows a row per process; the draining one says it is finishing up, with its running count", async () => {
    show(WorkersPage);
    const rows = await screen.findAllByTestId("worker-process");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).not.toContain("Finishing up before it stops");
    expect(rows[1]!.textContent).not.toContain("draining");
    expect(rows[1]!.textContent).toContain("Finishing up before it stops");
    expect(rows[1]!.querySelector("[data-line]")!.textContent).toBe("host-2 · running 2");
  });

  it("each row's main line is the host and running of slots; pid and max slots show only in its tooltip", async () => {
    show(WorkersPage);
    const first = (await screen.findAllByTestId("worker-process"))[0]!;
    const line = first.querySelector("[data-line]") as HTMLElement;
    expect(line.textContent).toBe("host-1 · running 1 of 3");
    expect(first.textContent).toContain("started");
    expect(first.textContent).not.toContain("pid");
    expect(first.querySelector("details")).toBeNull();
    fireEvent.mouseEnter(line.parentElement!);
    expect(within(first).getByRole("tooltip").textContent).toBe("pid 101 · max slots 4");
    expect(within(first).getByRole("link", { name: "wi_1" }).getAttribute("href")).toBe("/app/items/wi_1");
  });

  it("names the factory's own host This Mac; another host keeps its name", async () => {
    overrides["/api/v1/workers"] = { ...workers, processes: [proc(1, { pid: 7, busy: 3, idle: 0 }), proc(2)] };
    show(WorkersPage);
    const rows = await screen.findAllByTestId("worker-process");
    expect(rows[0]!.querySelector("[data-line]")!.textContent).toBe("This Mac · running 3 of 3");
    expect(rows[1]!.querySelector("[data-line]")!.textContent).toBe("host-2 · running 1 of 3");
  });

  it("states the factory line with the short version and a compact start time", async () => {
    overrides["/api/v1/overview"] = { ...overview, factory: { ...overview.factory, rev: "3dc0029abcdef", since: new Date(Date.now() - 11 * 60_000 - 5_000).toISOString() } };
    show(WorkersPage);
    await screen.findAllByTestId("worker-process");
    expect(screen.getByTestId("factory-banner").textContent).toContain("Running version 3dc0029 · started 11m ago");
  });

  it("shows the effective worker count once, in words with its source", async () => {
    show(WorkersPage);
    await screen.findAllByTestId("worker-process");
    const line = await screen.findByTestId("effective-workers");
    expect(line.textContent).toBe("Up to 10 tasks at once (changed in Settings)");
    // No other place on the page states a worker count.
    expect(document.body.textContent!.match(/\b10\b/g)).toHaveLength(1);
    expect(screen.getByTestId("factory-banner").textContent).not.toMatch(/workers/);
  });

  it.each([
    ["file", 3, "Up to 3 tasks at once (set in the config file)"],
    ["default", 1, "Up to 1 task at once (default)"],
  ])("a %s worker setting says where it comes from", async (source, count, text) => {
    overrides["/api/v1/overview"] = { ...overview, factory: { ...overview.factory, workers: count, workers_source: source } };
    show(WorkersPage);
    expect((await screen.findByTestId("effective-workers")).textContent).toBe(text);
  });

  it("the code-revision line names the version and how it compares with the latest code, in plain words", async () => {
    for (const [behind, badge] of [[0, "Up to date with the latest code"], [4, "4 commits behind the latest code"]] as const) {
      const factory = { ...overview.factory, rev: "3dc0029abcdef", behind };
      show(() => createElement(CodeRevision, { factory }));
      const line = await screen.findByTestId("code-revision");
      expect(line.textContent).toBe(`Running version 3dc0029${badge}`);
      expect(line.textContent).not.toContain("origin/main");
      cleanup();
    }
  });

  it("answers without `processes` (an older server) with an empty list", async () => {
    overrides["/api/v1/workers"] = { as_of: AT, workers: [] };
    show(WorkersPage);
    expect(await screen.findByText("No worker process is reporting.")).not.toBeNull();
  });
});

describe("plain words on the Runners tab and the Plugins page", () => {
  it("the Runners tab shows no snake_case token or internal word outside Details and tooltips", async () => {
    overrides["/api/v1/overview"] = { ...overview, factory: { ...overview.factory, behind: 2 } };
    show(WorkersPage);
    await screen.findAllByTestId("worker-process");
    await screen.findByTestId("effective-workers");
    expect(INTERNAL_WORDS.exec(visibleText(document.body))?.[0] ?? null).toBeNull();
  });

  it("the Plugins page's MCP and Tools tabs show no snake_case token or internal word outside Details and tool names", async () => {
    show(PluginsPage);
    await screen.findByRole("table", { name: "MCP" });
    expect(INTERNAL_WORDS.exec(visibleText(document.body))?.[0] ?? null).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Tools" }));
    const tools = await screen.findByRole("table", { name: "Tools" });
    // A tool's name is the identifier agents call it by (git.store_branch): the scan skips it, not its description.
    const text = visibleText(document.body, "td:first-child > div > span:first-child");
    expect(text).toContain("Can change things · not given to any agent");
    expect(text).toContain("Couldn't start chrome-devtools");
    expect(INTERNAL_WORDS.exec(text)?.[0] ?? null).toBeNull();
    expect(tools.textContent).toContain("git.store_branch");
  });
});

describe("Activity", () => {
  it("links the failed count in the last 24 hours to Health's Failures tab with the 24h window", async () => {
    show(ActivityPage);
    const link = await screen.findByRole("link", { name: "7" });
    expect(link.getAttribute("href")).toBe("/app/health?tab=failures&window=24h");
  });
});

describe("Failures page", () => {
  it("titles each group in plain words with the code as small text, a meaning, a next step and a link to its items on Work", async () => {
    show(FailuresSection);
    const groups = await screen.findAllByTestId("failure-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]!.textContent).toContain("Checks or tests failed");
    expect(within(groups[0]!).getByTestId("failure-code").textContent).toBe("tests_failed");
    expect(groups[0]!.textContent).toContain("2 runs");
    expect(groups[0]!.textContent).toContain("1 item");
    expect(groups[0]!.textContent).toContain("The checks or tests failed on the change.");
    expect(groups[0]!.textContent).toContain("Read the failing checks");
    expect(within(groups[0]!).getByRole("link", { name: "View items on Work" }).getAttribute("href")).toBe("/app/items?ids=wi_9");
    expect(fetched).toContain("/api/v1/failures?window=24h");
  });

  it("a code with no copy shows the raw code and a generic line", async () => {
    show(FailuresSection);
    const g = (await screen.findAllByTestId("failure-group"))[1]!;
    expect(g.textContent).toContain("made_up_code");
    expect(g.textContent).toContain("This error code has no plain description yet.");
    expect(within(g).queryByTestId("failure-code")).toBeNull();
  });

  it("expands a group to its runs, each item linked to its page", async () => {
    show(FailuresSection);
    const g = (await screen.findAllByTestId("failure-group"))[0]!;
    expect(within(g).queryByRole("table")).toBeNull();
    fireEvent.click(within(g).getByRole("button", { expanded: false }));
    const table = within(g).getByRole("table", { name: "Runs failed with tests_failed" });
    expect(table.textContent).toContain("tests_failed detail 1");
    expect(table.querySelector("details")).toBeNull();
    fireEvent.mouseEnter(table.querySelector("[data-id]")!.parentElement!);
    expect(within(table).getByRole("tooltip").textContent).toBe("h1:1:0");
    expect(within(table).getAllByRole("link", { name: "wi_9" })[0]!.getAttribute("href")).toBe("/app/items/wi_9");
  });

  it("reads the window from the link and switches to 7 days", async () => {
    history.replaceState(null, "", "/app/health?tab=failures&window=7d");
    show(WindowedFailures);
    await screen.findAllByTestId("failure-group");
    expect(fetched).toContain("/api/v1/failures?window=7d");
    expect(within(screen.getByRole("radiogroup", { name: "Window" })).getByRole("radio", { name: "Last 7 days" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Last 24 hours" }));
    await vi.waitFor(() => expect(fetched).toContain("/api/v1/failures?window=24h"));
    expect(new URLSearchParams(location.search).get("window")).toBe("24h");
  });

  it("states the cap when runs were left out", async () => {
    overrides["/api/v1/failures?window=24h"] = { ...failures("24h"), total: 800, capped: true };
    show(FailuresSection);
    expect((await screen.findByTestId("failures-cap")).textContent).toBe("Showing the newest 500 of 800 failed runs in this window.");
  });
});
