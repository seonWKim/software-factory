// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { transcript } from "../src/ui/transcript.js";
import { runKindLabel, tryOf } from "../web/src/views/common.js";

// Step names and tries (design-system/writing.md): a run kind reads as its catalog name ("Triage", "Merge check"), and a
// try counts from 1 although a queued run is stored as attempt 0. Work, the item page and a transcript title agree.

const AT = "2026-11-07T00:00:00.000Z";
const BAD = [/\btriage\b/, /merge-check/i, /#0\b|attempt 0/];
const ITEM = "wi_1";
const RUN_TRIAGE = "run_triage";
const RUN_MERGE = "run_merge";

const queuedRun = (kind: string, position: number) => ({ kind, status: "queued", attempt: 0, worker_id: null, started_at: null, position });
const why = { code: "queued", reason_code: "Waiting", params: {}, alarms: [], holder_id: null, next_actor: "factory", refs: [], ref_url: null };
const itemRow = (id: string, title: string, run: object) => ({
  id, source: { type: "local", id: `local#${id}`, link: null }, title, item_phase: "queued", reason_code: "queued", stage: "READY", tier: 2, kind: null,
  blocked_on: "none", blocked_reason: null, close_reason: null, run_status: "queued", change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1,
  dependents: 0, conflicts: { automatic: 0, person: 0 }, parent_id: null, phase: null, run, claim: null, waiting_on_number: null, why,
});
const items = { as_of: AT, total: 2, items: [itemRow(ITEM, "Export spend", queuedRun("triage", 1)), itemRow("wi_2", "Check merge", queuedRun("merge-check", 2))], facets: { allStates: 2, state: {} }, counts: { open: 2, running: 0 } };
const runRow = (id: string, kind: string) => ({ id, kind, status: "queued", attempt: 0, started_at: null, finished_at: null, created_at: AT, tokens: 0, error: null, attempts: [] });
const detail = {
  as_of: AT,
  item: { id: ITEM, source: { type: "local", id: "local#1", link: null }, title: "Export spend", stage: "READY", close_reason: null, blocked_on: "none", blocked_reason: null, tier: 1, loop_count: 0, restart_count: 0, token_cost: 0, change_ref: null, change_url: null, version: 1, created_at: AT, updated_at: AT, why },
  timeline: [],
  runs: [runRow(RUN_TRIAGE, "triage"), runRow(RUN_MERGE, "merge-check")],
  transcripts: {},
};
const fakeStore = {
  async listRuns() {
    return detail.runs.map((r) => ({ id: r.id, work_item_id: ITEM, kind: r.kind, status: "queued", attempt: 0, started_at: null, finished_at: null, lease: null, outcome: null }));
  },
  async listRunAttempts() {
    return [];
  },
};
const storage = { async put() {}, async get() { return null; }, async list() { return []; }, async delete() {}, async getRange() { return null; } };
const scanner = new PatternEgressScanner(async () => []);

beforeEach(() => {
  if (!globalThis.CSS?.escape) vi.stubGlobal("CSS", { escape: (v: string) => v.replace(/[^\w-]/g, "\\$&") });
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => "visible");
  vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
    const url = new URL(raw, "http://127.0.0.1");
    let value: unknown;
    let status = 200;
    const m = /^\/api\/v1\/items\/([^/]+)\/runs\/([^/]+)\/transcript$/.exec(url.pathname);
    if (m) {
      const r = await transcript({ store: fakeStore, scanner, storage }, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!), url.searchParams);
      status = r.status;
      value = r.value;
    } else if (url.pathname === "/api/v1/items") value = items;
    else if (url.pathname === `/api/v1/items/${ITEM}`) value = detail;
    else if (url.pathname === "/api/v1/overview") value = { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 2, last_24h: { succeeded: 0, failed: 0, tokens: 0 } };
    else if (url.pathname === "/api/v1/pauses") value = { as_of: AT, csrf_token: null, pauses: [] };
    else if (url.pathname === "/api/v1/queue") value = { as_of: AT, queue: [{ position: 1, id: RUN_TRIAGE, kind: "triage", work_item_id: ITEM, attempt: 0, created_at: AT, not_before: null }] };
    else {
      value = { error: "Not found." };
      status = 404;
    }
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(path: string) {
  history.replaceState(null, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}
const expectClean = (text: string) => {
  for (const re of BAD) expect(text, String(re)).not.toMatch(re);
};

describe("step names and tries", () => {
  it("maps every kind to a catalog name, an unknown kind to Other, and a try to at least 1", () => {
    expect(runKindLabel("triage")).toBe("Triage");
    expect(runKindLabel("merge-check")).toBe("Merge check");
    expect(runKindLabel("interactive")).toBe("Interactive task");
    expect(runKindLabel("toString")).toBe("Other");
    expect(runKindLabel("brand-new")).toBe("Other");
    expect(tryOf(0)).toBe(1);
    expect(tryOf(3)).toBe(3);
  });

  it("Work shows queued runs as Triage and Merge check, try 1", async () => {
    mount("/app/items");
    const tree = await screen.findByRole("treegrid", { name: "Work items" });
    expect(tree.textContent).toContain("Triage #1");
    expect(tree.textContent).toContain("Merge check #1");
    expectClean(tree.textContent);
  });

  it("the item page shows Current run and Runs with names and try 1", async () => {
    const view = mount(`/app/items/${ITEM}`);
    const runs = await screen.findByRole("table", { name: "Runs" });
    expect(runs.textContent).toContain("Triage #1");
    expect(runs.textContent).toContain("Merge check #1");
    await act(async () => {});
    expect(view.container.textContent).toContain("try 1");
    expectClean(view.container.textContent);
  });

  it("a transcript title names the step and counts the try from 1", async () => {
    for (const [id, name] of [[RUN_TRIAGE, "Triage"], [RUN_MERGE, "Merge check"]]) {
      mount(`/app/items/${ITEM}/runs/${id}`);
      const title = await screen.findByRole("heading", { level: 1, name: new RegExp(name) });
      expect(title.textContent).toContain("try 1");
      expectClean(document.body.textContent);
      cleanup();
    }
  });
});
