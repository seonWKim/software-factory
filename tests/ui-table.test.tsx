// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SM_PX, Table, Td, Tr } from "../web/src/components/ui/parts.js";
import { ItemsTable } from "../web/src/views/common.js";

// The shared Table (design §9): a table at sm and up; below sm one card per row, with no table element and no
// horizontal scroll. The first cell is the card's title, the next two sit under it, the rest carry their column name.

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
  it("at sm and up it is a table with a header row and the data attributes on the row", () => {
    width(SM_PX);
    render(sample);
    const table = screen.getByRole("table", { name: "Sample" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "State", "Why", "Since", "PR"]);
    expect(table.querySelector('tr[data-key="a"]')!.querySelectorAll("td")).toHaveLength(5);
  });

  it("below sm each row is a card: title first, the next two under it, the rest named by their column", () => {
    width(390);
    render(sample);
    expect(document.querySelector("table")).toBeNull();
    const list = screen.getByRole("list", { name: "Sample" });
    expect(list.className).not.toMatch(/overflow-x/);
    const card = list.querySelector<HTMLElement>('li[data-key="a"]')!;
    const [title, under, rest] = [...card.children] as HTMLElement[];
    expect(title!.textContent).toBe("Alpha");
    expect([...under!.children].map((c) => c.textContent)).toEqual(["running", "building it"]);
    expect([...rest!.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Since", "PR"]);
    expect([...rest!.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(["4m", "#9"]);
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
    id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title, level, badges: [], stage: "READY", tier: 2,
    kind: null, blocked_on: "human", blocked_reason: null, close_reason: null, run_status: null, pr_number: null, pr_url: null, since: AT, updated_at: AT, version: 1,
    dependents: 0, conflicts: { automatic: 0, person: 0 }, why: { code: "x", text: why, next_actor: "human", refs: [], ref_url: null },
  });

  it("shows title, state and why as stacked cards, with no table and no horizontal scroll", () => {
    width(390);
    render(
      <ItemsTable
        label="Needs you"
        now={NOW}
        empty="none"
        plugins={{ issues: "github", prs: "github" }}
        items={[row(1, "needs_approval", "A rather long title that must wrap on a phone", "Waits for your /approve on the spec."), row(2, "ready_to_merge", "Merge me", "Ready for your merge.")]}
      />,
    );
    expect(document.querySelector("table")).toBeNull();
    const cards = within(screen.getByRole("list", { name: "Needs you" })).getAllByRole("listitem");
    expect(cards.map((c) => c.getAttribute("data-key"))).toEqual(["wi_1", "wi_2"]);
    const [title, under] = [...cards[0]!.children] as HTMLElement[];
    expect(within(title!).getByRole("link").textContent).toBe("A rather long title that must wrap on a phone");
    // The title wraps in a card; it is cut off only in the table.
    expect(within(title!).getByRole("link").className).not.toMatch(/(^|\s)truncate(\s|$)/);
    expect(under!.textContent).toContain("Needs approval");
    expect(under!.textContent).toContain("Waits for your /approve on the spec.");
    for (const el of document.querySelectorAll("*")) expect(el.className).not.toMatch(/overflow-x-(auto|scroll)/);
  });
});
