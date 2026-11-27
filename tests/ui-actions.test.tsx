// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_TABLE } from "../src/core/command-table.js";
import { App } from "../web/src/App.js";
import { t } from "../web/src/i18n/index.js";

// One action set for people and agents (design 09-dashboard-shell, 09-dashboard-item-commands, 09-dashboard-tasks):
// every action button on Tasks (its Needs you rows and task rows), Work and the item page carries data-action, a CLI
// command's verb from COMMAND_TABLE (`task <verb>` for a task's), and data-item, the ID of the item or task it acts on.
// The one exception is restart (Restart app), which has no CLI verb yet. A row's ⋯ menu has Copy as CLI command.

const AT = "2026-11-12T00:00:00.000Z";
const cmd = (name: string) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null });
const WHY = "Please allow adding web/src/a.tsx here with /retry +paths web/src/a.tsx.";
const row = (id: string, level: string, title: string, extra: object = {}) => ({
  id, source: { type: "local", id: `local:${id}`, link: "" }, title, item_phase: level, reason_code: "person",
  stage: "REVIEW", tier: 2, kind: null, blocked_on: "human", blocked_reason: "x", close_reason: null, run_status: null,
  change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 },
  need: { reason: `Reason of ${title}`, anchor: null }, ...extra,
});
const MERGE = row("wi_m1", "ready_to_merge", "Ship the parser", { merge: { enabled: true, reason: null }, merge_check: { state: "mergeable", conflicts: [], head_sha: "a", base_sha: "b", checked_at: AT } });
const APPROVE = row("wi_a1", "needs_approval", "Approve the spec", { stage: "READY", blocked_reason: "spec_pending", commands: ["approve", "reject", "revise", "verdict"].map(cmd) });
const RETRY = row("wi_r1", "needs_you", "Fix the build", { commands: ["retry", "resolve", "reject"].map(cmd), need: { reason: WHY, anchor: null } });
// Approve with no approve dialog (its button sends at once), and an approve the viewer may not send.
const PLAIN = row("wi_p1", "needs_approval", "Approve the floor", { blocked_reason: null, commands: [cmd("approve")] });
const REFUSED = row("wi_x1", "needs_approval", "Not yours", { commands: [{ ...cmd("approve"), allowed: false, reason: "not the owner" }] });

const why = (nextActor: string) => ({ code: "human", reason_code: "person", params: {}, alarms: [], holder_id: null, next_actor: nextActor, refs: [], ref_url: null });
const detail = (it: object, commands: object[], extra: object = {}) => ({
  as_of: AT, item: { loop_count: 0, restart_count: 0, token_cost: 0, created_at: AT, phases: [], ...it }, timeline: [], runs: [], commands, replies: [], spec: null, ...extra,
});
const DETAILS: Record<string, unknown> = {
  // Waiting for the owner: the DecisionCard, with every item verb it shows.
  wi_a1: detail({ ...APPROVE, why: why("human") }, ["approve", "revise", "retry", "resolve", "verdict", "reject"].map(cmd)),
  wi_m1: detail({ ...MERGE, stage: "MERGE_PENDING", blocked_reason: null, why: why("human") }, ["verdict", "reject"].map(cmd)),
  // Merged, not waiting for anyone: its commands (Restart app, the "…" menu).
  wi_z1: detail({ ...row("wi_z1", "done", "Shipped"), stage: "CLOSED", close_reason: "completed", blocked_on: "none", blocked_reason: null, why: why("factory") }, ["restart", "reject"].map(cmd)),
};
const task = (id: string, extra: object = {}) => ({ id, title: `Task ${id}`, list: null, priority: null, due_date: null, due_time: null, recurrence: null, work_item_id: null, ...extra });
const TASKS = {
  today_date: "2026-11-12", today: { overdue: [], due: [] }, upcoming: [], csrf_token: "tok", can_build: true, active_projects: [],
  projects: [{ list: null, tasks: [task("tk_open"), task("tk_built", { work_item_id: "wi_a1" }), task("tk_done", { done_at: AT })] }],
};

