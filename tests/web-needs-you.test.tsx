// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";

// The Needs you page (design 09-dashboard-app): a PageHeader with the count, rows grouped Merge, Approve, Answer or
// fix, one primary action per row with the "⋯" menu last, a plain why text, and j, k, Enter and p on the rows.

const AT = "2026-11-12T00:00:00.000Z";
const cmd = (name: string) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null });
const WHY = "Please merge wi_5b2b, then /retry this item. Or allow adding web/src/components/ui/input.tsx here with /retry +paths web/src/components/ui/input.tsx.";
const row = (n: string, level: string, title: string, extra: object = {}) => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title, level,
  badges: [], stage: "REVIEW", tier: 2, kind: null, blocked_on: "human", blocked_reason: "x", close_reason: null, run_status: null,
  change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 },
  need: { reason: `Reason of ${title}`, anchor: null }, ...extra,
});
const MERGE = row("m1", "ready_to_merge", "Ship the parser", {
  change_ref: "644", change_url: "https://github.com/o/r/pull/644", merge: { enabled: true, reason: null }, merge_check: { state: "mergeable", conflicts: [], head_sha: "a", base_sha: "b", checked_at: AT },
});
const CHECKING = row("m2", "ready_to_merge", "Ship the lexer", { merge: { enabled: true, reason: null }, merge_check: { state: "checking", conflicts: [], head_sha: null, base_sha: null, checked_at: null } });
const APPROVE = row("a1", "needs_approval", "Approve the spec", { commands: ["approve", "reject", "revise"].map(cmd) });
const RETRY = row("r1", "needs_you", "Fix the build", { commands: ["retry", "reject"].map(cmd), need: { reason: WHY, anchor: null } });
const NOTHING = row("n1", "needs_you", "Look at this", { commands: [] });
const DEP = row("5b2b", "running", "Add the input component", { blocked_on: "none", need: undefined });

let list: object[];
let overview: Record<string, unknown>;
let posts: { url: string; body: unknown }[];

