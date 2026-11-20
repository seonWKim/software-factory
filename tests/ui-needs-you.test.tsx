// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";

// The Tasks page's Needs you section (design 09-dashboard-app; the Floor's list of design 09-status-page): one list first, one row per item that waits on the operator,
// with its title, a one-line reason and the buttons that apply now. Items started past a deadlock are never rows and
// never counted (decision 1). Each open alarm is its own row in the Check group: its sentence once, on one line, and a
// "⋯" menu whose items open a dialog on the page (What failed for red main, Show failures for a repeated error); no
// dismiss. A row with no stored reason says the
// item's state and the next step.

const AT = "2026-11-12T00:00:00.000Z";
const cmd = (name: string) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null });
const row = (n: number, level: string, title: string, extra: object = {}) => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title, item_phase: level, reason_code: "person",
   stage: "RUNNING", tier: 2, kind: null, blocked_on: "none", blocked_reason: null, close_reason: null, run_status: null,
  change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 }, ...extra,
});
const deadlocked = (n: number) => row(n, "blocked_by_task", `Overlapping ${n}`, {
  why: { code: "deadlock", reason_code: "deadlock", params: { holder: `Item 9${n}` }, alarms: [], holder_id: null, next_actor: "factory", refs: [90 + n], ref_url: null },
  run: { kind: "implement", status: "running", attempt: 1, worker_id: `mac-mini:4242:${n}`, started_at: AT, position: null },
});
const SPEC = row(30, "needs_approval", "Spec waiting for you", {
  stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", need: { reason: "spec ready", anchor: null },
  commands: ["approve", "reject", "revise"].map(cmd),
});
const ALARM = (n: number) => ({
  code: "alarm", text: `Alarm: ${n}`, command: "Failures page (/app/failures)", until: AT, pattern: "repeated_error", error_code: "checks_failed",
});
const RED_MAIN = (output: { failing_tests: string[]; output_tail: string | null }) => ({
  code: "alarm", text: "Alarm: the base branch fails its checks on its own at `abc`", command: "Fix the base branch", until: AT,
  pattern: "red_main", error_code: "red_main", ...output,
});
const FAILURE_RUN = { id: "run_9", work_item_id: "wi_30", kind: "implement", attempt: 1, detail: "npm test exited 1", worker: null, finished_at: AT };
const FAILURES = {
  as_of: AT, window: "24h", cap: 500, total: 2, capped: false,
  groups: [
    { code: "checks_failed", count: 1, last_seen: AT, items: 1, runs: [FAILURE_RUN] },
    { code: "agent_error", count: 1, last_seen: AT, items: 1, runs: [{ ...FAILURE_RUN, id: "run_8" }] },
  ],
};

let responses: Record<string, unknown>;

