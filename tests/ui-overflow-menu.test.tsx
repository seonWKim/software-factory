// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverflowMenu } from "../web/src/components/ui/menu.js";

// jsdom has no layout, so each element's rectangle is stubbed: the page content (`main`) starts at x = 300 (a 300 px
// sidebar beside it), the menu's list is 160 px wide, and the "⋯" button sits where each test puts it.
function rects(buttonLeft: number) {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 32, height: 32, x: left, y: 0, toJSON() {} });
    if (this.tagName === "MAIN") return box(300, 1200);
    if (this.getAttribute("role") === "menu") return box(0, 160);
    return box(buttonLeft, 32);
  });
}

function openMenu() {
  render(
    <main>
      <OverflowMenu label="Actions" items={[{ label: "Promote", onSelect: vi.fn() }, { label: "Reject", onSelect: vi.fn() }]} />
    </main>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Actions" }));
  return screen.getByRole("menu");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OverflowMenu placement", () => {
  it("the list's side follows data-side: right-0 for end, left-0 for start", () => {
    rects(1400);
    expect(openMenu().className.split(" ")).toEqual(expect.arrayContaining(["data-[side=end]:right-0", "data-[side=start]:left-0"]));
  });

  it("starts at the button's left edge when ending at its right edge would put the labels under the sidebar", () => {
    // Button at x 324–356: a 160 px list ending at 356 would start at 196, left of the content's edge (300).
    rects(324);
    const menu = openMenu();
    expect(menu.getAttribute("data-side")).toBe("start");
  });

  it("ends at the button's right edge when there is room on its left", () => {
    rects(1400);
    const menu = openMenu();
    expect(menu.getAttribute("data-side")).toBe("end");
  });
});

describe("OverflowMenu look and keys (owner design review #85)", () => {
  const Pencil = (p: object) => <svg data-icon="pencil" {...p} />;
  function openRich(onEdit = vi.fn()) {
    render(
      <main>
        <OverflowMenu
          label="Actions"
          items={[
            { label: "Edit", icon: Pencil, shortcut: "e", onSelect: onEdit },
            { label: "Plain", onSelect: vi.fn() },
            { label: "Off", disabled: true, onSelect: vi.fn() },
            { separator: true },
            { group: "Danger zone" },
            { label: "Delete", danger: true, onSelect: vi.fn() },
          ]}
        />
      </main>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    return screen.getByRole("menu");
  }

  it("keeps one icon column: an item without an icon gets an empty slot, so the labels line up", () => {
    rects(1400);
    openRich();
    // The first child of each item is its 16px icon slot: the svg for Edit, an empty span for the others.
    expect(screen.getAllByRole("menuitem").map((b) => [b.firstElementChild!.tagName.toLowerCase(), b.firstElementChild!.getAttribute("class")])).toEqual([
      ["svg", "size-4 shrink-0 text-text-2"],
      ["span", "size-4 shrink-0"],
      ["span", "size-4 shrink-0"],
      ["span", "size-4 shrink-0"],
    ]);
  });

  it("draws the separator and the group label as non-items, and the shortcut as a hint, not in the label", () => {
    rects(1400);
    const menu = openRich();
    expect(menu.querySelectorAll("[role=separator]").length).toBe(1);
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Edit", "Plain", "Off", "Delete"]);
    expect(menu.textContent).toContain("Danger zone");
    const edit = screen.getByRole("menuitem", { name: "Edit" });
    expect(edit.getAttribute("aria-keyshortcuts")).toBe("e");
    expect(edit.querySelector("kbd")?.getAttribute("data-key")).toBe("e");
    expect(screen.getByRole("menuitem", { name: "Delete" }).className).toContain("text-pill-bad-fg");
  });

  it("focuses the first item on open; arrows move round the enabled items, skipping a disabled one", () => {
    rects(1400);
    const menu = openRich();
    const name = () => document.activeElement?.textContent;
    expect(name()).toBe("Edit");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(name()).toBe("Plain");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(name()).toBe("Delete");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(name()).toBe("Edit");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(name()).toBe("Delete");
    fireEvent.keyDown(menu, { key: "Home" });
    expect(name()).toBe("Edit");
    fireEvent.keyDown(menu, { key: "p" });
    expect(name()).toBe("Plain");
  });

  it("ArrowUp on the closed button opens it on the last item; choosing an item gives the focus back to the button", () => {
    rects(1400);
    const onEdit = vi.fn(() => document.activeElement);
    openRich(onEdit);
    const button = screen.getByRole("button", { name: "Actions" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    // The button has the focus when the item acts, so a dialog it opens returns the focus there.
    expect(onEdit.mock.results[0]!.value).toBe(button);
    fireEvent.keyDown(button, { key: "ArrowUp" });
    expect(document.activeElement?.textContent).toBe("Delete");
  });

  it("opens above the button when the viewport has no room below", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const box = (left: number, top: number, width: number, height: number) => ({ left, right: left + width, width, top, bottom: top + height, height, x: left, y: top, toJSON() {} });
      if (this.tagName === "MAIN") return box(300, 0, 1200, innerHeight);
      if (this.getAttribute("role") === "menu") return box(0, 0, 192, 160);
      return box(1400, innerHeight - 40, 32, 32);
    });
    const menu = openMenu();
    expect(menu.getAttribute("data-up")).toBe("true");
    expect(menu.className).toContain("bottom-full");
  });
});
