// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";

// The Needs you section of the Tasks page (design 09-dashboard-app), which /app/ opens: its count, compact rows grouped
// Merge, Approve, Answer or fix, one primary action per row with the "⋯" menu last, and j, k, Enter and p on the rows.
// Its count, and the sidebar badge are the same number for the same data: the overview's needs_you
// counts the rows the section lists (design 09-status-page; tests/ui-system-actions.test.ts checks the server's side).

const AT = "2026-11-12T00:00:00.000Z";
const cmd = (name: string) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null });
const WHY = "Please merge wi_5b2b, then /retry this item. Or allow adding web/src/components/ui/input.tsx here with /retry +paths web/src/components/ui/input.tsx.";
const row = (n: string, level: string, title: string, extra: object = {}) => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title, item_phase: level, reason_code: "person",
   stage: "REVIEW", tier: 2, kind: null, blocked_on: "human", blocked_reason: "x", close_reason: null, run_status: null,
  change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 },
  need: { reason: `Reason of ${title}`, anchor: null }, ...extra,
});
const MERGE = row("m1", "ready_to_merge", "Ship the parser", {
  change_ref: "644", change_url: "https://github.com/o/r/pull/644", merge: { enabled: true, reason: null }, merge_check: { state: "mergeable", conflicts: [], head_sha: "a", base_sha: "b", checked_at: AT },
});
const CHECKING = row("m2", "ready_to_merge", "Ship the lexer", { merge: { enabled: true, reason: null }, merge_check: { state: "checking", conflicts: [], head_sha: null, base_sha: null, checked_at: null } });
const APPROVE = row("a1", "needs_approval", "Approve the spec", { commands: ["approve", "reject", "revise"].map(cmd) });
const RETRY = row("r1", "needs_you", "Fix the build", { commands: ["retry", "reject"].map(cmd), need: { reason: WHY, anchor: null } });
const NOTHING = row("n1", "needs_you", "Look at this", { commands: [], need: { reason: "failed: spec_conflict", anchor: null } });
const DEP = row("5b2b", "running", "Add the input component", { blocked_on: "none", need: undefined });

let list: object[];
let overview: Record<string, unknown>;
/** The Tasks read's projects (the open tasks and their work items). */
let projects: object[];
let posts: { url: string; body: unknown }[];

