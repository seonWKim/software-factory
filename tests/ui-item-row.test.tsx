// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Checkbox } from "../web/src/components/ui/checkbox.js";
import { SM_PX } from "../web/src/components/ui/parts.js";
import { ItemsTable, RunningTable } from "../web/src/views/common.js";
import { ItemRow, ItemTable, ROW_SPACE } from "../web/src/views/item-row.js";
import { NeedsList } from "../web/src/views/task-work.js";

// The one ItemRow (design 09-dashboard-tasks, 09-dashboard-system, 09-dashboard-item): StatusBadge · title (the link)
// · why · project · worker · age · one primary action · ⋯ menu; a second line only for "held behind X" or an error;
// the work item's ID only as data-item-id and behind Copy ID; compact and comfortable differ in spacing only.

const AT = "2026-11-07T00:00:00.000Z";
const NOW = Date.parse(AT);
const RAW_ID = /\b(wi|tk|run|pj)_\w+/;
const WIDE = window.innerWidth;

const item = (n: number, extra: object = {}) => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title: `Title ${n}`, item_phase: "running",
  reason_code: "person", stage: "RUNNING", tier: 2, kind: null, blocked_on: "none", blocked_reason: null, close_reason: null, run_status: null,
  change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 },
  run: { kind: "implement", status: "running", attempt: 2, worker_id: "host:3:0", started_at: AT, position: null }, ...extra,
});
const run = (n: number) => ({ id: `run_${n}`, status: "running", kind: "implement", work_item_id: `wi_${n}`, attempt: 2, owner: "host:3:0", heartbeat_at: AT, started_at: AT, lease_expires_at: AT, created_at: AT });

function width(px: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
  window.dispatchEvent(new Event("resize"));
}

afterEach(() => {
  cleanup();
  width(WIDE);
  vi.restoreAllMocks();
});

const listRow = (props: object) => render(<ul><ItemRow variant="compact" title="A title" href="/app/items/wi_1" itemId="wi_1" {...props} /></ul>).container.querySelector<HTMLElement>("li")!;
const classes = (el: Element) => new Set(el.className.split(/\s+/).filter(Boolean));

