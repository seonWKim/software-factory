// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The Work page's Coordinator card (design 09-dashboard-system): above the work list, its switch (a press sets the
// `coordinator` setting through POST /api/v1/settings; a refusal shows under the card), its current
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
/** What POST /api/v1/settings answers: a set stores the value (the next coordinator read shows it), a refusal does not. */
let refusal: string | null;
let writes: { body: unknown; token: string | null }[];
beforeEach(() => {
  answer = status();
  refusal = null;
  writes = [];
  history.replaceState(null, "", "/app/items");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    if (path === "/api/v1/settings" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { key: string; value: string };
      writes.push({ body, token: new Headers(init.headers).get("x-csrf-token") });
      if (refusal !== null) return new Response(JSON.stringify({ error: refusal }), { status: 403, headers: { "content-type": "application/json" } });
      const on = body.value === "true";
      answer = status({ on, next_check_at: on ? null : NEXT, actions: [] });
      return json({ ok: true, lines: [`coordinator = ${body.value}`] });
    }
    if (path === "/api/v1/session") return json({ as_of: "2026-11-27T09:05:00.000Z", csrf_token: "tok", commands_enabled: true, actor: "owner", actor_source: "config" });
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

  it("shows the off state: no next check and no actions", async () => {
    answer = status({ on: false, next_check_at: null, actions: [] });
    const c = await card();
    const sw = await within(c).findByRole("switch", { name: "Coordinator on" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.getAttribute("aria-readonly")).toBeNull();
    expect(within(c).getByText("Off: it starts no check.")).toBeTruthy();
    expect(within(c).queryByText(/^Next check/)).toBeNull();
    expect(within(c).getByText("No actions yet")).toBeTruthy();
  });

  it("turns the coordinator on with one press: one settings write of coordinator=true, then the card reads it again", async () => {
    answer = status({ on: false, next_check_at: null, actions: [] });
    const c = await card();
    await within(c).findByText("Off: it starts no check.");
    fireEvent.click(within(c).getByRole("switch", { name: "Coordinator on" }));
    expect(await within(c).findByText("On: waiting for its first check.")).toBeTruthy();
    expect(writes.map((w) => w.body)).toEqual([{ action: "set", key: "coordinator", value: "true" }]);
    expect(writes[0]!.token).toBe("tok");
    expect(within(c).getByRole("switch", { name: "Coordinator on" }).getAttribute("aria-checked")).toBe("true");
  });

  it("turns it off with coordinator=false", async () => {
    const c = await card();
    await within(c).findByText("On: checking the work items.");
    fireEvent.click(within(c).getByRole("switch", { name: "Coordinator on" }));
    expect(await within(c).findByText("Off: it starts no check.")).toBeTruthy();
    expect(writes.map((w) => w.body)).toEqual([{ action: "set", key: "coordinator", value: "false" }]);
  });

  it("shows a refusal under the card and keeps the switch at its stored value", async () => {
    answer = status({ on: false, next_check_at: null, actions: [] });
    refusal = "Only the owner can change coordinator.";
    const c = await card();
    await within(c).findByText("Off: it starts no check.");
    const sw = within(c).getByRole("switch", { name: "Coordinator on" });
    fireEvent.click(sw);
    expect((await within(c).findByRole("alert")).textContent).toBe("Only the owner can change coordinator.");
    expect(writes).toHaveLength(1);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(within(c).getByText("Off: it starts no check.")).toBeTruthy();
    expect((sw as HTMLButtonElement).disabled).toBe(false);
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
