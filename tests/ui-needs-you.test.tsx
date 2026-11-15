// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";

// The Tasks page's Needs you section (design 09-dashboard-app; the Floor's list of design 09-status-page): one list first, one row per item that waits on the operator,
// with its title, a one-line reason and the buttons that apply now. Items started past a deadlock are one summary
// line under the list that links to Work items, never rows and never counted (decision 1); the open alarms are one
// line that links to Failures, however many. A row with no stored reason says the item's state and the next step.

const AT = "2026-11-12T00:00:00.000Z";
const cmd = (name: string) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null });
const row = (n: number, level: string, title: string, extra: object = {}) => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title, level,
  badges: [], stage: "RUNNING", tier: 2, kind: null, blocked_on: "none", blocked_reason: null, close_reason: null, run_status: null,
  change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 }, ...extra,
});
const deadlocked = (n: number) => row(n, "blocked_by_task", `Overlapping ${n}`, {
  why: { code: "deadlock", text: `Started past a deadlock with #9${n}: a person checks the overlap`, next_actor: "factory", refs: [90 + n], ref_url: null },
  run: { kind: "implement", status: "running", attempt: 1, worker_id: `mac-mini:4242:${n}`, started_at: AT, position: null },
});
const SPEC = row(30, "needs_approval", "Spec waiting for you", {
  stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", need: { reason: "spec ready", anchor: null },
  commands: ["approve", "reject", "revise"].map(cmd),
});
const ALARM = (n: number) => ({ code: "alarm", text: `Alarm: ${n}`, command: "Failures page (/app/failures)", until: AT });

let responses: Record<string, unknown>;

beforeEach(() => {
  responses = {
    "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 1, running: 5, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, system_actions: [] },
    "/api/v1/items": { as_of: AT, total: 6, items: [1, 2, 3, 4, 5].map(deadlocked).concat([SPEC]), facets: { allStates: 6, state: {} } },
    "/api/v1/tasks": { today_date: "2026-11-12", today: { overdue: [], due: [] }, upcoming: [], projects: [], csrf_token: "tok", can_build: true, active_projects: [] },
    "/api/v1/runs": { as_of: AT, runs: [] },
    "/api/v1/queue": { as_of: AT, queue: [] },
    "/api/v1/pauses": { pauses: [], csrf_token: null },
    "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = responses[url.split("?")[0]!];
    if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.stubGlobal("scrollTo", () => undefined);
  // The laptop window the Floor must fit: 1024 × 700.
  vi.stubGlobal("innerWidth", 1024);
  vi.stubGlobal("innerHeight", 700);
  history.replaceState(null, "", "/app/tasks");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

describe("Needs you on the Tasks page", () => {
  it("with five items started past a deadlock and one at spec approval, lists only the spec item, first, with its buttons in its row", async () => {
    mount();
    const section = await screen.findByRole("region", { name: "Needs you" });
    const rows = [...section.querySelectorAll("li[data-key]")] as HTMLElement[];
    expect(rows.map((r) => r.getAttribute("data-key"))).toEqual(["wi_30"]);
    expect(within(rows[0]!).getByRole("link", { name: "Spec waiting for you" })).toBeTruthy();
    // Its actions sit in its own row: the primary Approve and the menu with the others.
    expect(within(rows[0]!).getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(within(rows[0]!).getByRole("button", { name: "More commands" })).toBeTruthy();
    // The page's one h1 is its header; the section shows its count and the group inside it.
    const main = document.querySelector("main")!;
    expect(main.querySelectorAll("h1")).toHaveLength(1);
    expect(within(section).getByRole("list", { name: "Approve" })).toBeTruthy();
    expect(section.querySelector("h2")!.nextElementSibling!.textContent).toBe("1");
    // Items started past a deadlock go on by themselves: no row, no count and no line.
    expect(document.querySelector("[data-deadlocks]")).toBeNull();
    expect(document.body.textContent).not.toMatch(/deadlock/i);
    for (const n of [1, 2, 3, 4, 5]) expect(section.textContent).not.toContain(`Overlapping ${n}`);
  });

  it("shows the open alarms as one line that links to Failures, whatever their number", async () => {
    for (const n of [1, 4]) {
      (responses["/api/v1/overview"] as { system_actions: unknown[] }).system_actions = Array.from({ length: n }, (_, i) => ALARM(i));
      mount();
      const notes = await screen.findByRole("list", { name: "System actions" });
      const alarms = notes.querySelectorAll('[data-action="alarm"]');
      expect(alarms).toHaveLength(1);
      expect(alarms[0]!.textContent).toContain(`Open alarms: ${n}.`);
      expect(within(alarms[0] as HTMLElement).getByRole("link").getAttribute("href")).toBe("/app/failures");
      // One line: no alarm text or command of its own.
      expect(notes.textContent).not.toContain("Alarm: 0");
      cleanup();
    }
  });
});
