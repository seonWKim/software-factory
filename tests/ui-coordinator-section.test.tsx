// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The Work page's Coordinator card (design 09-dashboard-system): above the work list, its switch (read-only), its current
// activity, the next check and the recent actions with outcome, reason and a transcript entry in the row menu. Every read
// is a fake fetch; no model and no remote service is called.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A variable path keeps the view's JSX out of the test type check, as the evals page test does.
const VIEW_MODULE = "../web/src/views/pages.js";
const { ItemsPage } = (await import(/* @vite-ignore */ VIEW_MODULE)) as { ItemsPage: FunctionComponent };

const NEXT = "2099-01-01T00:15:00.000Z";
const ACTION = { cycle_id: "cyc_1", work_item_id: "wi_1", at: "2026-11-27T09:00:00.000Z" };
const status = (over: Record<string, unknown> = {}) => ({
  as_of: "2026-11-27T09:05:00.000Z", on: true, next_check_at: NEXT,
  actions: [
    { ...ACTION, seq: 2, command: "approve", outcome: "refused", reason: "tier 3 is above the limit", transcript: null },
    { ...ACTION, seq: 1, command: "merge", outcome: "requested", reason: "checks passed", transcript: "transcripts/coordinator/cyc_1.json" },
  ],
  ...over,
});
const EMPTY_LIST = { items: [], counts: { open: 0, running: 0 }, facets: { state: {}, allStates: 0 }, as_of: "2026-11-27T09:05:00.000Z" };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

let answer: unknown;
beforeEach(() => {
  answer = status();
  history.replaceState(null, "", "/app/items");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = url.split("?")[0]!;
    if (path === "/api/v1/coordinator") return json(answer);
    if (path === "/api/v1/items") return json(EMPTY_LIST);
    return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function card() {
  render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ItemsPage)));
  return await screen.findByRole("region", { name: "Coordinator" });
}
const rows = (c: HTMLElement) => [...c.querySelectorAll("[data-coordinator-action]")] as HTMLElement[];

describe("the Coordinator card", () => {
  it("sits above the work list, which follows it", async () => {
    const c = await card();
    const list = await screen.findByText("No work item yet");
    expect(c.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the activity, the 15-minute interval, the next check and the actions newest first", async () => {
    const c = await card();
    expect(await within(c).findByText("On: checking the work items.")).toBeTruthy();
    expect(within(c).getByText("Checks every 15 minutes.")).toBeTruthy();
    expect(within(c).getByText(/^Next check in /)).toBeTruthy();
    expect(rows(c).map((r) => r.getAttribute("data-coordinator-action"))).toEqual(["cyc_1:2", "cyc_1:1"]);
  });

  it("shows each action's outcome and reason, and a transcript entry in the menu only when one is stored", async () => {
    const c = await card();
    await within(c).findByText("Refused");
    const [refused, requested] = rows(c);
    expect(within(refused!).getByText("tier 3 is above the limit")).toBeTruthy();
    expect(within(refused!).queryByRole("button", { name: /Actions for/ })).toBeNull();
    expect(within(requested!).getByText("Requested")).toBeTruthy();
    expect(within(requested!).getByText("checks passed")).toBeTruthy();
    fireEvent.click(within(requested!).getByRole("button", { name: "Actions for merge" }));
    expect(await screen.findByRole("menuitem", { name: "Copy transcript link" })).toBeTruthy();
  });

  it("shows the switch read-only, with the text that it changes with factory settings set coordinator", async () => {
    answer = status({ on: false, next_check_at: null, actions: [] });
    const c = await card();
    const sw = await within(c).findByRole("switch", { name: "Coordinator on" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.getAttribute("aria-readonly")).toBe("true");
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(within(c).getByText("Changes with factory settings set coordinator.")).toBeTruthy();
    expect(within(c).getByText("Off: it starts no check.")).toBeTruthy();
    expect(within(c).queryByText(/^Next check/)).toBeNull();
    expect(within(c).getByText("No actions yet")).toBeTruthy();
  });

  it("draws only shared components: no raw control and no English text in the view", () => {
    const src = readFileSync(join(import.meta.dirname, "../web/src/views/coordinator-card.tsx"), "utf8");
    expect(src).not.toMatch(/<(button|input|select|textarea|table|h[1-6])\b/);
    for (const name of ["Card", "ListRow", "Switch", "Badge", "EmptyState", "OverflowMenu"]) expect(src).toContain(`<${name}`);
    expect(src).not.toMatch(/>\s*[A-Z][a-z]+ [a-z]+[^<{]*</);
    // The list box is the shared LIST_BOX (its phone border handling), not a hand-written copy of its classes.
    expect(src).toContain("LIST_BOX");
    expect(src).not.toMatch(/className="[^"]*\bborder border-border/);
  });
});