beforeEach(() => {
  list = [MERGE, CHECKING, APPROVE, RETRY, NOTHING, DEP];
  projects = [];
  overview = { as_of: AT, stages: {}, needs_you: 5, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, system_actions: [], factory: { state: "running", rev: "0ff810f1234", target_rev: "0ff810f1234", child_pid: 1, since: AT, workers: 1, workers_source: "default", error: null, pending: [] } };
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ seq: 1 }), { status: 202 });
    }
    const bodies: Record<string, unknown> = {
      "/api/v1/overview": overview,
      "/api/v1/items": { as_of: AT, total: list.length, items: list, facets: { allStates: list.length, state: {} }, counts: { open: 0, running: 1 } },
      "/api/v1/tasks": { today_date: "2026-11-12", today: { overdue: [], due: [] }, upcoming: [], projects, csrf_token: "tok", can_build: true, active_projects: [] },
      "/api/v1/pauses": { pauses: [], csrf_token: null },
      "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
    };
    const body = bodies[url.split("?")[0]!];
    if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.stubGlobal("scrollTo", () => undefined);
  vi.stubGlobal("innerWidth", 1280);
  history.replaceState(null, "", "/app/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}
const rowsOf = (el: HTMLElement) => [...el.querySelectorAll("li[data-key]")] as HTMLElement[];
const ready = async () => {
  const section = await screen.findByRole("region", { name: "Needs you" });
  // The rows' commands are on once the session is read.
  await waitFor(() => expect(within(section).queryAllByRole("button", { name: "Merge" }).some((b) => !b.disabled) || list.length === 0).toBe(true));
  return [...section.querySelectorAll("ul")] as HTMLElement[];
};

describe("the Needs you section", () => {
  it("leads from /app/ to the Tasks page, with the count and the groups Merge, Approve, Answer or fix in that order", async () => {
    mount();
    const lists = await ready();
    expect(location.pathname).toBe("/app/tasks");
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Tasks"]);
    const section = screen.getByRole("region", { name: "Needs you" });
    expect(section.querySelector("h2 + span")!.textContent).toBe("5");
    expect(lists.map((l) => l.getAttribute("aria-label"))).toEqual(["Merge", "Approve", "Answer or fix"]);
    expect(lists.map((l) => rowsOf(l).map((r) => r.getAttribute("data-key")))).toEqual([["wi_m1", "wi_m2"], ["wi_a1"], ["wi_r1", "wi_n1"]]);
    cleanup();
    list = [];
    mount();
    await screen.findByRole("heading", { name: "Tasks" });
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });

  it("shows a Notice only when the factory is stopped, paused or failing", async () => {
    mount();
    await ready();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("factory-status")).toBeNull();
    cleanup();
    overview.factory = null;
    mount();
    await ready();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Factory stopped");
  });

  it("shows a compact row per item without a table: title, a PR as a muted number, the state once, and no Issue", async () => {
    list = [{ ...MERGE, issue: { number: 12, url: "https://github.com/o/r/issues/12" } }, APPROVE];
    mount();
    const [first] = await ready();
    expect(document.querySelector("main table")).toBeNull();
    const merge = rowsOf(first!)[0]!;
    expect(within(merge).getByRole("link", { name: "Ship the parser" })).toBeTruthy();
    expect(merge.textContent).toContain("#644");
    expect(merge.textContent).not.toContain("#12");
  });

  it("gives every row one primary action with the ⋯ menu last, in the same place", async () => {
    mount();
    const lists = await ready();
    const labels = lists.flatMap(rowsOf).map((r) => {
      const controls = [...r.querySelectorAll("button, a[data-command]")].filter((c) => !c.closest("[role=menu]"));
      expect(controls.at(-1)!.getAttribute("aria-label"), r.getAttribute("data-key")).toBe("More commands");
      expect(controls, r.getAttribute("data-key")).toHaveLength(2);
      return controls[0]!.textContent;
    });
    expect(labels).toEqual(["Merge", "Checking…", "Approve", "Retry", "Open"]);
  });

  it("disables Merge as 'Checking…' while the merge check runs, with no separate line or duplicate text", async () => {
    mount();
    const lists = await ready();
    const checking = rowsOf(lists[0]!)[1]!;
    const button = within(checking).getByRole("button", { name: "Checking…" });
    expect(button.disabled).toBe(true);
    expect(checking.textContent!.match(/Checking…/g)).toHaveLength(1);
    expect(checking.textContent).not.toContain("merge check running");
    expect(within(rowsOf(lists[0]!)[0]!).getByRole("button", { name: "Merge" }).disabled).toBe(false);
  });

  it("shows an Answer-or-fix reason as plain text, with the +paths reply in the menu and /retry sent from it", async () => {
    mount();
    const lists = await ready();
    const row = rowsOf(lists[2]!)[0]!;
    expect(row.querySelector("[data-need]")!.textContent).toBe(WHY);
    fireEvent.click(within(row).getByRole("button", { name: "More commands" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Allow input.tsx and retry" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/api/v1/items/wi_r1/commands", body: { command: "retry", note: "+paths web/src/components/ui/input.tsx" } });
  });

  it("shows a reason that is only a status code as a chip beside the badge, not as a line under it", async () => {
    mount();
    const lists = await ready();
    const row = rowsOf(lists[2]!)[1]!;
    const need = row.querySelector<HTMLElement>("[data-need]")!;
    expect(need.tagName).toBe("SPAN");
    expect(need.querySelector("[data-level], span")!.textContent).toBe("failed: spec_conflict");
    expect(row.querySelector("p[data-need]")).toBeNull();
    // A sentence stays a line.
    expect(rowsOf(lists[2]!)[0]!.querySelector("[data-need]")!.tagName).toBe("P");
  });

  it("moves between rows with j and k, opens the item with Enter, presses the primary action with p (never Merge)", async () => {
    mount();
    const lists = await ready();
    const rows = lists.flatMap(rowsOf);
    const selected = () => rows.filter((r) => r.dataset.selected === "true").map((r) => r.getAttribute("data-key"));
    fireEvent.keyDown(document.body, { key: "j" });
    expect(selected()).toEqual(["wi_m1"]);
    fireEvent.keyDown(document.body, { key: "p" });
    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "j" });
    expect(selected()).toEqual(["wi_a1"]);
    fireEvent.keyDown(document.body, { key: "k" });
    fireEvent.keyDown(document.body, { key: "j" });
    await Promise.resolve();
    expect(posts).toEqual([]);
    fireEvent.keyDown(document.body, { key: "p" });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/api/v1/items/wi_a1/commands", body: { command: "approve" } });
    fireEvent.keyDown(document.body, { key: "Enter" });
    await waitFor(() => expect(location.pathname).toBe("/app/items/wi_a1"));
  });

  it("shows the primary action's shortcut in its tooltip, and none on Merge", async () => {
    mount();
    const lists = await ready();
    fireEvent.focus(within(rowsOf(lists[1]!)[0]!).getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("tooltip").textContent).toBe("Approve (p)");
    cleanup();
    mount();
    const [merge] = await ready();
    expect(merge!.querySelector("[data-shortcut]")).toBeNull();
  });
});

