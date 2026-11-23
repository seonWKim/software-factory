// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";

// The Needs you section of the Tasks page (design 09-dashboard-app), which /app/ opens: its count, compact rows grouped
// Merge, Approve, Answer or fix, every action in the row's "⋯" menu with the primary first, and j, k, Enter and p on the rows.
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
/** `/api/v1/items/:id` reads by item ID (a ready merge row reads its item for why its last Merge went back). */
let details: Record<string, unknown>;
/** The pauses read's CSRF token (null: no pause routes, so no Resume now or Dismiss). */
let pausesToken: string | null;
/** The answer to every POST. */
let postReply: { status: number; body: object };

beforeEach(() => {
  list = [MERGE, CHECKING, APPROVE, RETRY, NOTHING, DEP];
  projects = [];
  overview = { as_of: AT, stages: {}, needs_you: 5, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, system_actions: [], factory: { state: "running", rev: "0ff810f1234", target_rev: "0ff810f1234", child_pid: 1, since: AT, workers: 1, workers_source: "default", error: null, pending: [] } };
  posts = [];
  details = {};
  pausesToken = null;
  postReply = { status: 202, body: { seq: 1 } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(postReply.body), { status: postReply.status });
    }
    const bodies: Record<string, unknown> = {
      "/api/v1/overview": overview,
      "/api/v1/items": { as_of: AT, total: list.length, items: list, facets: { allStates: list.length, state: {} }, counts: { open: 0, running: 1 } },
      "/api/v1/tasks": { today_date: "2026-11-12", today: { overdue: [], due: [] }, upcoming: [], projects, csrf_token: "tok", can_build: true, active_projects: [] },
      "/api/v1/pauses": { pauses: [], csrf_token: pausesToken },
      "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
    };
    for (const [id, d] of Object.entries(details)) bodies[`/api/v1/items/${encodeURIComponent(id)}`] = d;
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
  // The rows' commands are on once the session is read: the hidden shortcut button of the first primary turns on.
  await waitFor(() => expect(!!section.querySelector("[data-shortcut]:not([disabled])") || list.length === 0).toBe(true));
  return [...section.querySelectorAll("ul")] as HTMLElement[];
};
/** Opens a row's ⋯ menu and returns its items (the menu stays open). */
const openMenu = (r: HTMLElement) => {
  fireEvent.click(within(r).getByRole("button", { name: "More commands" }));
  return within(within(r).getByRole("menu")).getAllByRole("menuitem") as HTMLButtonElement[];
};
/** Closes an open ⋯ menu by its button. */
const closeMenu = (r: HTMLElement) => fireEvent.click(within(r).getByRole("button", { name: "More commands" }));

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

  it("gives every row only its ⋯ menu, the primary command its first item (owner feedback 2026-11-20)", async () => {
    mount();
    const lists = await ready();
    const labels = lists.flatMap(rowsOf).map((r) => {
      // No visible button or command link beside the menu: Merge, Approve and Retry are menu items.
      const controls = [...r.querySelectorAll<HTMLElement>("button, a[data-action]")].filter((c) => !c.hidden && !c.closest("[role=menu]"));
      expect(controls.map((c) => c.getAttribute("aria-label")), r.getAttribute("data-key")).toEqual(["More commands"]);
      const first = openMenu(r)[0]!.textContent;
      closeMenu(r);
      return first;
    });
    expect(labels).toEqual(["Merge", "Checking…", "Approve", "Retry", "No other commands"]);
  });

  it("disables Merge as 'Checking…' while the merge check runs, with no separate line or duplicate text", async () => {
    mount();
    const lists = await ready();
    const checking = rowsOf(lists[0]!)[1]!;
    const item = openMenu(checking)[0]!;
    expect(item.textContent).toBe("Checking…");
    expect(item.disabled).toBe(true);
    expect(checking.textContent!.match(/Checking…/g)).toHaveLength(1);
    expect(checking.textContent).not.toContain("merge check running");
    closeMenu(checking);
    const merge = openMenu(rowsOf(lists[0]!)[0]!)[0]!;
    expect([merge.textContent, merge.disabled]).toEqual(["Merge", false]);
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

  it("after a click the primary menu item says it was sent and stays off, and p cannot send it twice", async () => {
    mount();
    const lists = await ready();
    const row = rowsOf(lists[1]!)[0]!;
    const approve = openMenu(row)[0]!;
    expect(approve.textContent).toBe("Approve");
    fireEvent.click(approve);
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect(row.querySelector<HTMLButtonElement>("[data-shortcut]")!.disabled).toBe(true));
    const sent = openMenu(row)[0]!;
    expect(sent.textContent).toBe("Sent, waiting…");
    expect(sent.disabled).toBe(true);
  });

  it("shows a reason that is only a status code as a chip beside the badge, not as a line under it", async () => {
    mount();
    const lists = await ready();
    const row = rowsOf(lists[2]!)[1]!;
    const need = row.querySelector<HTMLElement>("[data-need]")!;
    expect(need.tagName).toBe("SPAN");
    // The chip is the shared neutral Badge, a direct child of the reason's wrapper, in the badge row.
    const chip = need.firstElementChild as HTMLElement;
    expect(chip.tagName).toBe("SPAN");
    expect(chip.className).toContain("rounded-pill");
    expect(chip.hasAttribute("data-level")).toBe(false);
    expect(chip.textContent).toBe("failed: spec_conflict");
    expect(need.parentElement!.querySelector("[data-level='needs_you']")).not.toBeNull();
    expect(row.querySelector("p[data-need]")).toBeNull();
    // A sentence joins the same second line, cut to one line with the full text on hover (owner feedback 2026-11-20).
    const sentence = rowsOf(lists[2]!)[0]!.querySelector<HTMLElement>("[data-need]")!;
    expect(sentence.className).toContain("truncate");
    expect(sentence.getAttribute("title")).toBe(sentence.textContent);
    expect(sentence.parentElement!.querySelector("[data-level]")).not.toBeNull();
  });

  it("links a status-code chip to the thread entry its reason names", async () => {
    list = list.map((r) => (r === NOTHING ? { ...NOTHING, need: { reason: "failed: spec_conflict", anchor: "entry-7" } } : r));
    mount();
    const lists = await ready();
    const need = rowsOf(lists[2]!)[1]!.querySelector<HTMLElement>("span[data-need]")!;
    const link = need.firstElementChild as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toMatch(/wi_n1.*#entry-7$/);
    const chip = link.firstElementChild as HTMLElement;
    expect(chip.className).toContain("rounded-pill");
    expect(chip.hasAttribute("data-level")).toBe(false);
    expect(chip.textContent).toBe("failed: spec_conflict");
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

  it("keeps the p shortcut on a hidden button for the primary command, and none on Merge", async () => {
    mount();
    const lists = await ready();
    const shortcut = rowsOf(lists[1]!)[0]!.querySelector<HTMLButtonElement>("[data-shortcut='p']")!;
    expect(shortcut.hidden).toBe(true);
    expect(shortcut.getAttribute("data-action")).toBe("approve");
    expect(shortcut.getAttribute("data-item")).toBe("wi_a1");
    expect(lists[0]!.querySelector("[data-shortcut]")).toBeNull();
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

  it("a non-alarm system action is one row with its command, beside an item and an alarm", async () => {
    const pause = { code: "worker_pause", text: "1 worker pause in effect (factory workers pause)", command: "factory workers resume", until: null };
    const n = await numbers(3, [MERGE], [pause, ALARM(4)]);
    expect([n.rows.length, n.count, n.badge]).toEqual([3, 3, 3]);
    expect(n.rows.find((r) => r.dataset.check === "worker_pause")!.querySelector("code")!.textContent).toBe("factory workers resume");
  });

  it("draws a rank badge on an ask that has a rank reason and none on a row without one", async () => {
    list = [{ ...MERGE, rank_reason: "Merge", held: false }, APPROVE];
    mount();
    const lists = await ready();
    const rows = lists.flatMap(rowsOf);
    expect(rows.map((r) => r.querySelector("[data-rank]")?.textContent ?? null)).toEqual(["Merge", null]);
  });
});

describe("a Merge row whose last Merge came back (the 2026-11-22 screenshot at about 450 px)", () => {
  // wi_d4d15050: the CLI's merge put it in the merge queue, a dashboard Merge was then refused as already there, and the
  // controller put the item back at merge_pending with that refusal (merge_returned) while the queue still checks it.
  const ID = "wi_d4d150505c93419b87e3afce5544a500";
  const QUEUED = row("d4", "ready_to_merge", "North star in AGENTS.md", {
    id: ID, blocked_reason: "merge_pending", merge: { enabled: true, reason: null },
    merge_check: { state: "mergeable", conflicts: [], head_sha: "a", base_sha: "b", checked_at: AT },
  });
  const returned = (refusal: string) => ({
    item: { ...QUEUED, blocked_reason: "merge_pending" }, replies: [], proposals: [], thread: [], runs: [], transcripts: {}, sleeps: [],
    timeline: [
      { version: 7, at: AT, actor: { kind: "user", id: "local:me", name: null }, reason: "merge_requested", changes: {}, detail: null },
      { version: 8, at: AT, actor: { kind: "system", id: "system:controller", name: null }, reason: "merge_returned", changes: {}, detail: { refusal } },
    ],
  });
  const mergeRow = async () => {
    const [first] = await ready();
    return rowsOf(first!).find((r) => r.getAttribute("data-key") === ID)!;
  };

  it("keeps the title first and says Merging… for 'already in the merge queue', with no error and no raw ID", async () => {
    list = [MERGE, QUEUED, APPROVE];
    details = { [ID]: returned(`${ID} is already in the merge queue (checking)`) };
    mount();
    const r = await mergeRow();
    await waitFor(() => expect(r.textContent).toContain("Merging…"));
    expect(within(r).getByRole("link", { name: "North star in AGENTS.md" })).toBeTruthy();
    expect(r.querySelector("[data-row-menu]")!.textContent).not.toContain("merge queue");
    expect(r.textContent).not.toContain("already in the merge queue");
    expect(within(r).queryByRole("alert")).toBeNull();
    expect(r.textContent).not.toMatch(/wi_[0-9a-z]+/);
    const [merge] = openMenu(r);
    expect(merge!.textContent).toBe("Merging…");
    expect(merge!.disabled).toBe(true);
  });

  it("shows any other refusal on its own line below the row's content, never in the menu cell, with no raw ID", async () => {
    list = [QUEUED, APPROVE];
    details = { [ID]: returned(`${ID} could not merge: the head moved`) };
    mount();
    const r = await mergeRow();
    const alert = await within(r).findByRole("alert");
    expect(alert.closest("[data-row-error]")).toBeTruthy();
    expect(alert.closest("[data-row-menu]")).toBeNull();
    expect(alert.textContent).toBe("d4d15050 could not merge: the head moved");
    expect(r.textContent).not.toMatch(/wi_[0-9a-z]+/);
    // The title is still the row's first line.
    expect(r.querySelector("a")!.textContent).toBe("North star in AGENTS.md");
  });

  it("the page recognises the merge queue's own refusal words (src/controller/units/merge-queue/merge-queue.unit.ts)", async () => {
    const { readFileSync } = await import("node:fs");
    const unit = readFileSync(`${process.cwd()}/src/controller/units/merge-queue/merge-queue.unit.ts`, "utf8");
    const { alreadyQueued } = await import("../web/src/api.js");
    const words = /return `\$\{item\.id\}( is already in the merge queue \()\$\{/.exec(unit);
    expect(words).not.toBeNull();
    expect(alreadyQueued(`${ID}${words![1]}checking)`)).toBe(true);
    expect(alreadyQueued("the head moved")).toBe(false);
  });

  it("a row with merge conflicts shows the conflicts as its one state, not Ready to merge beside them", async () => {
    list = [{ ...MERGE, merge: { enabled: false, reason: "9 conflicting files" }, merge_check: { state: "conflicts", conflicts: Array.from({ length: 9 }, (_, i) => `f${i}.ts`), head_sha: "a", base_sha: "b", checked_at: AT } }, APPROVE];
    mount();
    const [first] = await ready();
    const r = rowsOf(first!)[0]!;
    expect(r.textContent).toContain("Conflicts: 9 files");
    expect(r.textContent).not.toContain("Ready to merge");
    expect(r.querySelector('[data-merge-check="conflicts"]')!.getAttribute("title")).toContain("f0.ts");
  });
});

describe("an alarm row's Dismiss (design 09-dashboard-tasks-needs)", () => {
  const ALARM = { code: "alarm", text: "Alarm: checks_failed failed 4 runs on several items", command: "Failures page (/app/failures)", until: AT, alert_id: "al_1", pattern: "repeated_error", error_code: "checks_failed" };
  const STOP = {
    code: "alarm", text: "Auto mode stopped: tests failed on main", command: "Settings", until: null, alert_id: "al_2", pattern: "auto_stopped",
    auto_stop: { alert_id: "al_2", at: AT, cause: "red_main", failing_tests: [], output_tail: null },
  };

  async function checkRows() {
    pausesToken = "ptok";
    overview = { ...overview, needs_you: 2, system_actions: [ALARM, STOP] };
    list = [];
    mount();
    const section = await screen.findByRole("region", { name: "Needs you" });
    const check = within(section).getByRole("list", { name: "Check" });
    const alarm = await waitFor(() => {
      const r = check.querySelector<HTMLElement>("li[data-check='alarm']:not([id])");
      if (!r?.querySelector("[data-dismiss-alarm]")) throw new Error("no Dismiss yet");
      return r;
    });
    const stop = check.querySelector<HTMLElement>("li[data-check='alarm'][id]")!;
    return { alarm, stop };
  }

  it("shows Dismiss, the sm Button, in the row's end slot beside the ⋯ menu, and none on the auto-mode stop row", async () => {
    const { alarm, stop } = await checkRows();
    const button = within(alarm).getByRole("button", { name: "Dismiss" });
    expect(button.closest("[data-row-menu]")).not.toBeNull();
    expect(button.className).toContain("min-h-7");
    expect(button.closest("[role='menu']")).toBeNull();
    expect(within(alarm).getByRole("button", { name: "More commands" })).toBeTruthy();
    expect(stop.querySelector("[data-dismiss-alarm]")).toBeNull();
    expect(within(stop).queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("posts the alarm's alert_id with the pauses' CSRF token, then reads the overview again", async () => {
    const { alarm } = await checkRows();
    const fetchMock = vi.mocked(fetch);
    const reads = () => fetchMock.mock.calls.filter(([u, i]) => String(u).startsWith("/api/v1/overview") && !i?.method).length;
    const before = reads();
    fireEvent.click(within(alarm).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(posts).toContainEqual({ url: "/api/v1/alarms/dismiss", body: { alert_id: "al_1" } }));
    const call = fetchMock.mock.calls.find(([u, i]) => u === "/api/v1/alarms/dismiss" && i?.method === "POST")!;
    expect((call[1]!.headers as Record<string, string>)["x-csrf-token"]).toBe("ptok");
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it("shows a refused dismiss on its own line below the row's title, not in the actions column", async () => {
    postReply = { status: 403, body: { error: "Dismissing needs write permission (approve_spec)." } };
    const { alarm } = await checkRows();
    fireEvent.click(within(alarm).getByRole("button", { name: "Dismiss" }));
    const refusal = await within(alarm).findByRole("alert");
    expect(refusal.textContent).toBe("Dismissing needs write permission (approve_spec).");
    expect(refusal.closest("[data-row-error]")).toBeTruthy();
    expect(refusal.closest("[data-row-menu]")).toBeNull();
    expect(within(alarm).getByRole("button", { name: "Dismiss" }).closest("[data-row-menu]")).not.toBeNull();
  });
});
