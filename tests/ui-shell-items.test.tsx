// @vitest-environment jsdom
// Dashboard shell tests: items table, Running now and Queue, Floor links, why an item waits, open alarms. Shared setup is in ui-shell-fixtures.tsx.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ItemsTable } from "../web/src/views/common.js";
import { API, type Items, type ItemRow } from "../web/src/api.js";
import { POLL_MS } from "../web/src/api.js";
import { VIEW_KEY } from "../web/src/views/tree.js";
import { whyText } from "../web/src/lib/format.js";
import { AT, RESPONSES, overview, row, items, runs, queue, detail, state, installShellFixtures, mount } from "./ui-shell-fixtures.js";

installShellFixtures();

const GH = { issues: "github" } as const;
const NONE = { issues: null } as const;
const trow = (n: number, extra: Partial<ItemRow> = {}): ItemRow => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title: `Title ${n}`,
  item_phase: "running", reason_code: "person", stage: "RUNNING", tier: 2, kind: null, blocked_on: "none", blocked_reason: null, close_reason: null,
  run_status: null, change_ref: null, change_url: null, issue: { number: n, url: `https://github.com/o/r/issues/${n}` }, since: AT,
  updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 }, ...extra,
});
const NOW_MS = Date.parse(AT);
const itemsTable = (items: ItemRow[], plugins?: typeof GH | typeof NONE) =>
  render(<ItemsTable items={items} now={NOW_MS} label="Work items" empty="none" plugins={plugins} />).container;
const heads = (c: HTMLElement) => [...c.querySelectorAll("th")].map((h) => h.textContent);
const cells = (c: HTMLElement) => [...c.querySelectorAll("tbody tr:first-child td")] as HTMLElement[];

