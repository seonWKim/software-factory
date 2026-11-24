// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { runKindLabel, tryOf } from "../web/src/views/common.js";

// A step shows its catalog name ("Triage", "Merge check"), never its stored kind, and a try is counted from 1: a
// queued run is stored as attempt 0 until it is claimed.

const AT = "2026-11-07T00:00:00.000Z";
const BAD = [/\btriage\b/, /merge-check/i, /#0\b|attempt 0/];
const noStored = (text: string) => { for (const re of BAD) expect(text).not.toMatch(re); };

const why = { code: "human", reason_code: "person", params: { reason: "Waiting" }, alarms: [], holder_id: null, next_actor: "factory", refs: [], ref_url: null };
const item = (id: string, n: number, title: string, run: object | null) => ({
  id, source: { type: "local", id: `l${n}`, link: null }, title, item_phase: "queued", reason_code: "person", stage: "RUNNING", tier: 2, kind: null,
  blocked_on: "none", blocked_reason: null, close_reason: null, run_status: null, change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1,
  dependents: 0, conflicts: { automatic: 0, person: 0 }, parent_id: null, phase: null, run, claim: null, waiting_on_number: null, why,
});
const queuedRun = (kind: string) => ({ kind, status: "queued", attempt: 0, worker_id: null, started_at: null, position: 1 });
const ROWS = [item("wi_1", 1, "Triage item", queuedRun("triage")), item("wi_2", 2, "Merge item", queuedRun("merge-check"))];
const run = (id: string, kind: string) => ({ id, kind, status: "queued", attempt: 0, started_at: null, finished_at: null, created_at: AT, tokens: 0, error: null, attempts: [] });
const detail = {
  as_of: AT,
  item: { ...ROWS[0], run: undefined },
  timeline: [],
  runs: [run("run_t", "triage"), run("run_m", "merge-check")],
  transcripts: {},
  current_run: { ...run("run_t", "triage"), kind: "triage" },
};
const overview = { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 2, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, unreviewed_merges_7d: 0, plugins: { issues: null } };
const transcriptPage = { run: { id: "run_m", kind: "merge-check", status: "queued", attempt: 0, worker_id: null }, parts: [""], part: "", steps: [], next: null, earlier: false };

beforeEach(() => {
  if (!globalThis.CSS?.escape) vi.stubGlobal("CSS", { escape: (v: string) => v.replace(/[^\w-]/g, "\\$&") });
  vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
    const path = raw.split("?")[0];
    const body = path === "/api/v1/items" ? { as_of: AT, total: 2, items: ROWS, facets: { allStates: 2, state: {} }, counts: { open: 0, running: 0 } }
      : path === "/api/v1/overview" ? overview
      : path === "/api/v1/pauses" ? { as_of: AT, csrf_token: null, pauses: [] }
      : path === "/api/v1/queue" ? { as_of: AT, queue: [{ position: 1, id: "run_t", kind: "triage", work_item_id: "wi_1", attempt: 0, created_at: AT, not_before: null }] }
      : path === "/api/v1/items/wi_1" ? detail
      : path.endsWith("/transcript") ? transcriptPage
      : undefined;
    return new Response(JSON.stringify(body ?? { error: "Not found." }), { status: body ? 200 : 404 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(path: string) {
  history.replaceState(null, "", path);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
}

describe("step names and tries", () => {
  it("names every kind from the catalog, an unknown kind Other, and counts a try from 1", () => {
    expect(runKindLabel("merge-check")).toBe("Merge check");
    expect(runKindLabel("triage")).toBe("Triage");
    expect(runKindLabel("future-kind")).toBe("Other");
    expect(runKindLabel("toString")).toBe("Other");
    expect(tryOf(0)).toBe(1);
    expect(tryOf(3)).toBe(3);
  });

  it("Work: a queued triage run and a merge-check run read Triage #1 and Merge check #1", async () => {
    mount("/app/items");
    const tree = await screen.findByRole("treegrid", { name: "Work items" });
    await waitFor(() => expect(tree.textContent).toContain("Merge check #1"));
    expect(tree.textContent).toContain("Triage #1");
    noStored(tree.textContent);
  });

  it("the item page: Current run and Runs show Triage and Merge check, tries from 1", async () => {
    mount("/app/items/wi_1");
    const table = await screen.findByRole("table", { name: "Runs" });
    expect(table.textContent).toContain("Triage #1");
    expect(table.textContent).toContain("Merge check #1");
    noStored(document.body.textContent);
  });

  it("a transcript title names the step and its try", async () => {
    mount("/app/items/wi_1/runs/run_m");
    const title = () => screen.getByRole("heading", { level: 1 });
    await waitFor(() => expect(title().textContent).toContain("Merge check"));
    expect(title().textContent).toContain("try 1");
    noStored(document.body.textContent);
  });
});