describe("ItemRow", () => {
  it("carries data-item-id; the title is the link to the item; no raw ID is row text, Copy ID copies it", async () => {
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
    const li = listRow({ badge: <span>Running</span>, menuLabel: "More actions: A title", copyId: "wi_1" });
    expect(li.dataset.itemId).toBe("wi_1");
    const link = within(li).getByRole("link", { name: "A title" });
    expect(link.getAttribute("href")).toBe("/app/items/wi_1");
    expect(li.textContent).not.toMatch(RAW_ID);
    fireEvent.click(within(li).getByRole("button", { name: "More actions: A title" }));
    const copy = within(li).getByRole("menuitem", { name: "Copy ID" });
    fireEvent.click(copy);
    expect(write).toHaveBeenCalledWith("wi_1");
  });

  it("puts the slots in the row order: badge, title, why, project, worker, age, action, then the menu", () => {
    const li = listRow({
      badge: <span data-slot="badge">B</span>, why: <span data-slot="why">W</span>, project: <span data-slot="project">P</span>,
      worker: <span data-slot="worker">K</span>, age: <span data-slot="age">A</span>, action: <button type="button" data-slot="action">Go</button>, menuItems: [{ label: "Other", onSelect: () => undefined }],
    });
    const order = [...li.querySelectorAll("[data-slot], [data-row-title], [data-row-menu]")].map((e) => e.getAttribute("data-slot") ?? (e.hasAttribute("data-row-title") ? "title" : "menu"));
    expect(order).toEqual(["badge", "title", "why", "project", "worker", "age", "action", "menu"]);
  });

  it("shows a second line only when one is given (held behind X, or an error)", () => {
    expect(listRow({ why: "why" }).querySelector("[data-row-second]")).toBeNull();
    cleanup();
    const li = listRow({ second: <span role="alert">it failed</span> });
    expect(li.querySelector("[data-row-second]")!.textContent).toBe("it failed");
    cleanup();
    const table = render(<ItemTable label="T" empty="none" head={{ badge: "S", title: "I", why: "W", project: "P", worker: "K", age: "A", actions: "X" }}
      rows={[{ key: "a", itemId: "wi_1", title: "One", href: "/app/items/wi_1" }, { key: "b", itemId: "wi_2", title: "Two", href: "/app/items/wi_2", second: "Held behind One" }]} />).container;
    const [one, two] = [...table.querySelectorAll<HTMLElement>("[data-item-id]")];
    expect(one!.querySelector("[data-row-second]")).toBeNull();
    expect(two!.querySelector("[data-row-second]")!.textContent).toBe("Held behind One");
  });

  it("an item with no page (an unbuilt task) shows its title as plain text", () => {
    const li = render(<ul><ItemRow variant="comfortable" title="Plain" data-task="tk_1" /></ul>).container.querySelector<HTMLElement>("li")!;
    expect(within(li).queryByRole("link")).toBeNull();
    expect(within(li).getByText("Plain").tagName).toBe("P");
    expect(li.hasAttribute("data-item-id")).toBe(false);
    expect(li.dataset.task).toBe("tk_1");
  });

  it("compact and comfortable differ only in spacing classes, in the list and the tree", () => {
    const spacing = /^(gap(-[xy])?|p[xytblr]?|m[xytblr]?)-/;
    for (const layout of ["list", "tree"] as const) {
      expect(ROW_SPACE[layout].compact).not.toBe(ROW_SPACE[layout].comfortable);
      for (const cls of [...ROW_SPACE[layout].compact.split(" "), ...ROW_SPACE[layout].comfortable.split(" ")]) expect(cls).toMatch(spacing);
    }
    const one = (variant: string) => render(<ul><ItemRow variant={variant} title="T" href="/x" itemId="wi_1" badge={<span>B</span>} why="w" /></ul>).container.querySelector("li")!;
    const [compact, comfortable] = [one("compact"), one("comfortable")];
    expect(compact.dataset.itemRow).toBe("compact");
    expect(comfortable.dataset.itemRow).toBe("comfortable");
    const a = [compact, ...compact.querySelectorAll("*")];
    const b = [comfortable, ...comfortable.querySelectorAll("*")];
    expect(a.length).toBe(b.length);
    a.forEach((el, i) => {
      const [x, y] = [classes(el), classes(b[i]!)];
      const diff = [...x].filter((c) => !y.has(c)).concat([...y].filter((c) => !x.has(c)));
      for (const c of diff) expect(c, el.outerHTML).toMatch(spacing);
    });
    cleanup();
    const tree = (variant: string) => render(<ItemRow layout="tree" variant={variant} title="T" href="/x" itemId="wi_1" />).container.firstElementChild!;
    const [tc, tf] = [tree("compact"), tree("comfortable")];
    const diff = [...classes(tc)].filter((c) => !classes(tf).has(c)).concat([...classes(tf)].filter((c) => !classes(tc).has(c)));
    expect(diff.length).toBeGreaterThan(0);
    for (const c of diff) expect(c).toMatch(spacing);
  });
});