let posts: { url: string; body: unknown }[];

beforeEach(() => {
  posts = [];
  // react-aria's focus handling (the Work tree) calls CSS.escape, which jsdom does not have; an open menu focuses its first item.
  if (!globalThis.CSS?.escape) vi.stubGlobal("CSS", { escape: (v: string) => v.replace(/[^\w-]/g, "\\$&") });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ request_id: "app:1", seq: 1 }), { status: 202, headers: { "content-type": "application/json" } });
    }
    const list = [MERGE, APPROVE, RETRY, PLAIN, REFUSED];
    const bodies: Record<string, unknown> = {
      "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 3, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, system_actions: [], factory: null },
      "/api/v1/items": { as_of: AT, total: list.length, items: list, facets: { allStates: list.length, state: {} }, counts: { open: 0, running: 0 } },
      "/api/v1/tasks": TASKS,
      "/api/v1/pauses": { pauses: [], csrf_token: null },
      "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
    };
    for (const [id, d] of Object.entries(DETAILS)) bodies[`/api/v1/items/${id}`] = d;
    const body = bodies[url.split("?")[0]!];
    if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.stubGlobal("scrollTo", () => undefined);
  vi.stubGlobal("innerWidth", 1280);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(path: string) {
  history.replaceState(null, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

/** Every verb the CLI has: a bare command's name (`approve`) or a `task` command's second word (`task reopen` → reopen). */
const CLI_VERBS = new Set(COMMAND_TABLE.flatMap((c) => (/^[a-z]+$/.test(c.name) ? [c.name] : c.name.startsWith("task ") ? [c.name.slice(5)] : [])));
/** Decision 1 of the spec: Restart app keeps data-action="restart" until a CLI verb exists. */
const NO_CLI_VERB = new Set(["restart"]);

/**
 * The controls in a row or card that are no actions: they open a reading dialog or a form, copy, or go somewhere. A new
 * control must carry data-action, or be added here on purpose.
 */
const NOT_ACTIONS = new Set([t("tasks.description"), t("tasks.addSub"), t("tasks.projectsItem"), t("tasks.delete"), t("commands.copyCli"), t("copy.id"), t("needs.noMore")]);
const notAction = (el: HTMLElement) =>
  el.getAttribute("aria-haspopup") === "menu" // a ⋯ menu's button: its entries are listed instead
  || el.hasAttribute("data-id") // a person's name, which copies its ID
  || !!el.closest("[data-row-title], [data-work]") // a task's title (its description) and its work item's state dialog
  || NOT_ACTIONS.has(el.textContent ?? "");

/** One action control as the test lists it. */
type Listed = { where: string; label: string; action: string | null; item: string | null };

/** Lists every control of `scope` (its buttons, checkboxes and, opened one at a time, its ⋯ menus' entries) but the non-actions. */
function listActions(scope: HTMLElement, where: string): Listed[] {
  const of = (el: HTMLElement): Listed => ({ where, label: el.getAttribute("aria-label") ?? el.textContent ?? "", action: el.getAttribute("data-action"), item: el.getAttribute("data-item") });
  const out = [...scope.querySelectorAll<HTMLElement>("button, input[type=checkbox]")].filter((el) => !el.closest("[role=menu]") && !notAction(el)).map(of);
  for (const trigger of [...scope.querySelectorAll<HTMLElement>("[aria-haspopup=menu]")]) {
    fireEvent.click(trigger);
    out.push(...within(scope).getAllByRole("menuitem").filter((el) => !notAction(el)).map(of));
    fireEvent.click(trigger);
  }
  return out;
}

/** Opens the Tasks page's Done group ("N done"), closed on load, so its rows are drawn. */
async function openDone() {
  const summary = await screen.findByText(/^\d+ done$/);
  fireEvent.click(summary.closest("summary")!);
}

/** Fails for each listed control with no data-action, an action the CLI does not have, or no data-item among `ids`. */
function expectNamed(listed: readonly Listed[], ids: readonly string[]) {
  for (const l of listed) {
    expect(l.action, `${l.where}: "${l.label}" has no data-action`).not.toBeNull();
    expect(CLI_VERBS.has(l.action!) || NO_CLI_VERB.has(l.action!), `${l.where}: "${l.label}" data-action="${l.action}" is no CLI verb`).toBe(true);
    expect(ids, `${l.where}: "${l.label}" data-item`).toContain(l.item);
  }
}

describe("action names (data-action, data-item)", () => {
  it("the CLI table has every verb the buttons use, and no bare reopen (data-action reopen is `task reopen`)", () => {
    for (const verb of ["approve", "reject", "revise", "retry", "merge", "resolve", "verdict", "build", "done", "reopen"]) expect(CLI_VERBS.has(verb), verb).toBe(true);
    expect(COMMAND_TABLE.some((c) => c.name === "reopen")).toBe(false);
    expect(COMMAND_TABLE.some((c) => c.name === "restart")).toBe(false);
  });

  it("Tasks: every Needs-you row's and task row's action has a CLI verb and its item's or task's ID", async () => {
    mount("/app/tasks");
    const needs = await screen.findByRole("region", { name: "Needs you" });
    await waitFor(() => expect(needs.querySelector("[data-shortcut]:not([disabled])")).not.toBeNull());
    const listed: Listed[] = [];
    for (const r of needs.querySelectorAll<HTMLElement>("li[data-key]")) {
      const id = r.getAttribute("data-key")!;
      const own = listActions(r, `Needs you ${id}`);
      expectNamed(own, [id]);
      listed.push(...own);
    }
    await openDone();
    const rows = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("main li[data-task]")];
      expect(found.some((r) => r.hasAttribute("data-done"))).toBe(true);
      return found;
    });
    for (const r of rows) {
      const id = r.getAttribute("data-task")!;
      const own = listActions(r, `task ${id}`);
      // A built task's menu holds its waiting work item's commands too.
      expectNamed(own, [id, ...TASKS.projects[0]!.tasks.filter((x) => x.id === id && x.work_item_id).map((x) => x.work_item_id!)]);
      listed.push(...own);
    }
    const actions = new Set(listed.map((l) => l.action));
    for (const verb of ["merge", "approve", "reject", "revise", "verdict", "retry", "resolve", "build", "done", "reopen"]) expect(actions.has(verb), verb).toBe(true);
    // The checkbox completes the task: `factory task done <id>`.
    const complete = screen.getByRole("checkbox", { name: "Complete: Task tk_open" });
    expect([complete.dataset.action, complete.dataset.item]).toEqual(["done", "tk_open"]);
  });

  it("Work: every row's action has a CLI verb and its item's ID", async () => {
    mount("/app/items");
    await screen.findByText("Approve the spec");
    const rows = [...document.querySelectorAll<HTMLElement>("main [data-key]")];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expectNamed(listActions(r, `Work ${r.getAttribute("data-key")}`), [r.getAttribute("data-key")!]);
  });

  it("item page: every DecisionCard action, Merge, Restart app and the ⋯ menu entries have a CLI verb (restart excepted) and the item's ID", async () => {
    const seen = new Set<string>();
    for (const id of Object.keys(DETAILS)) {
      mount(`/app/items/${id}`);
      await screen.findByRole("heading", { level: 1 });
      // The commands are on once the session is read.
      await waitFor(() => expect(document.querySelector("main button[data-action]:not([disabled])")).not.toBeNull());
      const scopes = [...document.querySelectorAll<HTMLElement>("[data-decision-card], [data-item-menu]")];
      const restart = document.querySelector<HTMLElement>("button[data-action=restart]");
      const listed = [...scopes.flatMap((s) => listActions(s, id)), ...(restart ? listActions(restart.parentElement!, id) : [])];
      expect(listed.length, id).toBeGreaterThan(0);
      expectNamed(listed, [id]);
      for (const l of listed) seen.add(l.action!);
      cleanup();
    }
    for (const verb of ["approve", "revise", "retry", "resolve", "verdict", "reject", "merge", "restart"]) expect(seen.has(verb), verb).toBe(true);
  });

  it("Good, Bad and Feedback are verdict, with data-choice", async () => {
    mount("/app/items/wi_a1");
    const card = await screen.findByRole("region", { name: "What you need to decide" });
    const verdicts = [...card.querySelectorAll<HTMLElement>("[data-action=verdict][data-choice]")];
    expect(verdicts.map((b) => [b.textContent, b.dataset.choice, b.dataset.item])).toEqual([["Good", "good", "wi_a1"], ["Bad", "bad", "wi_a1"], ["Feedback", "feedback", "wi_a1"]]);
  });

  it("no element on these pages carries data-command", async () => {
    for (const path of ["/app/tasks", "/app/items", "/app/items/wi_a1", "/app/items/wi_m1", "/app/items/wi_z1"]) {
      mount(path);
      await screen.findByRole("heading", { level: 1 });
      await waitFor(() => expect(document.querySelector("main button")).not.toBeNull());
      expect(document.querySelector("[data-command]"), path).toBeNull();
      cleanup();
    }
  });
});