beforeEach(() => {
  responses = {
    "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 1, running: 5, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, system_actions: [] },
    "/api/v1/items": { as_of: AT, total: 6, items: [1, 2, 3, 4, 5].map(deadlocked).concat([SPEC]), facets: { allStates: 6, state: {} }, counts: { open: 0, running: 1 } },
    "/api/v1/tasks": { today_date: "2026-11-12", today: { overdue: [], due: [] }, upcoming: [], projects: [], csrf_token: "tok", can_build: true, active_projects: [] },
    "/api/v1/runs": { as_of: AT, runs: [] },
    "/api/v1/queue": { as_of: AT, queue: [] },
    "/api/v1/pauses": { pauses: [], csrf_token: null },
    "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
    "/api/v1/failures": FAILURES,
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
  it("with five items started past a deadlock and one at spec approval, lists only the spec item, first, with its commands in its row's menu", async () => {
    mount();
    const section = await screen.findByRole("region", { name: "Needs you" });
    const rows = [...section.querySelectorAll("li[data-key]")] as HTMLElement[];
    expect(rows.map((r) => r.getAttribute("data-key"))).toEqual(["wi_30"]);
    expect(within(rows[0]!).getByRole("link", { name: "Spec waiting for you" })).toBeTruthy();
    // Its actions sit in its own row's one menu, Approve first (owner feedback 2026-11-20).
    expect(within(rows[0]!).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["More commands"]);
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "More commands" }));
    expect(within(rows[0]!).getAllByRole("menuitem")[0]!.textContent).toBe("Approve");
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

  it("lists each open alarm as its own row in the Check group, counted in the section, with no Open alarms line", async () => {
    for (const n of [1, 2]) {
      (responses["/api/v1/overview"] as { system_actions: unknown[] }).system_actions = Array.from({ length: n }, (_, i) => ALARM(i));
      mount();
      const section = await screen.findByRole("region", { name: "Needs you" });
      const check = await within(section).findByRole("list", { name: "Check" });
      const rows = [...check.querySelectorAll<HTMLElement>('li[data-check="alarm"]')];
      expect(rows.map((r) => r.querySelector("[data-alarm-summary]")!.textContent)).toEqual(Array.from({ length: n }, (_, i) => `Alarm: ${i}`));
      // The spec item and the alarms: the count is the rows.
      expect(section.querySelector("h2")!.nextElementSibling!.textContent).toBe(String(1 + n));
      expect(section.querySelectorAll("li[data-key], li[data-check]")).toHaveLength(1 + n);
      for (const r of rows) {
        // Its one control is the ⋯ menu, whose only item shows its failures; no dismiss control.
        expect(within(r).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["More commands"]);
        fireEvent.click(within(r).getByRole("button", { name: "More commands" }));
        expect(within(r).getAllByRole("menuitem").map((m) => [m.textContent, m.getAttribute("data-action")])).toEqual([["Show failures", "show_failures"]]);
        fireEvent.click(within(r).getByRole("button", { name: "More commands" }));
        expect(r.textContent).not.toMatch(/dismiss|Open on Failures/i);
      }
      expect(document.body.textContent).not.toContain("Open alarms");
      expect(screen.queryByRole("list", { name: "System actions" })).toBeNull();
      cleanup();
    }
  });

  it("an alarm row shows its sentence once, with no Full text toggle; a long text stays on one line, cut with an ellipsis, with the full text as its tooltip, and never widens the page", async () => {
    const long = `Alarm: checks_failed failed 4 runs on several items: ${"npm test exited 1 in packages/very-long-workspace-name/".repeat(5)}${"x".repeat(80)}`;
    expect(long.length).toBeGreaterThan(200);
    (responses["/api/v1/overview"] as { system_actions: unknown[] }).system_actions = [{ ...ALARM(0), text: long }];
    mount();
    const row = (await screen.findByRole("list", { name: "Check" })).querySelector<HTMLElement>('li[data-check="alarm"]')!;
    const summary = row.querySelector<HTMLElement>("[data-alarm-summary]")!;
    expect(summary.textContent).toBe(long);
    expect(summary.className.split(" ")).toContain("truncate");
    expect(summary.getAttribute("title")).toBe(long);
    expect(summary.closest("li > div")!.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-1"]));
    // Decision 2: the sentence is printed once, so there is no toggle that prints it again.
    expect(row.querySelector("details")).toBeNull();
    expect(row.textContent).not.toContain("Full text");
    expect(row.textContent!.split(long)).toHaveLength(2);
    // The row never wraps its menu under the text: the content column shrinks instead.
    expect(row.className.split(" ")).not.toContain("flex-wrap");
    expect(row.lastElementChild!.hasAttribute("data-row-menu")).toBe(true);
  });

  /** The Check group's alarm rows once `actions` load. */
  async function alarmRows(actions: unknown[]): Promise<HTMLElement[]> {
    (responses["/api/v1/overview"] as { system_actions: unknown[] }).system_actions = actions;
    mount();
    const check = await screen.findByRole("list", { name: "Check" });
    return [...check.querySelectorAll<HTMLElement>('li[data-check="alarm"]')];
  }
  /** Chooses `label` in the row's ⋯ menu and returns the dialog it opened. */
  function choose(row: HTMLElement, label: string): HTMLElement {
    fireEvent.click(within(row).getByRole("button", { name: "More commands" }));
    fireEvent.click(within(row).getByRole("menuitem", { name: label }));
    return document.querySelector<HTMLElement>("dialog[data-dialog]")!;
  }

  it("a repeated error's Show failures opens a dialog on the page with that error code's failure group, as Health draws it", async () => {
    const [row] = await alarmRows([ALARM(0)]);
    const dialog = choose(row!, "Show failures");
    expect(within(dialog).getByRole("heading", { name: "Show failures" })).toBeTruthy();
    const groups = await within(dialog).findAllByTestId("failure-group");
    // Only the alarm's own code, not the other group of the window.
    expect(groups).toHaveLength(1);
    expect(dialog.textContent).toContain("1 run");
    expect(groups[0]!.textContent).toContain("Project checks failed");
    expect(within(dialog).getByTestId("failure-code").textContent).toBe("checks_failed");
    // It stays on the Tasks page: no navigation to Health.
    expect(location.pathname).toBe("/app/tasks");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(document.querySelector("dialog[data-dialog]")).toBeNull();
    expect(screen.getByRole("region", { name: "Needs you" })).toBeTruthy();
  });

  it("a red main's What failed lists the failing tests one per line and the output tail in a preformatted block, on the page", async () => {
    const tail = "FAIL tests/a.test.ts > adds\nAssertionError: expected 2 to be 3";
    const [row] = await alarmRows([RED_MAIN({ failing_tests: ["tests/a.test.ts > adds", "tests/b.test.ts > subtracts"], output_tail: tail })]);
    fireEvent.click(within(row!).getByRole("button", { name: "More commands" }));
    expect(within(row!).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["What failed"]);
    fireEvent.click(within(row!).getByRole("button", { name: "More commands" }));
    const dialog = choose(row!, "What failed");
    expect([...dialog.querySelectorAll("[data-failing-tests] li")].map((li) => li.textContent)).toEqual(["tests/a.test.ts > adds", "tests/b.test.ts > subtracts"]);
    const pre = dialog.querySelector("pre[data-output-tail]")!;
    expect(pre.textContent).toBe(tail);
    expect(dialog.textContent).not.toContain("No output kept");
    expect(location.pathname).toBe("/app/tasks");
  });

  it("a red main with no output kept says so in What failed, with no empty block; names kept from a flagged tail still show", async () => {
    const [none, flagged] = await alarmRows([
      RED_MAIN({ failing_tests: [], output_tail: null }),
      { ...RED_MAIN({ failing_tests: ["tests/a.test.ts > adds"], output_tail: null }), text: "Alarm: red main two" },
    ]);
    let dialog = choose(none!, "What failed");
    expect(within(dialog).getByText("No output kept for this check.")).toBeTruthy();
    expect(dialog.querySelector("pre")).toBeNull();
    expect(dialog.querySelector("[data-failing-tests]")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    dialog = choose(flagged!, "What failed");
    expect([...dialog.querySelectorAll("[data-failing-tests] li")].map((li) => li.textContent)).toEqual(["tests/a.test.ts > adds"]);
    expect(within(dialog).getByText("No output kept for this check.")).toBeTruthy();
    expect(dialog.querySelector("pre")).toBeNull();
  });

  it("lists each other system action as one row with its command in the Check group", async () => {
    (responses["/api/v1/overview"] as { system_actions: unknown[] }).system_actions = [
      { code: "migration_pending", text: "Schema at version 3 of 8", command: "Migrate now, or factory migrate", until: null },
      { code: "worker_pause", text: "2 worker pauses in effect (factory workers pause)", command: "factory workers resume", until: null },
    ];
    mount();
    const section = await screen.findByRole("region", { name: "Needs you" });
    const rows = [...within(section).getByRole("list", { name: "Check" }).querySelectorAll<HTMLElement>("li")];
    expect(rows.map((r) => r.dataset.check)).toEqual(["migration_pending", "worker_pause"]);
    expect(rows.map((r) => r.querySelector("code")!.textContent)).toEqual(["Migrate now, or factory migrate", "factory workers resume"]);
    expect(section.querySelector("h2")!.nextElementSibling!.textContent).toBe("3");
  });

  it("the migration row offers Migrate now when a supervisor is live, else says why; its command carries no npm run", async () => {
    const offer = (offered: boolean, reason: string | null = null) => ({ offered, reason });
    const NOT_LIVE = "No factory supervisor is running, so this page cannot reach it. Start the factory from a terminal with factory dev.";
    (responses["/api/v1/overview"] as { system_actions: unknown[] }).system_actions = [
      { code: "migration_pending", text: "Schema at version 3 of 8", command: "Migrate now, or factory migrate", until: null },
    ];
    responses["/api/v1/supervisor"] = { live: true, state: "running", csrf_token: "tok", migrate: offer(true), start: offer(false, "x"), restart: offer(true) };
    mount();
    const row = (await screen.findByRole("region", { name: "Needs you" })).querySelector<HTMLElement>('li[data-check="migration_pending"]')!;
    expect(row.textContent).not.toContain("npm run");
    await within(row).findByRole("button", { name: "Migrate now" });
    expect(within(row).queryByRole("button", { name: "Restart now" })).toBeNull();
    cleanup();
    responses["/api/v1/supervisor"] = { live: false, state: null, csrf_token: "tok", migrate: offer(false, NOT_LIVE), start: offer(false, NOT_LIVE), restart: offer(false, NOT_LIVE) };
    mount();
    const refused = (await screen.findByRole("region", { name: "Needs you" })).querySelector<HTMLElement>('li[data-check="migration_pending"]')!;
    await within(refused).findByText(NOT_LIVE);
    expect(within(refused).queryByRole("button")).toBeNull();
  });
});
