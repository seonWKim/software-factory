// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataTable } from "../web/src/components/ui/data-table.js";
import { SM_PX, Table, Td, Tr } from "../web/src/components/ui/parts.js";
import { ItemsTable } from "../web/src/views/common.js";

// The shared Table (design §9): a table at sm and up; below sm one card per row, with no table element and no
// horizontal scroll. The first cell is the card's title, the second sits under it, the rest carry their column name.

const AT = "2026-11-07T00:00:00.000Z";
const NOW = Date.parse(AT);
const WIDE = window.innerWidth;

function width(px: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
  window.dispatchEvent(new Event("resize"));
}

afterEach(() => {
  cleanup();
  width(WIDE);
});

const sample = (
  <Table label="Sample" head={["Name", "State", "Why", "Since", "PR"]}>
    <Tr data-key="a">
      <Td>Alpha</Td>
      <Td>running</Td>
      <Td>building it</Td>
      <Td>4m</Td>
      {false && <Td>never shown</Td>}
      <Td>#9</Td>
    </Tr>
  </Table>
);

describe("Table", () => {
  it("below sm its cards have no side border or side padding, so inside a Card the phone draws one box, not two", () => {
    width(390);
    render(sample);
    const list = screen.getByRole("list", { name: "Sample" }).className.split(" ");
    expect(list).toEqual(expect.arrayContaining(["max-sm:border-x-0", "max-sm:rounded-none"]));
    expect(document.querySelector('li[data-key="a"]')!.className.split(" ")).toContain("px-0");
  });

  it("at sm and up it is a table with a header row and the data attributes on the row", () => {
    width(SM_PX);
    render(sample);
    const table = screen.getByRole("table", { name: "Sample" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "State", "Why", "Since", "PR"]);
    expect(table.querySelector('tr[data-key="a"]')!.querySelectorAll("td")).toHaveLength(5);
  });

  it("below sm each row is a card: title first, the second cell alone under it, the rest named by their column from the third", () => {
    width(390);
    render(sample);
    expect(document.querySelector("table")).toBeNull();
    const list = screen.getByRole("list", { name: "Sample" });
    expect(list.className).not.toMatch(/overflow-x/);
    const card = list.querySelector<HTMLElement>('li[data-key="a"]')!;
    const [title, under, rest] = [...card.children] as HTMLElement[];
    expect(title!.textContent).toBe("Alpha");
    expect(under!.textContent).toBe("running");
    expect([...rest!.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Why", "Since", "PR"]);
    expect([...rest!.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(["building it", "4m", "#9"]);
  });

  it("below sm a cell with nothing in it is not listed, and the next one keeps its own column name", () => {
    width(390);
    render(
      <Table label="Gaps" head={["Name", "State", "Why", "Reset"]}>
        <Tr data-key="g">
          <Td>Gamma</Td>
          <Td>idle</Td>
          <Td>{false}</Td>
          <Td>x</Td>
        </Tr>
      </Table>,
    );
    const rest = screen.getByRole("list", { name: "Gaps" }).querySelector<HTMLElement>("dl")!;
    expect([...rest.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Reset"]);
  });

  it("switches when the window crosses sm", () => {
    width(1024);
    render(sample);
    expect(screen.queryByRole("table")).not.toBeNull();
    act(() => width(390));
    expect(screen.queryByRole("table")).toBeNull();
    act(() => width(800));
    expect(screen.queryByRole("table")).not.toBeNull();
  });
});

describe("Needs you at 390px", () => {
  const row = (n: number, level: string, title: string, why: string) => ({
    id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title, item_phase: level, reason_code: "person",  stage: "READY", tier: 2,
    kind: null, blocked_on: "human", blocked_reason: null, close_reason: null, run_status: null, change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1,
    dependents: 0, conflicts: { automatic: 0, person: 0 }, why: { code: "x", reason_code: why, params: {}, alarms: [], holder_id: null, next_actor: "human", refs: [], ref_url: null },
  });

  it("shows title, state and why as stacked cards, with no table and no horizontal scroll", () => {
    width(390);
    render(
      <ItemsTable
        label="Needs you"
        now={NOW}
        empty="none"
        plugins={{ issues: "github" }}
        items={[row(1, "needs_approval", "A rather long title that must wrap on a phone", "Waits for your /approve on the spec."), row(2, "ready_to_merge", "Merge me", "Ready for your merge.")]}
      />,
    );
    expect(document.querySelector("table")).toBeNull();
    const cards = within(screen.getByRole("list", { name: "Needs you" })).getAllByRole("listitem");
    expect(cards.map((c) => c.getAttribute("data-key"))).toEqual(["wi_1", "wi_2"]);
    expect(cards.map((c) => c.getAttribute("data-item-id"))).toEqual(["wi_1", "wi_2"]);
    // An ItemRow's first cell is its state; the title, the link, sits under it.
    const [state, under] = [...cards[0]!.children] as HTMLElement[];
    expect(state!.textContent).toContain("Needs approval");
    expect(within(under!).getByRole("link").textContent).toBe("A rather long title that must wrap on a phone");
    // The title wraps in a card.
    expect(within(under!).getByRole("link").className).not.toMatch(/(^|\s)truncate(\s|$)/);
    expect(cards[0]!.querySelector("dl")!.textContent).toContain("Waits for your /approve on the spec.");
    for (const el of document.querySelectorAll("*")) expect(el.className).not.toMatch(/overflow-x-(auto|scroll)/);
  });
});

describe("DataTable dataKey", () => {
  const rows = [{ id: "a", n: "Alpha" }, { id: "b", n: "Beta" }];
  const columns = [{ key: "n", header: "Name" }];

  it("sets data-key on each row to its rowKey, in the table and in the cards", () => {
    width(SM_PX);
    const { unmount } = render(<DataTable label="T" columns={columns} rows={rows} rowKey={(r) => r.id} empty="None" dataKey />);
    expect([...document.querySelectorAll("tbody tr")].map((tr) => tr.getAttribute("data-key"))).toEqual(["a", "b"]);
    unmount();
    width(390);
    render(<DataTable label="T" columns={columns} rows={rows} rowKey={(r) => r.id} empty="None" dataKey />);
    expect([...document.querySelectorAll("li[data-key]")].map((li) => li.getAttribute("data-key"))).toEqual(["a", "b"]);
  });

  it("leaves the attribute off without dataKey", () => {
    width(SM_PX);
    render(<DataTable label="T" columns={columns} rows={rows} rowKey={(r) => r.id} empty="None" />);
    expect(document.querySelector("[data-key]")).toBeNull();
  });
});

describe("DataTable select", () => {
  const rows = [{ id: "a", n: "Alpha", s: "on" }, { id: "b", n: "Beta", s: "off" }];
  const columns = [{ key: "n", header: "Name" }, { key: "s", header: "State" }];
  const table = (key: string | null, onSelect = (_: string) => {}) => (
    <DataTable label="T" columns={columns} rows={rows} rowKey={(r) => r.id} empty="None" select={{ key, onSelect, label: (r) => `Show ${r.n}` }} />
  );

  it("marks only the selected row as current, in the table and in the cards; none when nothing is selected", () => {
    width(SM_PX);
    const { rerender, unmount } = render(table("b"));
    const current = () => [...document.querySelectorAll("[aria-current=true]")].map((el) => el.textContent);
    expect(current()).toEqual(["Betaoff"]);
    expect(document.querySelector("tr[aria-current=true]")!.className).toContain("bg-surface-2");
    rerender(table(null));
    expect(current()).toEqual([]);
    unmount();
    width(390);
    render(table("a"));
    expect(document.querySelector("li[aria-current=true]")!.textContent).toContain("Alpha");
  });

  it("the first cell is a named text button that selects its row by key, pressed on the selected row", () => {
    width(SM_PX);
    const picked: string[] = [];
    render(table("a", (k) => picked.push(k)));
    const beta = screen.getByRole("button", { name: "Show Beta" });
    beta.click();
    expect(picked).toEqual(["b"]);
    expect(screen.getByRole("button", { name: "Show Alpha" }).getAttribute("aria-pressed")).toBe("true");
    expect(beta.getAttribute("aria-pressed")).toBe("false");
    // A Button would draw a pill (surface-2 when pressed); this one is the cell's whole 32px first line, so its text is
    // centred on the row's centre line with the other cells (Td's CELL_LINE starts a 32px control at the top).
    expect(beta.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-8"]));
    expect(beta.className).not.toContain("-my-");
    expect(beta.className).not.toMatch(/aria-pressed:bg/);
  });
});

// Owner feedback 2026-11-24 (#83, Schedules): the text sat at the top of each row while the Switch and the ⋯ sat lower.
// Every cell's content starts on the row's one 32px line: text 6px down (its 20px line centred on it), a 32px button
// at the top, a 28px one 2px down, a 24px Switch 4px down, so all of them share one centre line.
describe("Td puts every cell on the row's centre line", () => {
  const line = (cell: string) => render(<Table label="T" head={["A"]}><Tr><Td>{cell}</Td></Tr></Table>).container.querySelector("td > [data-cell-line]")!;
  it("wraps each cell's content in the one cell line, with the offsets for text and controls", () => {
    width(SM_PX);
    const cls = line("Every day at 09:00").className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["py-1.5", "has-[button.min-h-8,button.size-8]:py-0", "has-[button.min-h-7]:py-0.5", "has-[[role=switch]]:py-1"]));
  });
});

describe("DataTable cards keep long values inside the card", () => {
  const id = `wi_${"a".repeat(60)}`;
  const prose = `${"x".repeat(80)} and more words`;
  const rows = [{ k: "r", copy: "Copy", id, note: prose }];
  const columns = [
    { key: "copy", header: "Copy" },
    { key: "state", header: "State", render: () => "on" },
    { key: "id", header: "work_item_id", className: "max-w-md font-mono break-words", render: (r) => <a href={`/items/${r.id}`} data-id title={r.id}>{r.id}</a> },
    { key: "note", header: "note", className: "max-w-md font-mono break-words whitespace-pre-wrap" },
  ];

  // The Data page's work_item_id link ran past the card's right edge at 390px (2026-11-24): `break-words` does not
  // shrink an inline-block link below its longest word, and nothing capped the link at the cell's width.
  it("below sm a value cell shrinks and wraps anywhere, its links fit the cell and an ID link is cut with its full value kept; at sm the table is unchanged", () => {
    width(390);
    render(<DataTable label="T" columns={columns} rows={rows} rowKey={(r) => r.k} empty="None" />);
    const values = [...document.querySelectorAll("dd > div")] as HTMLElement[];
    expect(values).toHaveLength(2);
    for (const cell of values) {
      const classes = cell.className.split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining(["min-w-0", "wrap-anywhere", "[&_a]:max-w-full", "[&_a[data-id]]:truncate"]));
      // The column's break-words would undo wrap-anywhere, and its width cap is the table's.
      expect(classes).not.toContain("break-words");
      expect(classes).not.toContain("max-w-md");
    }
    const link = screen.getByRole("link", { name: id });
    expect(link.getAttribute("title")).toBe(id);
    expect(link.parentElement).toBe(values[0]);
    expect(document.querySelector("li > div")!.className.split(/\s+/)).toContain("wrap-anywhere");
    cleanup();
    // At sm and up the table keeps its column classes and gets none of the card's.
    width(SM_PX);
    render(<DataTable label="T" columns={columns} rows={rows} rowKey={(r) => r.k} empty="None" />);
    for (const td of document.querySelectorAll("td")) expect(td.className).not.toMatch(/wrap-anywhere|\[&_a/);
    expect(document.querySelectorAll("td")[2]!.className).toContain("max-w-md font-mono break-words");
  });
});