describe("Copy as CLI command and shortcut hints", () => {
  let copied: string[];
  beforeEach(() => {
    copied = [];
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async (v: string) => void copied.push(v) } });
  });

  const menuOf = (r: HTMLElement) => {
    fireEvent.click(within(r).getAllByRole("button").find((b) => b.getAttribute("aria-haspopup") === "menu")!);
    return within(r).getAllByRole("menuitem");
  };

  it("a Needs-you row's ⋯ menu copies factory <command> <full id>; its primary entry shows p in a Kbd", async () => {
    mount("/app/tasks");
    const needs = await screen.findByRole("region", { name: "Needs you" });
    await waitFor(() => expect(needs.querySelector("[data-shortcut]:not([disabled])")).not.toBeNull());
    const approve = needs.querySelector<HTMLElement>('li[data-key="wi_a1"]')!;
    const items = menuOf(approve);
    const primary = items[0]!;
    expect([primary.textContent, primary.getAttribute("aria-keyshortcuts")]).toEqual(["Approve", "p"]);
    expect(primary.querySelector("kbd")?.getAttribute("data-key")).toBe("p");
    // Only the primary has a shortcut.
    expect(items.slice(1).some((m) => m.querySelector("kbd"))).toBe(false);
    fireEvent.click(within(approve).getByRole("menuitem", { name: "Copy as CLI command" }));
    await waitFor(() => expect(copied).toEqual(["factory approve wi_a1"]));
    const merge = needs.querySelector<HTMLElement>('li[data-key="wi_m1"]')!;
    fireEvent.click(within(merge).getAllByRole("button").find((b) => b.getAttribute("aria-haspopup") === "menu")!);
    fireEvent.click(within(merge).getByRole("menuitem", { name: "Copy as CLI command" }));
    await waitFor(() => expect(copied).toContain("factory merge wi_m1"));
  });

  it("an open task row's ⋯ menu copies factory task build <task id>", async () => {
    mount("/app/tasks");
    const open = (await screen.findByText("Task tk_open")).closest<HTMLElement>("li[data-task]")!;
    menuOf(open);
    fireEvent.click(within(open).getByRole("menuitem", { name: "Copy as CLI command" }));
    await waitFor(() => expect(copied).toEqual(["factory task build tk_open"]));
  });

  it("Copy as CLI command says each action as the CLI types it: a task verb as `task <verb>`", async () => {
    const { cliCommand } = await import("../web/src/views/item-commands.js");
    expect(cliCommand("approve", "wi_1")).toBe("factory approve wi_1");
    expect(cliCommand("reopen", "tk_1")).toBe("factory task reopen tk_1");
    expect(cliCommand("done", "tk_1")).toBe("factory task done tk_1");
  });

  it("the top bar's Search button's tooltip shows ⌘K in a Kbd", async () => {
    mount("/app/items");
    const search = await screen.findByRole("button", { name: "Search" });
    fireEvent.focus(search);
    const tip = await screen.findByRole("tooltip");
    expect(tip.querySelector("kbd")?.textContent).toBe("⌘K");
  });
});

