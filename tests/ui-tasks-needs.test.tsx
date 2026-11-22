// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemRow } from "../web/src/api.js";
import { SLOW, TOKEN, card, chooseMenu, item, menuItems, reset, row, s, show, teardown, view } from "./ui-tasks-fixtures.js";

beforeEach(reset);
afterEach(teardown);

// Needs you: the section above the list and the work item state on a task row (design 09-dashboard-tasks, 09-dashboard-item).

describe("Needs you", () => {
  const section = () => screen.findByRole("region", { name: "Needs you" }, SLOW);

  it("lists a waiting item with no task as one compact list under its group label, with its count, its state once, its primary command first in its menu and no table header", async () => {
    s.items = [item("wi_x", { title: "Approve the spec", item_phase: "needs_approval", commands: [{ name: "approve", usage: "/approve", description: "approve", allowed: true, reason: null }] }), item("wi_run", { title: "Busy", item_phase: "running" })];
    await show();
    const el = await section();
    expect(within(el).getByText("Approve the spec")).toBeTruthy();
    expect(within(el).getByRole("heading", { name: "Approve" })).toBeTruthy();
    expect(el.querySelector("h2 + span")!.textContent).toBe("1");
    expect(within(el).getAllByText("Needs approval")).toHaveLength(1);
    const r = el.querySelector<HTMLElement>('li[data-key="wi_x"]')!;
    // No button beside the title: the row's one visible control is its menu, Approve first in it (owner feedback 2026-11-20).
    expect(within(r).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["More commands"]);
    expect(menuItems(r)[0]).toBe("Approve");
    expect(within(el).queryByText("Busy")).toBeNull();
    expect(el.querySelector("table, thead, th")).toBeNull();
    expect(el.textContent).not.toMatch(/Mergeable|spec ready/);
  });

  const command = (name: string, extra: object = {}) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null, ...extra });
  /** The first item of a Needs you row's menu (the menu stays open). */
  const primaryOf = async (id: string) => {
    const row = (await section()).querySelector<HTMLElement>(`li[data-key="${id}"]`)!;
    menuItems(row);
    return row.querySelector<HTMLButtonElement>("[role=menu] [role=menuitem]")!;
  };

  it("a row's first menu item is the approve or resolve its block reason accepts, whatever the API's order; Retry only when neither is accepted; each carries data-action", async () => {
    s.items = [
      item("wi_a", { title: "Approve first", item_phase: "needs_you", commands: ["retry", "reject", "approve"].map((n) => command(n)) }),
      item("wi_r", { title: "Resolve first", item_phase: "needs_you", commands: ["retry", "resolve"].map((n) => command(n)) }),
      item("wi_t", { title: "Only retry", item_phase: "needs_you", commands: ["retry", "revise"].map((n) => command(n)) }),
      item("wi_n", { title: "Approve not allowed", item_phase: "needs_you", commands: [command("approve", { allowed: false, reason: "no role" }), command("retry")] }),
      item("wi_m", { title: "Merge it", item_phase: "ready_to_merge", merge: { enabled: true, reason: null } }),
      item("wi_o", { title: "Nothing to send", item_phase: "needs_you", commands: [command("reject")] }),
    ];
    await show();
    const want = {
      wi_a: ["Approve", "approve"], wi_r: ["Answer", "resolve"], wi_t: ["Retry", "retry"], wi_n: ["Retry", "retry"], wi_m: ["Merge", "merge"], wi_o: ["Reject", "reject"],
    };
    for (const [id, [label, action]] of Object.entries(want)) {
      const b = await primaryOf(id);
      expect({ id, label: b.textContent, action: b.dataset.action }).toEqual({ id, label, action });
    }
    // With no primary command (only Reject) the row has no p shortcut.
    expect((await section()).querySelector('li[data-key="wi_o"] [data-shortcut]')).toBeNull();
  });

  it("from the third identical stop (repeated_stop) the primary is Revise, else Reject, not Retry; a permission ask still comes first; neither allowed keeps the order", async () => {
    const rep = (n: string, extra: object = {}) => command(n, { repeated_stop: true, ...extra });
    s.items = [
      item("wi_v", { title: "Revise it", item_phase: "needs_you", commands: ["retry", "reject", "revise"].map((n) => rep(n)) }),
      item("wi_j", { title: "Reject it", item_phase: "needs_you", commands: ["retry", "reject"].map((n) => rep(n)) }),
      item("wi_k", { title: "Revise not allowed", item_phase: "needs_you", commands: [rep("retry"), rep("revise", { allowed: false, reason: "no role" }), rep("reject")] }),
      item("wi_q", { title: "Asked paths", item_phase: "needs_you", commands: [rep("retry", { paths: ["docs/y.md"] }), rep("revise"), rep("reject")] }),
      item("wi_z", { title: "Neither allowed", item_phase: "needs_you", commands: [rep("retry"), rep("revise", { allowed: false, reason: "no" }), rep("reject", { allowed: false, reason: "no" })] }),
      item("wi_once", { title: "Not repeated", item_phase: "needs_you", commands: ["retry", "revise", "reject"].map((n) => command(n)) }),
    ];
    await show();
    const want = {
      wi_v: ["Revise", "revise"], wi_j: ["Reject", "reject"], wi_k: ["Reject", "reject"], wi_q: ["Allow and retry", "retry"], wi_z: ["Retry", "retry"], wi_once: ["Retry", "retry"],
    };
    for (const [id, [label, action]] of Object.entries(want)) {
      const b = await primaryOf(id);
      expect({ id, label: b.textContent, action: b.dataset.action }).toEqual({ id, label, action });
    }
    // Revise needs feedback: its primary opens the form and sends nothing yet.
    const b = await primaryOf("wi_v");
    await waitFor(() => expect(b.disabled).toBe(false), SLOW);
    fireEvent.click(b);
    expect(await screen.findByRole("dialog", {}, SLOW)).toBeTruthy();
    expect(s.posts.some((p) => p.url.endsWith("/commands"))).toBe(false);
  });

  it("a permission ask shows the command that allows its paths, not Retry, and sends them as +paths", async () => {
    const paths = ["web/src/x.tsx", "docs/y.md"];
    s.items = [item("wi_p", {
      title: "May I edit these paths?", item_phase: "needs_you", need: { reason: "May I edit these paths?" },
      commands: [command("retry", { paths }), command("revise"), command("reject")],
    })];
    await show();
    const b = await primaryOf("wi_p");
    expect(b.textContent).toBe("Allow and retry");
    expect(b.textContent).not.toBe("Retry");
    expect(b.dataset.action).toBe("retry");
    await waitFor(() => expect(b.disabled).toBe(false), SLOW);
    fireEvent.click(b);
    await waitFor(() => expect(s.posts.some((p) => p.url.endsWith("/commands"))).toBe(true), SLOW);
    const sent = s.posts.filter((p) => p.url.endsWith("/commands")).map((p) => JSON.parse(String(p.init.body)));
    expect(sent).toEqual([{ command: "retry", note: "+paths web/src/x.tsx docs/y.md" }]);
  });

  it("is not rendered when nothing waits", async () => {
    s.items = [item("wi_run", { title: "Busy", item_phase: "running" })];
    await show();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => u === "/api/v1/items")).toBe(true));
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });

  it("a task whose work waits on a merge has Merge first in its row's one menu, before the task's own actions, and the item is a row of the section too", async () => {
    s.items = [item("wi_1", { title: "Ship it", item_phase: "ready_to_merge", merge: { enabled: true, reason: null }, merge_check: { state: "mergeable", conflicts: [], head_sha: "a", base_sha: "b", checked_at: "2026-11-12T00:00:00.000Z" } } as Partial<ItemRow>)];
    await show();
    expect(await within(card("tk_built")).findByText("Ready to merge", {}, SLOW)).toBeTruthy();
    expect(within(card("tk_built")).getAllByRole("button", { name: /More/ })).toHaveLength(1);
    const items = menuItems(card("tk_built"));
    expect(items[0]).toBe("Merge");
    expect(items.slice(-3)).toEqual(["Projects…", "Delete", "Copy ID"]);
    expect(within(card("tk_built")).queryByRole("button", { name: "Work item state: tk_built" })).toBeNull();
    const el = await section();
    expect([...el.querySelectorAll<HTMLElement>("li[data-key]")].map((r) => r.dataset.key)).toEqual(["wi_1"]);
    expect(el.querySelector("h2 + span")!.textContent).toBe("1");
  });

  it("a waiting item whose task is done stays in the section; the done row keeps its plain state", async () => {
    s.items = [item("wi_1", { title: "Ship it", item_phase: "needs_approval" })];
    s.current = view({ projects: [{ list: null, tasks: [{ ...row("tk_built", { work_item_id: "wi_1" }), done_at: "2026-11-12T08:00:00.000Z" }, row("tk_inbox")] }] });
    await show();
    expect(within(await section()).getByText("Ship it")).toBeTruthy();
    expect(await within(card("tk_built")).findByRole("button", { name: "Work item state: tk_built" }, SLOW)).toBeTruthy();
    expect(within(card("tk_built")).queryByRole("link", { name: "Open" })).toBeNull();
    expect(within(card("tk_built")).queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("an item on an open task's row and one with no task are each listed once in the section; a stuck item is not", async () => {
    s.items = [item("wi_1", { title: "Linked", item_phase: "needs_approval" }), item("wi_x", { title: "Loose", item_phase: "needs_approval" }), item("wi_s", { title: "Stuck", item_phase: "stuck", blocked_on: "none" })];
    await show();
    const el = await section();
    expect([...el.querySelectorAll<HTMLElement>("li[data-key]")].map((r) => r.dataset.key)).toEqual(["wi_1", "wi_x"]);
    expect(el.querySelector("h2 + span")!.textContent).toBe("2");
    expect(within(el).queryByText("Stuck")).toBeNull();
  });

  it("a built task shows its work item's state", async () => {
    s.items = [item("wi_1", { item_phase: "ready_to_merge" })];
    await show();
    expect(await within(card("tk_built")).findByText("Ready to merge", {}, SLOW)).toBeTruthy();
  });

  it("a merged item reads Merged, and the state opens a dialog with the full-page link", async () => {
    // The server gives a completed close the state merged (src/ui/priority.ts closedLevel).
    s.items = [item("wi_1", { item_phase: "merged", close_reason: "completed", stage: "CLOSED" })];
    await show();
    expect(await within(card("tk_built")).findByText("Merged", {}, SLOW)).toBeTruthy();
    fireEvent.click(within(card("tk_built")).getByRole("button", { name: "Work item state: tk_built" }));
    const dialog = document.querySelector<HTMLElement>("[data-dialog]")!;
    expect(within(dialog).getByRole("link", { name: "Open the full item page" }).getAttribute("href")).toBe("/app/items/wi_1");
  });

  const STALE = { error: "Missing or stale x-csrf-token; reload the page.", code: "stale_csrf" };
  const mergeRow = () => item("wi_m", { title: "Task title that keeps its space", item_phase: "ready_to_merge", merge: { enabled: true, reason: null } });
  const workRow = async (id: string) => {
    return (await section()).querySelector<HTMLElement>(`li[data-key="${id}"]`)!;
  };
  const pressMerge = async (row: HTMLElement) => {
    // The session read turns the menu's Merge on; reopen the menu until it is.
    await waitFor(() => {
      menuItems(row);
      const merge = row.querySelector<HTMLButtonElement>("[role=menu] [data-action=merge]")!;
      expect(merge.disabled).toBe(false);
    }, SLOW);
    chooseMenu(row, "Merge");
  };

  it("a Merge refused for a stale token reads the session once, retries with the new token and shows the merge state, not the error", async () => {
    s.items = [mergeRow()];
    s.sessionTokens = [TOKEN, "tok_fresh"];
    s.commandAnswers = [{ status: 403, body: STALE }, { status: 202, body: { request_id: "app:1", seq: 1, command: "merge", work_item_id: "wi_m" } }];
    await show();
    const row = await workRow("wi_m");
    await pressMerge(row);
    await waitFor(() => expect(row.querySelector("[data-need-commands]")!.textContent).toContain("Merging…"), SLOW);
    const sent = s.posts.filter((p) => p.url.endsWith("/commands")).map((p) => new Headers(p.init.headers).get("x-csrf-token"));
    expect(sent).toEqual([TOKEN, "tok_fresh"]);
    expect(s.sessionReads).toBe(2);
    expect(row.textContent).not.toContain(STALE.error);
  });

  it("a Merge whose retry is refused again shows the error once, on its own line under the title and details, outside the menu", async () => {
    s.items = [mergeRow()];
    s.commandAnswers = [{ status: 403, body: STALE }];
    await show();
    const row = await workRow("wi_m");
    await pressMerge(row);
    const error = await within(row).findByRole("alert", {}, SLOW);
    expect(error.textContent).toBe(STALE.error);
    expect(s.posts.filter((p) => p.url.endsWith("/commands")).map((p) => new Headers(p.init.headers).get("x-csrf-token"))).toEqual([TOKEN, TOKEN]);
    const actions = row.querySelector<HTMLElement>("[data-need-commands]")!;
    expect(actions.contains(error)).toBe(false);
    // The ItemRow's second line in the content column, after the line with the title; the menu cell stays one button wide.
    expect(error.closest("[data-row-error]")).not.toBeNull();
    const line = error.closest<HTMLElement>("[data-row-second]")!;
    const column = line.parentElement!;
    expect(column.parentElement).toBe(row);
    const children = [...column.children];
    expect(children.indexOf(line)).toBeGreaterThan(children.indexOf(within(row).getByRole("link", { name: "Task title that keeps its space" }).parentElement!));
    expect(row.querySelector("[data-row-menu]")!.contains(error)).toBe(false);
    // The title keeps its space: one truncated line in a column that takes the rest of the row, the actions beside it.
    const title = within(row).getByRole("link", { name: "Task title that keeps its space" });
    expect(title.className).toContain("truncate");
    expect(title.closest("li > div")!.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-1"]));
  });

  it("a checkbox still completes a task with the section on the page", async () => {
    s.items = [item("wi_1")];
    await show();
    fireEvent.click(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" }));
    await waitFor(() => expect(s.posts.some((p) => p.url.includes("done"))).toBe(true), SLOW);
  });
});