describe("the lists render ItemRow", () => {
  it("Work's table: every row has data-item-id, no raw ID in its text, and keeps its narrow-screen cards", () => {
    width(SM_PX);
    const rows = [item(1), item(2, { title: null })];
    const { container, unmount } = render(<ItemsTable items={rows} now={NOW} label="Work items" empty="none" />);
    const trs = [...container.querySelectorAll<HTMLElement>("tbody tr")];
    expect(trs.map((tr) => tr.dataset.itemId)).toEqual(["wi_1", "wi_2"]);
    for (const tr of trs) expect(tr.textContent).not.toMatch(RAW_ID);
    unmount();
    width(390);
    const cards = render(<ItemsTable items={rows} now={NOW} label="Work items" empty="none" />).container.querySelectorAll<HTMLElement>("li[data-item-id]");
    expect([...cards].map((c) => c.dataset.itemId)).toEqual(["wi_1", "wi_2"]);
  });

  it("Runners' running runs: the title is the item's title, the row has its item's ID, no run or item ID in the text", () => {
    const items = new Map([["wi_4", item(4)]]);
    const { container } = render(<RunningTable runs={[run(4)]} items={items} now={NOW} />);
    const tr = container.querySelector<HTMLElement>("tbody tr")!;
    expect(tr.dataset.itemId).toBe("wi_4");
    expect(within(tr).getByRole("link", { name: "Title 4" }).getAttribute("href")).toBe("/app/items/wi_4");
    expect(tr.textContent).toContain("Implement #2");
    expect(tr.textContent).not.toMatch(RAW_ID);
    // The stored title is raw text (the responsive raw-name rule skips it); a table's title column wraps, so it is a
    // cell title, not a one-line row title (title-wrap).
    const title = within(tr).getByRole("link", { name: "Title 4" });
    expect(title.hasAttribute("data-raw")).toBe(true);
    expect(title.hasAttribute("data-cell-title")).toBe(true);
    expect(title.hasAttribute("data-row-title")).toBe(false);
    expect(title.className).not.toContain("truncate");
  });

  it("the Needs you rows: data-item-id, the title links, the ⋯ menu keeps only the item's commands (no Copy ID)", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    const cmd = (name: string) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null });
    const it7 = item(7, { item_phase: "needs_you", run: null, commands: ["verdict", "reject", "revise"].map(cmd) });
    render(<QueryClientProvider client={client}><NeedsList items={[it7]} /></QueryClientProvider>);
    const li = document.querySelector<HTMLElement>('li[data-item-id="wi_7"]')!;
    expect(li.dataset.itemRow).toBe("comfortable");
    expect(within(li).getByRole("link", { name: "Title 7" }).getAttribute("href")).toBe("/app/items/wi_7");
    expect(li.textContent).not.toMatch(RAW_ID);
    fireEvent.click(li.querySelector<HTMLButtonElement>("[data-row-menu] [aria-haspopup=menu]")!);
    expect(within(li).getAllByRole("menuitem").map((m) => m.textContent)).not.toContain("Copy ID");
  });
});

describe("Checkbox", () => {
  function Box({ disabled = false, onToggle = () => undefined }: { disabled?: boolean; onToggle?: (on: boolean) => void }) {
    const [on, setOn] = useState(false);
    return <Checkbox aria-label="Done" checked={on} disabled={disabled} onChange={() => { setOn(!on); onToggle(!on); }} />;
  }

  it("is a checkbox with aria-checked, toggled by a click, Space and Enter", () => {
    render(<Box />);
    const box = screen.getByRole("checkbox", { name: "Done" });
    expect(box.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(box);
    expect(box.getAttribute("aria-checked")).toBe("true");
    // Space toggles a native checkbox by its click; jsdom has no default action for keys, so the click stands for it.
    fireEvent.keyUp(box, { key: " " });
    fireEvent.click(box);
    expect(box.getAttribute("aria-checked")).toBe("false");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.getAttribute("aria-checked")).toBe("true");
  });

  it("honours disabled: neither a click nor Enter toggles it", () => {
    const onToggle = vi.fn();
    render(<Box disabled onToggle={onToggle} />);
    const box = screen.getByRole("checkbox", { name: "Done" });
    // A user's click: HTMLElement.click(), which a disabled control ignores (fireEvent dispatches past that check).
    act(() => box.click());
    expect(onToggle, "click").not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onToggle, "enter").not.toHaveBeenCalled();
    expect(box.getAttribute("aria-checked")).toBe("false");
  });
});