describe("⌘K actions", () => {
  const search = async (text: string) => {
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    fireEvent.change(await screen.findByPlaceholderText("Search pages and items"), { target: { value: text } });
  };
  const options = () => within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
  /** Waits until the loaded items and the session are read, so ⌘K can offer their approves. */
  const loaded = async () => {
    const needs = await screen.findByRole("region", { name: "Needs you" });
    await waitFor(() => expect(needs.querySelector("[data-shortcut]:not([disabled])")).not.toBeNull());
  };

  it("lists Approve: <title> only for loaded items whose approve the viewer may send, after the pages and items", async () => {
    mount("/app/tasks");
    await loaded();
    await search("approve");
    await waitFor(() => expect(options()).toContain("Approve: Approve the specActions"));
    expect(options()).toContain("Approve: Approve the floorActions");
    // Not allowed (Not yours), or no approve (Fix the build): not offered.
    expect(options().some((o) => o!.includes("Not yours"))).toBe(false);
    expect(options().some((o) => o!.includes("Fix the build"))).toBe(false);
    // The items themselves come first, so Enter on a title search opens the item.
    expect(options()[0]).toBe("Approve the specItems");
  });

  it("on a held spec, Approve opens the item button's approve dialog and sends nothing before its confirm; then POSTs approve to the item commands route", async () => {
    mount("/app/tasks");
    await loaded();
    await search("Approve: Approve the spec");
    fireEvent.click(await screen.findByRole("button", { name: /Approve: Approve the spec/ }));
    const dialog = await screen.findByRole("dialog", { name: "Approve Approve the spec" });
    expect(dialog.querySelector("[data-approve-confirm=spec_pending]")).not.toBeNull();
    expect(posts).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts).toEqual([{ url: "/api/v1/items/wi_a1/commands", body: { command: "approve" } }]));
  });

  it("where the item's Approve sends at once, ⌘K's does too, through the same route", async () => {
    mount("/app/tasks");
    await loaded();
    await search("Approve: Approve the floor");
    fireEvent.click(await screen.findByRole("button", { name: /Approve: Approve the floor/ }));
    await waitFor(() => expect(posts).toEqual([{ url: "/api/v1/items/wi_p1/commands", body: { command: "approve" } }]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Go to Runners opens Health's Runners tab", async () => {
    mount("/app/tasks");
    await loaded();
    await search("runners");
    fireEvent.click(await screen.findByRole("button", { name: /Go to Runners/ }));
    expect(`${location.pathname}${location.search}`).toBe("/app/health?tab=runners");
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
  });

  it("the sidebar's Shortcuts row opens the shortcut list", async () => {
    mount("/app/tasks");
    const sidebar = await screen.findByRole("complementary", { name: "Sidebar" });
    fireEvent.click(within(sidebar).getByRole("button", { name: "Shortcuts" }));
    const help = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(help.textContent).toContain("⌘K");
  });

  it("the Shortcuts row draws no ? key at its end, yet names it, and ? still opens the shortcut list", async () => {
    mount("/app/tasks");
    const sidebar = await screen.findByRole("complementary", { name: "Sidebar" });
    const row = within(sidebar).getByRole("button", { name: "Shortcuts" });
    expect(row.querySelector("kbd")).toBeNull();
    expect(row.getAttribute("aria-keyshortcuts")).toBe("?");
    fireEvent.keyDown(document.body, { key: "?" });
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });
});
