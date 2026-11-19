// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemRow } from "../web/src/api.js";
import { SLOW, TOKEN, card, item, reset, row, s, show, teardown, view } from "./ui-tasks-fixtures.js";

beforeEach(reset);
afterEach(teardown);

// Needs you: the section above the list and the work item state on a task row (design 09-dashboard-tasks, 09-dashboard-item).

describe("Needs you", () => {
  const section = () => screen.findByRole("region", { name: "Needs you" }, SLOW);

  it("lists a waiting item with no task as one compact list under its group label, with its count, its state once, its one primary action and no table header", async () => {
    s.items = [item("wi_x", { title: "Approve the spec", item_phase: "needs_approval", commands: [{ name: "approve", usage: "/approve", description: "approve", allowed: true, reason: null }] }), item("wi_run", { title: "Busy", item_phase: "running" })];
    await show();
    const el = await section();
    expect(within(el).getByText("Approve the spec")).toBeTruthy();
    expect(within(el).getByRole("heading", { name: "Approve" })).toBeTruthy();
    expect(el.querySelector("h2 + span")!.textContent).toBe("1");
    expect(within(el).getAllByText("Needs approval")).toHaveLength(1);
    expect(within(el).getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(within(el).queryByText("Busy")).toBeNull();
    expect(el.querySelector("table, thead, th")).toBeNull();
    expect(el.textContent).not.toMatch(/Mergeable|spec ready/);
  });

  it("is not rendered when nothing waits", async () => {
    s.items = [item("wi_run", { title: "Busy", item_phase: "running" })];
    await show();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => u === "/api/v1/items")).toBe(true));
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });

  it("a task whose work waits on a merge shows Merge on its row, and the item is a row of the section too", async () => {
    s.items = [item("wi_1", { title: "Ship it", item_phase: "ready_to_merge", merge: { enabled: true, reason: null }, merge_check: { state: "mergeable", conflicts: [], head_sha: "a", base_sha: "b", checked_at: "2026-11-12T00:00:00.000Z" } } as Partial<ItemRow>)];
    await show();
    expect(await within(card("tk_built")).findByRole("button", { name: "Merge" }, SLOW)).toBeTruthy();
    expect(within(card("tk_built")).getByText("Ready to merge")).toBeTruthy();
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
    s.items = [item("wi_1", { item_phase: "closed", close_reason: "completed", stage: "CLOSED" })];
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
    const button = within(row).getByRole("button", { name: "Merge" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false), SLOW);
    fireEvent.click(button);
  };

  it("a Merge refused for a stale token reads the session once, retries with the new token and shows the merge state, not the error", async () => {
    s.items = [mergeRow()];
    s.sessionTokens = [TOKEN, "tok_fresh"];
    s.commandAnswers = [{ status: 403, body: STALE }, { status: 202, body: { request_id: "app:1", seq: 1, command: "merge", work_item_id: "wi_m" } }];
    await show();
    const row = await workRow("wi_m");
    await pressMerge(row);
    await waitFor(() => expect(within(row).getByRole("button", { name: "Merging…" })).toBeTruthy(), SLOW);
    const sent = s.posts.filter((p) => p.url.endsWith("/commands")).map((p) => new Headers(p.init.headers).get("x-csrf-token"));
    expect(sent).toEqual([TOKEN, "tok_fresh"]);
    expect(s.sessionReads).toBe(2);
    expect(row.textContent).not.toContain(STALE.error);
  });

  it("a Merge whose retry is refused again shows the error once, on its own full-width line below the row, outside the actions", async () => {
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
    // Its own line: a direct child of the row that takes the full width, after the content and the actions.
    const line = error.closest<HTMLElement>("[data-row-error]")!;
    expect(line.parentElement).toBe(row);
    expect(line.className.split(" ")).toContain("basis-full");
    const children = [...row.children];
    expect(children.indexOf(line)).toBeGreaterThan(children.indexOf(actions.closest("li > *")!));
    // The title keeps its space: it grows from a fixed basis instead of shrinking to nothing beside the actions.
    const title = within(row).getByRole("link", { name: "Task title that keeps its space" });
    expect(title.closest("li > div")!.className.split(" ")).toEqual(expect.arrayContaining(["grow", "basis-64"]));
  });

  it("a checkbox still completes a task with the section on the page", async () => {
    s.items = [item("wi_1")];
    await show();
    fireEvent.click(within(card("tk_now")).getByRole("checkbox", { name: "Complete: tk_now" }));
    await waitFor(() => expect(s.posts.some((p) => p.url.includes("done"))).toBe(true), SLOW);
  });
});
