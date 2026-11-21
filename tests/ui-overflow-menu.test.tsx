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
