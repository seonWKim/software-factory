// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { EXPANDED_KEY, VIEW_KEY, buildTree } from "../web/src/views/tree.js";

// The Work items tree (design §9): split parents with their phases, who holds what and why, keyboard use, one
// request per poll, and the flat list kept behind the List toggle.

const AT = "2026-11-07T00:00:00.000Z";
const NOW = Date.parse(AT);

const row = (n: number, level: string, title: string, extra: object = {}) => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title, level,
  badges: [], stage: "RUNNING", tier: 2, kind: null, blocked_on: "none", blocked_reason: null, close_reason: null, run_status: null,
  change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 },
  parent_id: null, phase: null, run: null, claim: null, waiting_on_number: null, ...extra,
});
const why = (code: string, text: string, refs: number[] = []) => ({ code, text, next_actor: "factory", refs, ref_url: "https://github.com/o/r/issues/" });
const phaseHold = (n: number, prev: number) => why("phase", `Waiting for the previous phase #${prev} to merge`, [prev]);

const ROWS = [
  row(10, "blocked_by_task", "Split parent", { why: why("phase", "Waiting for its 3 open phases to merge") }),
  // Out of phase order on purpose.
  row(13, "blocked_by_task", "Phase three", { parent_id: "wi_10", phase: 3, waiting_on_number: 12, why: phaseHold(13, 12) }),
  row(11, "running", "Phase one", {
    parent_id: "wi_10", phase: 1, change_ref: "41", change_url: "https://github.com/o/r/pull/41", why: why("running", "Running"),
    run: { kind: "implement", status: "running", attempt: 1, worker_id: "host:7:0", started_at: AT, position: null },
  }),
  row(12, "blocked_by_task", "Phase two", { parent_id: "wi_10", phase: 2, waiting_on_number: 11, why: phaseHold(12, 11) }),
  row(20, "blocked_by_task", "Held by coordination", {
    why: why("held", "Held behind #11, which is running", [11]),
    run: { kind: "implement", status: "queued", attempt: 0, worker_id: null, started_at: null, position: 1 },
    claim: { decision: "held", holder: "#11", holder_id: "wi_11", approved: false, cost: 4, threshold: 2.5 },
  }),
  row(30, "blocked_by_task", "Finished split", { why: why("phase", "Waiting for its phases to merge") }),
  row(31, "closed", "Done one", { stage: "CLOSED", parent_id: "wi_30", phase: 1, close_reason: "merged" }),
  row(32, "closed", "Done two", { stage: "CLOSED", parent_id: "wi_30", phase: 2, close_reason: "merged" }),
  row(40, "closed", "Closed alone", { stage: "CLOSED", close_reason: "merged" }),
  row(50, "needs_approval", "Spec waiting", { stage: "READY", blocked_on: "human", why: why("human", "Waiting for approval") }),
  row(60, "needs_you", "Agent asks", { blocked_on: "human", blocked_reason: "agent_needs_human", why: why("human", "Waiting for a person") }),
  row(61, "needs_triage", "Triage asks", { stage: "NEW", blocked_on: "human", blocked_reason: "agent_needs_human", why: why("human", "Waiting for a person") }),
  row(62, "blocked_by_task", "Dependency held", {
    blocked_on: "dependency", blocked_reason: "waiting for #11 to merge", waiting_on_number: 11, why: why("dependency", "Waiting for #11 to merge", [11]),
    run: { kind: "implement", status: "queued", attempt: 0, worker_id: null, started_at: null, position: 2 },
  }),
];
const overview = { as_of: AT, stages: {}, needs_you: 1, running: 1, queued: 1, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, unreviewed_merges_7d: 0, plugins: { issues: null } };
// One queued run: the Work summary's "queued" counts runs like overview.queued, not items at level queued.
const queueBody = { as_of: AT, queue: [{ position: 1, id: "run_q", kind: "implement", work_item_id: "wi_20", attempt: 0, created_at: AT, not_before: null }] };
const itemsBody = { as_of: AT, total: ROWS.length, items: ROWS, facets: { allStates: ROWS.length, state: {} } };
let fetched: string[] = [];

class MemoryStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

beforeEach(() => {
  fetched = [];
  // react-aria's focus handling calls CSS.escape, which jsdom does not have.
  if (!globalThis.CSS?.escape) vi.stubGlobal("CSS", { escape: (v: string) => v.replace(/[^\w-]/g, "\\$&") });
  vi.stubGlobal("localStorage", new MemoryStorage());
  history.replaceState(null, "", "/app/items");
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetched.push(url);
    const path = url.split("?")[0];
    const body = path === "/api/v1/items" ? itemsBody : path === "/api/v1/overview" ? overview : path === "/api/v1/pauses" ? { as_of: AT, csrf_token: null, pauses: [] } : path === "/api/v1/queue" ? queueBody : undefined;
    return new Response(JSON.stringify(body ?? { error: "Not found." }), { status: body ? 200 : 404 });
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  return screen.findByRole("treegrid", { name: "Work items" });
}
const rowOf = (tree: HTMLElement, title: string) => within(tree).getByRole("link", { name: title }).closest("[role=row]") as HTMLElement;
const titles = (tree: HTMLElement) => [...tree.querySelectorAll("[role=row]")].map((r) => r.querySelector("a.font-medium")?.textContent);
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(10)));

describe("items tree", () => {
  it("a fresh load shows the tree", async () => {
    const tree = await mount();
    expect(tree).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Work items" })).toBeNull();
  });

  it("shows the split parent with its phases in phase order, each item once", async () => {
    const tree = await mount();
    expect(titles(tree)).toEqual(["Split parent", "Phase one", "Phase two", "Phase three", "Held by coordination", "Finished split", "Spec waiting", "Agent asks", "Triage asks", "Dependency held"]);
    expect(new Set(titles(tree)).size).toBe(titles(tree).length);
  });

  it("chips the held phases with the item they wait for, the coordination hold with its holder, and names the worker", async () => {
    const tree = await mount();
    const chip = (title: string) => within(rowOf(tree, title)).getByText(/^waits for/);
    expect(chip("Phase two").textContent).toBe("waits for #11");
    expect(chip("Phase two").getAttribute("href")).toBe("/app/items/wi_11");
    expect(chip("Phase three").textContent).toBe("waits for #12");
    expect(chip("Phase three").getAttribute("href")).toBe("/app/items/wi_12");
    expect(chip("Held by coordination").textContent).toBe("waits for #11");
    expect(chip("Held by coordination").getAttribute("href")).toBe("/app/items/wi_11");
    expect(within(rowOf(tree, "Phase one")).queryByText(/^waits for/)).toBeNull();
    expect(within(rowOf(tree, "Phase one")).getByText("host:7:0")).toBeTruthy();
    expect(within(rowOf(tree, "Phase one")).getByRole("link", { name: "PR #41" }).getAttribute("href")).toBe("https://github.com/o/r/pull/41");
  });

  it("never moves a held item under the item it waits for", () => {
    const nodes = buildTree(ROWS, { state: null, q: "", showClosed: false });
    const phase1 = nodes.flatMap((n) => n.children).find((n) => n.item.id === "wi_11")!;
    expect(phase1.children).toEqual([]);
    expect(nodes.find((n) => n.item.id === "wi_20")!.children).toEqual([]);
  });

  it("hides closed items and collapses a parent whose phases are all closed to one row; Show closed shows them", async () => {
    const tree = await mount();
    expect(titles(tree)).not.toContain("Closed alone");
    expect(titles(tree)).not.toContain("Done one");
    expect(within(rowOf(tree, "Finished split")).queryByRole("button", { name: /Expand|Collapse/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show closed" }));
    expect(titles(await screen.findByRole("treegrid", { name: "Work items" }))).toContain("Closed alone");
  });

  it("the summary counts are buttons that set the filter", async () => {
    await mount();
    const summary = screen.getByTestId("summary");
    expect(within(summary).getByRole("button", { name: "1 running" })).toBeTruthy();
    expect(await within(summary).findByRole("button", { name: `${overview.queued} queued` })).toBeTruthy();
    expect(queueBody.queue.length).toBe(overview.queued);
    expect(within(summary).getByRole("button", { name: "3 held" })).toBeTruthy();
    expect(within(summary).getByRole("button", { name: "3 needs you" })).toBeTruthy();
    expect(summary.textContent).toContain("rate limit: ok");
    fireEvent.click(within(summary).getByRole("button", { name: "3 held" }));
    await settle();
    expect(titles(screen.getByRole("treegrid", { name: "Work items" }))).toEqual(["Split parent", "Phase two", "Phase three", "Held by coordination"]);
    expect(screen.getByRole("button", { name: /^Held 3/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("the needs filter shows Needs you and Needs triage, nothing from Blocked by another task", async () => {
    await mount();
    fireEvent.click(within(screen.getByTestId("summary")).getByRole("button", { name: "3 needs you" }));
    await settle();
    const shown = titles(screen.getByRole("treegrid", { name: "Work items" }));
    expect(shown).toEqual(expect.arrayContaining(["Spec waiting", "Agent asks", "Triage asks"]));
    for (const t of ["Dependency held", "Held by coordination", "Phase two"]) expect(shown).not.toContain(t);
  });

  it("search matches in the tree and keeps the matching item's parent for context", async () => {
    await mount();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search work items" }), { target: { value: "phase three" } });
    await settle();
    expect(titles(screen.getByRole("treegrid", { name: "Work items" }))).toEqual(["Split parent", "Phase three"]);
  });

  it("makes exactly one items request per poll, whatever the number of rows", async () => {
    await mount();
    await settle();
    const before = fetched.filter((u) => u.startsWith("/api/v1/items")).length;
    expect(before).toBe(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(3000)));
    expect(fetched.filter((u) => u.startsWith("/api/v1/items")).length).toBe(2);
  });

  it("the List toggle shows the flat list from the server's query, and is remembered", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const table = await screen.findByRole("table", { name: "Work items" });
    expect(table.querySelectorAll("tbody tr").length).toBe(ROWS.length);
    expect(localStorage.getItem(VIEW_KEY)).toBe("list");
    expect(fetched.at(-1)).toBe("/api/v1/items");
    cleanup();
    await act(async () => { render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>); });
    expect(await screen.findByRole("table", { name: "Work items" })).toBeTruthy();
  });

  it("arrow keys move focus between rows and expand and collapse them", async () => {
    const tree = await mount();
    const parent = rowOf(tree, "Split parent");
    act(() => parent.focus());
    expect(titles(tree)).toContain("Phase one");
    fireEvent.keyDown(parent, { key: "ArrowLeft" });
    await settle();
    expect(titles(tree)).not.toContain("Phase one");
    fireEvent.keyDown(rowOf(tree, "Split parent"), { key: "ArrowRight" });
    await settle();
    expect(titles(tree)).toContain("Phase one");
    fireEvent.keyDown(rowOf(tree, "Split parent"), { key: "ArrowDown" });
    await settle();
    expect(document.activeElement).toBe(rowOf(tree, "Phase one"));
  });

  it("saves the expanded rows per browser, and Expand all / Collapse all work", async () => {
    const tree = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    await settle();
    expect(titles(tree)).not.toContain("Phase one");
    expect(JSON.parse(localStorage.getItem(EXPANDED_KEY))).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    await settle();
    expect(titles(tree)).toContain("Phase one");
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    await settle();
    cleanup();
    const again = await mount();
    expect(titles(again)).not.toContain("Phase one");
  });

  it("moves the wait reason and worker to a second line at phone width and uses no animation", async () => {
    const tree = await mount();
    const second = within(rowOf(tree, "Phase one")).getByText("host:7:0").parentElement;
    expect(second.className).toContain("basis-full");
    expect(second.className).toContain("sm:basis-auto");
    // Token classes switch themes through CSS variables, so there is no dark: variant; no animation.
    expect(tree.innerHTML).not.toMatch(/animate-|transition/);
  });

  it("has no axe violations", async () => {
    const tree = await mount();
    const result = await axe.run(tree.closest("main") ?? document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
  });
});
