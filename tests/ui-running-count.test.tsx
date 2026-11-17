// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { API } from "../web/src/api.js";
import { ActivityPage, ItemsPage } from "../web/src/views/pages.js";

// Work's Running chip and Activity's Running now both count runs whose status is running (the server's
// `counts.running`, which the overview's `running` repeats), never items by level: the same data gives one number.

const AT = "2026-11-07T00:00:00.000Z";
const row = (n: number) => ({
  id: `wi_${n}`, source: { type: "local", id: `local-${n}`, link: null }, title: `Item ${n}`, item_phase: "queued", reason_code: null,
  stage: "RUNNING", tier: 2, kind: null, blocked_on: "none", blocked_reason: null, close_reason: null, run_status: null,
  change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 },
});
const run = (n: number, status = "running") => ({ id: `run_${n}`, status, kind: "implement", work_item_id: `wi_${n}`, attempt: 1, owner: "h:1:0", heartbeat_at: AT, started_at: AT, lease_expires_at: AT, created_at: AT });
const rows = [1, 2, 3].map(row);
// No row is at level running, while three runs are running.
const items = { as_of: AT, total: 3, items: rows, facets: { allStates: 3, state: { queued: 3 } }, counts: { open: 3, running: 3 } };
const overview = { as_of: AT, stages: { RUNNING: 3 }, needs_you: 0, open: 3, running: 3, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } };

function client() {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchInterval: false } } });
  c.setQueryData([API.items], items);
  c.setQueryData([`${API.items}?closed=1`], items);
  c.setQueryData([API.overview], overview);
  c.setQueryData([API.runs], { as_of: AT, runs: [run(1), run(2), run(3), run(4, "succeeded")] });
  c.setQueryData([API.queue], { as_of: AT, queue: [] });
  c.setQueryData([API.pauses], { pauses: [] });
  return c;
}

afterEach(cleanup);

describe("the running count on Work and Activity", () => {
  it("is the same number of running runs on both pages, in the tree and in the list", () => {
    const c = client();
    render(<QueryClientProvider client={c}><ActivityPage /></QueryClientProvider>);
    const section = screen.getByRole("region", { name: "Running now" });
    expect(within(section).getByRole("heading", { name: "Running now" }).parentElement.textContent).toBe("Running now3");
    cleanup();
    render(<QueryClientProvider client={c}><ItemsPage /></QueryClientProvider>);
    expect(screen.getByText("Running 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByText("Running 3")).toBeTruthy();
  });
});
