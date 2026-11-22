// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { EXPANDED_KEY, VIEW_KEY } from "../web/src/views/tree.js";
import { buildTree } from "../web/src/views/tree-model.js";

// The Work items tree (design §9): split parents with their phases, who holds what and why, keyboard use, one
// request per poll, and the flat list kept behind the List toggle.

const AT = "2026-11-07T00:00:00.000Z";
const NOW = Date.parse(AT);

const row = (n: number, level: string, title: string, extra: object = {}) => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title, item_phase: level, reason_code: "person",
   stage: "RUNNING", tier: 2, kind: null, blocked_on: "none", blocked_reason: null, close_reason: null, run_status: null,
  change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 },
  parent_id: null, phase: null, run: null, claim: null, waiting_on_number: null, ...extra,
});
// An unknown reason code shows as is (lib/format.ts whyText), so each fixture names its text as its reason code.
const why = (code: string, text: string, refs: number[] = []) => ({ code, reason_code: text, params: {}, alarms: [], holder_id: null, next_actor: "factory", refs, ref_url: "https://github.com/o/r/issues/" });
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
  row(20, "held", "Held by coordination", {
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
const itemsBody = { as_of: AT, total: ROWS.length, items: ROWS, facets: { allStates: ROWS.length, state: {} }, counts: { open: 0, running: 1 } };
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

  it("links a held item's state badge to the item it waits for, named on hover, with no id or waits-for chip, and names the worker", async () => {
    const tree = await mount();
    const held = (title: string) => rowOf(tree, title).querySelector<HTMLAnchorElement>("[data-waits-for]")!;
    expect(held("Phase two").getAttribute("href")).toBe("/app/items/wi_11");
    expect(held("Phase two").title).toBe("Waits for Phase one");
    expect(held("Phase three").getAttribute("href")).toBe("/app/items/wi_12");
    expect(held("Held by coordination").getAttribute("href")).toBe("/app/items/wi_11");
    expect(held("Phase two").textContent).toBe("Blocked by another task");
    expect(held("Held by coordination").textContent).toBe("Held");
    expect(rowOf(tree, "Phase one").querySelector("[data-waits-for]")).toBeNull();
    for (const title of ["Phase two", "Held by coordination"]) {
      expect(rowOf(tree, title).textContent, title).not.toMatch(/waits for|o\/r#\d|wi_\d/);
    }
    const worker = rowOf(tree, "Phase one").querySelector("[data-id]")!;
    fireEvent.mouseEnter(worker.parentElement!);
    expect(within(rowOf(tree, "Phase one")).getByRole("tooltip").textContent).toBe("host:7:0");
    expect(within(rowOf(tree, "Phase one")).getByRole("link", { name: "PR #41" }).getAttribute("href")).toBe("https://github.com/o/r/pull/41");
  });

  it("each row is a compact ItemRow with its item's ID only as data-item-id; a held row's second line names what holds it", async () => {
    const tree = await mount();
    const row = rowOf(tree, "Phase two").querySelector<HTMLElement>("[data-item-row]")!;
    expect(row.dataset.itemRow).toBe("compact");
    expect(row.dataset.itemId).toBe("wi_12");
    expect(row.querySelector("[data-row-second]")!.textContent).toBe("Held behind Phase one");
    expect(rowOf(tree, "Phase one").querySelector("[data-row-second]")).toBeNull();
    // The chevron and the indentation stay outside the ItemRow.
    expect(row.querySelector("[slot=chevron]")).toBeNull();
    expect(row.parentElement!.className).toMatch(/\bpl-\d/);
  });

  it("never moves a held item under the item it waits for", () => {
    const nodes = buildTree(ROWS, { state: null, q: "", showClosed: false });
    const phase1 = nodes.flatMap((n) => n.children).find((n) => n.item.id === "wi_11")!;
    expect(phase1.children).toEqual([]);
    expect(nodes.find((n) => n.item.id === "wi_20")!.children).toEqual([]);
  });

  it("the Finished group shows the closed rows", async () => {
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "Finished 3" }));
    await settle();
    expect(titles(screen.getByRole("treegrid", { name: "Work items" }))).toEqual(["Finished split", "Closed alone"]); // the split's done phases sit under it, collapsed
  });

  it("hides closed items and collapses a parent whose phases are all closed to one row; Show closed shows them", async () => {
    const tree = await mount();
    expect(titles(tree)).not.toContain("Closed alone");
    expect(titles(tree)).not.toContain("Done one");
    expect(within(rowOf(tree, "Finished split")).queryByRole("button", { name: /Expand|Collapse/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show closed" }));
    expect(titles(await screen.findByRole("treegrid", { name: "Work items" }))).toContain("Closed alone");
  });

  it("has no summary line; the state filter is five group tabs with the counts, empty ones hidden, and a group's Held tab filters the tree", async () => {
    await mount();
    expect(screen.queryByTestId("summary")).toBeNull();
    expect(screen.queryByText(/rate limit: ok/)).toBeNull();
    const groups = screen.getByRole("tablist", { name: "Filter by state" });
    // No row is failed or stuck: the Problem group is hidden.
    expect(within(groups).getAllByRole("tab").map((t) => t.textContent)).toEqual(["All 0", "Needs you 2", "Active 1", "Waiting 7", "Finished 3"]);
    fireEvent.click(within(groups).getByRole("tab", { name: "Waiting 7" }));
    const states = screen.getByRole("tablist", { name: "Filter Waiting by state" });
    expect(within(states).getAllByRole("tab").map((t) => t.textContent)).toEqual(["All 7", "Needs triage 1", "Held 1", "Blocked by another task 5"]);
    fireEvent.click(within(states).getByRole("tab", { name: "Held 1" }));
    await settle();
    expect(titles(screen.getByRole("treegrid", { name: "Work items" }))).toEqual(["Held by coordination"]);
    expect(within(screen.getByRole("tablist", { name: "Filter Waiting by state" })).getByRole("tab", { name: "Held 1" }).getAttribute("aria-selected")).toBe("true");
    expect(within(groups).getByRole("tab", { name: "Waiting 7" }).getAttribute("aria-selected")).toBe("true");
  });

  it("the Tree and List switch is a segmented control", async () => {
    await mount();
    const view = screen.getByRole("group", { name: "View" });
    expect(within(view).getByRole("button", { name: "Tree" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(view).getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("the Needs you group shows Needs approval and Needs you, never Needs triage or Blocked by another task", async () => {
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: /^Needs you 2/ }));
    await settle();
    const shown = titles(screen.getByRole("treegrid", { name: "Work items" }));
    // The count is the rows the filter shows.
    expect(shown).toEqual(["Spec waiting", "Agent asks"]);
    for (const t of ["Triage asks", "Dependency held", "Held by coordination", "Phase two"]) expect(shown).not.toContain(t);
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
    const second = rowOf(tree, "Phase one").querySelector("[data-id]")!.closest("[class*=basis-full]")!;
    expect(second.className).toContain("basis-full");
    expect(second.className).toContain("sm:basis-auto");
    // Token classes switch themes through CSS variables, so there is no dark: variant; no animation (the ⋯ button's
    // colour fade is motion-safe only).
    expect(tree.innerHTML).not.toMatch(/(?<!motion-safe:)(animate-|transition)/);
  });

  it("has no axe violations", async () => {
    const tree = await mount();
    const result = await axe.run(tree.closest("main") ?? document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
  });
});