describe("ItemsTable columns and links (issue #240)", () => {
  // Each row is an ItemRow (design 09-dashboard-system): State, Item (the title, the link), Why, Worker, Since, then the
  // PR as the row's action beside its "⋯" menu; a column empty in every row is left out.
  const menuOf = (row: HTMLElement) => {
    fireEvent.click(row.querySelector<HTMLButtonElement>("[data-row-menu] [aria-haspopup=menu]")!);
    return [...row.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
  };

  it("links the title to the item page and the Item cell not to GitHub; the row carries the item's ID only as data-item-id", () => {
    const c = itemsTable([trow(1)], GH);
    const item = cells(c)[1]!;
    expect(item.querySelectorAll("a")).toHaveLength(1);
    expect(item.querySelector("a")!.getAttribute("href")).toBe("/app/items/wi_1");
    expect(item.textContent).toBe("Title 1");
    const tr = c.querySelector<HTMLElement>("tbody tr")!;
    expect(tr.dataset.itemId).toBe("wi_1");
    expect(tr.textContent).not.toMatch(/wi_1|o\/r#1/);
  });

  it("shows Untitled item, never an ID or source number, as the link text when there is no title", () => {
    const a = cells(itemsTable([trow(2, { title: null })], GH))[1]!.querySelector("a")!;
    expect(a.textContent).toBe("Untitled item");
    expect(a.getAttribute("href")).toBe("/app/items/wi_2");
  });

  it("with GitHub: the PR is the row's action, the issue opens from the ⋯ menu, and Copy ID copies the item's ID", async () => {
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const c = itemsTable([trow(3, { change_ref: "9", change_url: "https://github.com/o/r/pull/9" }), trow(4)], GH);
    expect(heads(c)).toEqual(["State", "Item", "Since", "PR"]);
    const [r1, r2] = [...c.querySelectorAll("tbody tr")] as HTMLElement[];
    const action = r1!.querySelector("[data-row-action] a")!;
    expect(action.getAttribute("href")).toBe("https://github.com/o/r/pull/9");
    expect(action.textContent).toBe("PR #9");
    expect(r2!.querySelector("[data-row-action]")).toBeNull();
    const items = menuOf(r1!);
    expect(items.map((b) => b.textContent)).toEqual(["Open issue #3", "Copy ID"]);
    fireEvent.click(items[0]!);
    expect(open).toHaveBeenCalledWith("https://github.com/o/r/issues/3", "_blank", "noopener,noreferrer");
    fireEvent.click(menuOf(r1!)[1]!);
    expect(write).toHaveBeenCalledWith("wi_3");
  });

  it("without GitHub: no issue anywhere; the PR shows the stored link, and the menu holds only Copy ID", () => {
    for (const plugins of [NONE, undefined]) {
      const c = itemsTable([trow(5, { change_ref: "9", change_url: "https://forge.example/o/r/pull/9" }), trow(4)], plugins);
      expect(c.innerHTML).not.toContain("github.com");
      const [r1] = [...c.querySelectorAll("tbody tr")] as HTMLElement[];
      expect(r1!.querySelector("[data-row-action] a")!.getAttribute("href")).toBe("https://forge.example/o/r/pull/9");
      expect(menuOf(r1!).map((b) => b.textContent)).toEqual(["Copy ID"]);
      cleanup();
    }
  });

  it("an adopted PR has no issue in its menu and its number as the action", () => {
    const c = itemsTable([trow(6, { issue: null, change_ref: "6", change_url: "https://github.com/o/r/pull/6" })], GH);
    const tr = c.querySelector<HTMLElement>("tbody tr")!;
    expect(tr.querySelector("[data-row-action]")!.textContent).toBe("PR #6");
    expect(menuOf(tr).map((b) => b.textContent)).toEqual(["Copy ID"]);
  });

  it("a change_ref without a stored change_url shows the ref as text", () => {
    const action = itemsTable([trow(7, { change_ref: "7", change_url: null })], GH).querySelector("[data-row-action]")!;
    expect(action.textContent).toBe("PR #7");
    expect(action.querySelector("a")).toBeNull();
  });
});

// ---- Item commands (issue #228): a button per command, the note box, the reject and revise dialogs (issue #527), the outcome ----

describe("Floor item links (issue #228)", () => {
  it("Needs you and Work items rows link their title to the item page", async () => {
    mount();
    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(within(needs).getByRole("link", { name: "Spec waiting" }).getAttribute("href")).toBe("/app/items/wi_1");
    cleanup();
    localStorage.setItem(VIEW_KEY, "list");
    history.replaceState(null, "", "/app/items");
    mount();
    const all = await screen.findByRole("table", { name: "Work items" });
    expect(within(all).getByRole("link", { name: "Being built" }).getAttribute("href")).toBe("/app/items/wi_2");
  });
});

// ---- Why an item waits (issue #310): one sentence from the API, #N linked, on Floor, Items, Queue and the item page ----
describe("why an item waits (issue #310)", () => {
  const REF_URL = "https://github.com/o/r/issues/";
  const dep = { code: "dependency", reason_code: "dependency", params: { refs: "#12 and #13" }, alarms: [], holder_id: null, next_actor: "other_item" as const, refs: [12, 13], ref_url: REF_URL };
  const held = { code: "held", reason_code: "held_pr", params: { holder: "#92" }, alarms: [], holder_id: null, next_actor: "other_item" as const, refs: [92], ref_url: REF_URL };
  const refLinks = (el: HTMLElement) => [...el.querySelectorAll("[data-why] a")].map((a) => [a.textContent, a.getAttribute("href")]);

  function withWhy(run: () => Promise<void>) {
    const saved = { items: items.items.map((i) => ({ ...i })), queue: queue.queue.map((q) => ({ ...q })), item: { ...detail.item } };
    (items.items[0] as Record<string, unknown>).why = dep;
    (items.items[2] as Record<string, unknown>).why = held;
    (queue.queue[0] as Record<string, unknown>).why = held;
    (detail.item as Record<string, unknown>).why = dep;
    return run().finally(() => {
      items.items.splice(0, items.items.length, ...saved.items);
      queue.queue.splice(0, queue.queue.length, ...saved.queue);
      delete (detail.item as Record<string, unknown>).why;
    });
  }
  const dependencyLinks = [["#12", `${REF_URL}12`], ["#13", `${REF_URL}13`]];

  it("Work items and the Queued filter show the same sentences, #N linked", () =>
    withWhy(async () => {
      localStorage.setItem(VIEW_KEY, "list");
      history.replaceState(null, "", "/app/items");
      mount();
      const all = await screen.findByRole("table", { name: "Work items" });
      expect(refLinks(all)).toEqual([...dependencyLinks, ["#92", `${REF_URL}92`]]);
      cleanup();
      history.replaceState(null, "", "/app/items?state=queued");
      mount();
      const q = await screen.findByRole("table", { name: "Queued runs" });
      expect(within(q).queryByText("now")).toBeNull();
      expect(refLinks(q)).toEqual([["#92", `${REF_URL}92`]]);
    }));

  it("the item page shows the full sentence, not cut off, #N linked, and no raw blocked_on row", () =>
    withWhy(async () => {
      history.replaceState(null, "", "/app/items/wi_1");
      mount();
      const why = await screen.findByTestId("why");
      expect(why.textContent).toBe(whyText(dep));
      expect(refLinks(why)).toEqual(dependencyLinks);
      for (let el: HTMLElement | null = why; el; el = el.parentElement) expect(el.className).not.toContain("truncate");
      expect(why.querySelector(".truncate")).toBeNull();
      expect(screen.queryByText("Blocked on")).toBeNull();
    }));

  it("a ref with no ref_url, or a number the API did not list, stays plain text", () => {
    const c = itemsTable([trow(1, { why: { ...dep, ref_url: null } }), trow(2, { why: { ...dep, refs: [12] } })]);
    const cells = [...c.querySelectorAll("[data-why]")] as HTMLElement[];
    expect(refLinks(cells[0]!)).toEqual([]);
    expect(refLinks(cells[1]!)).toEqual([["#12", `${REF_URL}12`]]);
    expect(cells[1]!.textContent).toBe(whyText(dep));
  });
});

describe("open alarms on the Tasks page and the why sentence (design 09-status-page)", () => {
  const ALARM = "Alarm: checks_failed failed 4 runs on several items";
  const action = {
    code: "alarm", text: `${ALARM}: npm test exited #`, command: "Failures page (/app/failures)", until: "2026-11-07T06:00:00.000Z", work_item_id: null,
    pattern: "repeated_error", error_code: "checks_failed",
  };
  /** A red main alarm whose check kept no output (an older stop or a flagged tail). */
  const redMain = { ...action, text: "Alarm: the base branch fails its checks on its own at `abc`", pattern: "red_main", error_code: "red_main", failing_tests: [], output_tail: null };
  const failures = {
    as_of: AT, window: "24h", cap: 500, total: 1, capped: false,
    groups: [{ code: "checks_failed", count: 4, last_seen: AT, items: 2, runs: [{ id: "run_f", work_item_id: "wi_1", kind: "implement", attempt: 1, detail: "npm test exited 1", worker: null, finished_at: AT }] }],
  };
  const plain = { code: "queued", reason_code: "queued_at", params: { position: 1 }, alarms: [] as string[], holder_id: null, next_actor: "factory" as const, refs: [], ref_url: null };
  const alarmed = { ...plain, alarms: [ALARM] };

  /** Runs `run` with the overview's alarm and the why sentences set, then puts the fixtures back. */
  function withAlarm(run: () => Promise<void>) {
    const saved = { items: items.items.map((i) => ({ ...i })), item: { ...detail.item } };
    (overview as Record<string, unknown>).system_actions = [action];
    for (const i of items.items) (i as Record<string, unknown>).why = alarmed;
    (detail.item as Record<string, unknown>).why = alarmed;
    return run().finally(() => {
      delete (overview as Record<string, unknown>).system_actions;
      items.items.splice(0, items.items.length, ...saved.items);
      delete (detail.item as Record<string, unknown>).why;
    });
  }
  /** The next poll answers as if the alarm closed: no system action, sentences without it. */
  async function resolve() {
    (overview as Record<string, unknown>).system_actions = [];
    for (const i of items.items) (i as Record<string, unknown>).why = plain;
    (detail.item as Record<string, unknown>).why = plain;
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS + 10)));
  }

  it("the Tasks page lists the open alarm as a Needs-you row in the Check group whose Show failures opens its failure group on the page, and drops it once resolved", () =>
    withAlarm(async () => {
      RESPONSES["/api/v1/failures"] = failures;
      try {
        mount();
        const list = await screen.findByRole("list", { name: "Check" });
        const li = list.querySelector('[data-check="alarm"]') as HTMLElement;
        expect(li.querySelector("[data-alarm-summary]")!.textContent).toBe(action.text);
        // Its menu's one item shows the alarm's failures (data-action "show_failures"); the row has no link to Failures.
        fireEvent.click(within(li).getByRole("button", { name: "More commands" }));
        expect(within(li).getAllByRole("menuitem").map((m) => [m.textContent, m.getAttribute("data-action")])).toEqual([["Show failures", "show_failures"]]);
        expect(within(li).queryByRole("link")).toBeNull();
        fireEvent.click(within(li).getByRole("menuitem", { name: "Show failures" }));
        const dialog = document.querySelector<HTMLElement>("dialog[data-dialog]")!;
        expect(await within(dialog).findByText("Project checks failed")).toBeTruthy();
        expect(location.pathname).not.toContain("health");
        fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
        expect(document.body.textContent).not.toContain("Open alarms");
        expect(screen.queryByRole("list", { name: "System actions" })).toBeNull();
        await resolve();
        await vi.waitFor(() => expect(screen.queryByRole("list", { name: "Check" })).toBeNull());
      } finally {
        delete RESPONSES["/api/v1/failures"];
      }
    }));

  it("a red main alarm row's only menu item is What failed, which says no output was kept when the check kept none", () =>
    withAlarm(async () => {
      (overview as Record<string, unknown>).system_actions = [redMain];
      mount();
      const li = (await screen.findByRole("list", { name: "Check" })).querySelector('[data-check="alarm"]') as HTMLElement;
      fireEvent.click(within(li).getByRole("button", { name: "More commands" }));
      expect(within(li).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["What failed"]);
      fireEvent.click(within(li).getByRole("menuitem", { name: "What failed" }));
      const dialog = document.querySelector<HTMLElement>("dialog[data-dialog]")!;
      expect(within(dialog).getByText("No output kept for this check.")).toBeTruthy();
      expect(dialog.querySelector("pre")).toBeNull();
    }));

  it("Work items and the item page name the alarm in the item's why, and drop it once it is resolved", () =>
    withAlarm(async () => {
      localStorage.setItem(VIEW_KEY, "list");
      history.replaceState(null, "", "/app/items");
      mount();
      const all = await screen.findByRole("table", { name: "Work items" });
      expect(within(all).getAllByText(ALARM, { exact: false }).length).toBeGreaterThan(0);
      cleanup();
      history.replaceState(null, "", "/app/items/wi_1");
      mount();
      const why = await screen.findByTestId("why");
      expect(why.textContent).toBe(`Queued at position 1. ${ALARM}`);
      await resolve();
      await vi.waitFor(() => expect(screen.getByTestId("why").textContent).toBe("Queued at position 1"));
    }));
});