beforeEach(() => {
  list = [MERGE, CHECKING, APPROVE, RETRY, NOTHING, DEP];
  overview = { as_of: AT, stages: {}, needs_you: 5, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, system_actions: [], factory: { state: "running", rev: "0ff810f1234", target_rev: "0ff810f1234", child_pid: 1, since: AT, workers: 1, workers_source: "default", error: null, pending: [] } };
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ seq: 1 }), { status: 202 });
    }
    const bodies: Record<string, unknown> = {
      "/api/v1/overview": overview,
      "/api/v1/items": { as_of: AT, total: list.length, items: list, facets: { allStates: list.length, state: {} } },
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
const rowsOf = (el: HTMLElement) => [...el.querySelectorAll("tbody tr")] as HTMLElement[];
const ready = () => screen.findAllByRole("table", { name: "Needs you" });

describe("the Needs you page", () => {
  it("has one header with the count, groups Merge, Approve, Answer or fix in that order, and counts them only when there are several", async () => {
    mount();
    const tables = await ready();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Needs you"]);
    expect(screen.getByText("5 waiting")).toBeTruthy();
    const sections = [...document.querySelectorAll("main section")];
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual(["Merge", "Approve", "Answer or fix"]);
    expect(sections.map((s) => s.querySelector("h2 + span")?.textContent)).toEqual(["2", "1", "2"]);
    expect(tables.map((t) => rowsOf(t).map((r) => r.getAttribute("data-key")))).toEqual([["wi_m1", "wi_m2"], ["wi_a1"], ["wi_r1", "wi_n1"]]);
    cleanup();
    list = [APPROVE];
    mount();
    await ready();
    expect(document.querySelector("main section h2 + span")).toBeNull();
    expect(document.querySelectorAll("main section")).toHaveLength(1);
  });

  it("shows the factory as a header indicator, and a Notice only when it is paused, stopped or failing", async () => {
    mount();
    await ready();
    const status = screen.getByTestId("factory-status");
    expect(status.textContent).toBe("Running");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("factory-banner")).toBeNull();
    fireEvent.focus(status);
    expect(screen.getByRole("tooltip").textContent).toContain("0ff810f");
    cleanup();
    overview.factory = null;
    mount();
    await ready();
    expect(screen.getByTestId("factory-status").textContent).toBe("Stopped");
    expect(screen.getByRole("alert").textContent).toContain("Factory stopped");
  });

  it("has the columns Item, State, Why, Since, Actions, and leaves out Issue and PR while no row has them", async () => {
    mount();
    const [first] = await ready();
    expect([...first!.querySelectorAll("thead th")].map((h) => h.textContent)).toEqual(["Item", "State", "Why", "Since", "Actions"]);
    const cells = [...rowsOf(first!)[0]!.querySelectorAll("td")];
    expect(cells[3]!.className).toMatch(/text-right.*tabular-nums|tabular-nums.*text-right/);
    expect(cells[4]!.className).toMatch(/text-right/);
    // A PR is a muted link after the title.
    const pr = within(cells[0]!).getByRole("link", { name: "PR #644" });
    expect(pr.textContent).toBe("#644");
    expect(pr.className).toContain("text-text-2");
    expect(cells[0]!.querySelectorAll("a")[0]!.textContent).toBe("Ship the parser");
    cleanup();
    list = [{ ...APPROVE, issue: { number: 12, url: "https://github.com/o/r/issues/12" } }];
    mount();
    const [withIssue] = await ready();
    expect([...withIssue!.querySelectorAll("thead th")].map((h) => h.textContent)).toEqual(["Item", "State", "Why", "Since", "Issue", "Actions"]);
  });

  it("gives every row one primary action with the ⋯ menu last, in the same place", async () => {
    mount();
    const tables = await ready();
    const labels = tables.flatMap(rowsOf).map((r) => {
      const actions = [...r.querySelectorAll("td")].at(-1)!;
      const controls = [...actions.querySelectorAll("button, a[data-command]")].filter((c) => !c.closest("[role=menu]"));
      expect(controls.at(-1)!.getAttribute("aria-label"), r.getAttribute("data-key")).toBe("More commands");
      expect(controls, r.getAttribute("data-key")).toHaveLength(2);
      return controls[0]!.textContent;
    });
    expect(labels).toEqual(["Merge", "Checking…", "Approve", "Retry", "Open"]);
  });

  it("disables Merge as 'Checking…' while the merge check runs, with no separate line or duplicate text", async () => {
    mount();
    const tables = await ready();
    const checking = rowsOf(tables[0]!)[1]!;
    const button = within(checking).getByRole("button", { name: "Checking…" });
    expect(button.disabled).toBe(true);
    expect(checking.textContent!.match(/Checking…/g)).toHaveLength(1);
    expect(checking.textContent).not.toContain("merge check running");
    expect(within(rowsOf(tables[0]!)[0]!).getByRole("button", { name: "Merge" }).disabled).toBe(false);
  });

  it("renders a why text for people: the item ID as its title link, /retry as a button, the path in code style, the +paths reply in the menu", async () => {
    mount();
    const tables = await ready();
    const why = rowsOf(tables[2]!)[0]!.querySelector("[data-need]")!;
    const link = within(why).getByRole("link", { name: "Add the input component" });
    expect(link.getAttribute("href")).toBe("/app/items/wi_5b2b");
    const retry = within(why).getByRole("button", { name: "Retry after it merges" });
    expect(why.querySelector("code")!.textContent).toBe("web/src/components/ui/input.tsx");
    expect(why.textContent).not.toMatch(/\/retry|\+paths|wi_5b2b/);
    fireEvent.click(retry);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/api/v1/items/wi_r1/commands", body: { command: "retry" } });
    posts = [];
    fireEvent.click(within(rowsOf(tables[2]!)[0]!).getByRole("button", { name: "More commands" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Allow input.tsx and retry" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ command: "retry", note: "+paths web/src/components/ui/input.tsx" });
  });

  it("names an ID that is not in the loaded list by the ID, linked to its item page", async () => {
    list = [{ ...RETRY, need: { reason: "Please merge wi_zz99, then /retry this item.", anchor: null } }];
    mount();
    const [table] = await ready();
    const link = within(table!).getByRole("link", { name: "wi_zz99" });
    expect(link.getAttribute("href")).toBe("/app/items/wi_zz99");
  });

  it("moves between rows with j and k, opens the item with Enter, presses the primary action with p (never Merge)", async () => {
    mount();
    const tables = await ready();
    const rows = tables.flatMap(rowsOf);
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
    const tables = await ready();
    fireEvent.focus(within(rowsOf(tables[1]!)[0]!).getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("tooltip").textContent).toBe("Approve (p)");
    cleanup();
    mount();
    const [merge] = await ready();
    expect(merge!.querySelector("[data-shortcut]")).toBeNull();
  });
});