describe("the Needs you count is its rows (design 09-status-page)", () => {
  const ALARM = (n: number) => ({ code: "alarm", text: `Alarm: checks_failed failed ${n} runs on several items`, command: "Failures page (/app/failures)", until: AT });
  const STUCK = row("s1", "stuck", "Nobody moves this", { blocked_on: "none", stage: "RUNNING", need: undefined });

  /** Mounts the app on the overview's `needs_you` and `checks` and the items `items`; reads the section and the two numbers. */
  async function numbers(needs_you: number, items: object[], checks: object[]) {
    overview = { ...overview, needs_you, system_actions: checks };
    list = items;
    mount();
    const badgeEl = await waitFor(() => {
      const el = document.querySelector('aside a[href="/app/tasks"] span.ml-auto');
      if (!el) throw new Error("no badge yet");
      return el;
    });
    const badge = badgeEl.textContent;
    const section = await screen.findByRole("region", { name: "Needs you" });
    const rows = [...section.querySelectorAll<HTMLElement>("li[data-key], li[data-check]")];
    return { rows, count: Number(section.querySelector("h2 + span")!.textContent), badge: Number(badge) };
  }

  it("one waiting item and one open alarm: 2 rows (the alarm under Check), 2 on the badge", async () => {
    const n = await numbers(2, [MERGE], [ALARM(4)]);
    expect([n.rows.length, n.count, n.badge]).toEqual([2, 2, 2]);
    const check = within(screen.getByRole("region", { name: "Needs you" })).getByRole("list", { name: "Check" });
    expect([...check.querySelectorAll("li")].map((r) => r.getAttribute("data-check"))).toEqual(["alarm"]);
  });

  it("waiting items only, one on an open task's row: each a row; a stuck item is none", async () => {
    projects = [{ list: null, tasks: [{ id: "tk_1", title: "Ship", list: null, priority: null, due_date: null, due_time: null, recurrence: null, work_item_id: MERGE.id }] }];
    const n = await numbers(3, [MERGE, APPROVE, RETRY, STUCK], []);
    expect([n.rows.length, n.count, n.badge]).toEqual([3, 3, 3]);
    expect(n.rows.map((r) => r.dataset.key)).toEqual([MERGE.id, APPROVE.id, RETRY.id]);
  });

  it("each open alarm is its own row: two alarms give 2", async () => {
    const n = await numbers(2, [], [ALARM(4), ALARM(5)]);
    expect([n.rows.length, n.count, n.badge]).toEqual([2, 2, 2]);
    expect(n.rows.map((r) => r.dataset.check)).toEqual(["alarm", "alarm"]);
  });

  it("a non-alarm system action is one row with its command, beside an item and an alarm", async () => {
    const pause = { code: "worker_pause", text: "1 worker pause in effect (factory workers pause)", command: "factory workers resume", until: null };
    const n = await numbers(3, [MERGE], [pause, ALARM(4)]);
    expect([n.rows.length, n.count, n.badge]).toEqual([3, 3, 3]);
    expect(n.rows.find((r) => r.dataset.check === "worker_pause")!.querySelector("code")!.textContent).toBe("factory workers resume");
  });
});
