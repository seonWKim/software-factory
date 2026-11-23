// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SegmentedControl } from "../web/src/components/ui/segmented-control.js";

// The shared segmented control (design-system/components.md): a native-looking radiogroup on one track, equal
// segment widths, a raised thumb under the checked segment, neutral in both themes, arrows move the choice.

afterEach(cleanup);

const OPTIONS = [
  { id: "a", label: "Inbox" },
  { id: "b", label: "Today" },
  { id: "c", label: "Upcoming" },
] as const;

function Host() {
  const [value, setValue] = useState<"a" | "b" | "c">("b");
  return <SegmentedControl label="View" options={OPTIONS} value={value} onChange={setValue} />;
}

const checked = () => screen.getAllByRole("radio").filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.textContent);
const thumb = () => document.querySelector<HTMLElement>("[data-thumb]")!;

describe("SegmentedControl", () => {
  it("is a named radiogroup; only the checked segment is aria-checked and in the tab order, and a click moves it", () => {
    render(<Host />);
    const group = screen.getByRole("radiogroup", { name: "View" });
    expect(within(group).getAllByRole("radio").map((b) => b.textContent)).toEqual(["Inbox", "Today", "Upcoming"]);
    expect(checked()).toEqual(["Today"]);
    expect(screen.getAllByRole("radio").map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.click(screen.getByRole("radio", { name: "Upcoming" }));
    expect(checked()).toEqual(["Upcoming"]);
  });

  it("arrows move the choice and the focus, wrapping at the ends; Home and End go to the first and last", () => {
    render(<Host />);
    const today = screen.getByRole("radio", { name: "Today" });
    fireEvent.keyDown(today, { key: "ArrowRight" });
    expect(checked()).toEqual(["Upcoming"]);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Upcoming" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(checked()).toEqual(["Inbox"]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(checked()).toEqual(["Upcoming"]);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(checked()).toEqual(["Inbox"]);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(checked()).toEqual(["Upcoming"]);
  });

  it("is one track of equal-width 28px segments that never wraps; the thumb is one segment wide and slides to the checked one", () => {
    render(<Host />);
    const group = screen.getByRole("radiogroup", { name: "View" }).className.split(/\s+/);
    expect(group).toEqual(expect.arrayContaining(["inline-grid", "grid-flow-col", "auto-cols-fr", "bg-surface-2", "rounded-control", "p-0.5"]));
    expect(group.join(" ")).not.toContain("wrap");
    const segment = screen.getByRole("radio", { name: "Today" }).className.split(/\s+/);
    expect(segment).toEqual(expect.arrayContaining(["whitespace-nowrap", "min-h-7", "text-text-1"]));
    expect(screen.getByRole("radio", { name: "Inbox" }).className.split(/\s+/)).toContain("text-text-2");
    // jsdom normalises the calc: a third of the track's inner width (100% less its 2px padding each side).
    expect(thumb().style.width.replace(/\s+/g, "")).toMatch(/^calc\(0\.333+\*\(100%-0\.25rem\)\)$/);
    expect(thumb().style.transform).toBe("translateX(100%)");
    fireEvent.click(screen.getByRole("radio", { name: "Upcoming" }));
    expect(thumb().style.transform).toBe("translateX(200%)");
  });

  it("draws the thumb raised and neutral in both themes (surface with shadow in light, border-strong in dark), from tokens only", () => {
    render(<Host />);
    const t = thumb().className.split(/\s+/);
    expect(t).toEqual(expect.arrayContaining(["bg-surface", "shadow-sm", "dark:bg-border-strong", "motion-safe:transition-transform"]));
    expect(t.join(" ")).not.toContain("accent");
    expect(readFileSync("web/src/components/ui/segmented-control.tsx", "utf8")).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  it("draws no thumb when no segment matches the value, and the first segment takes the tab stop", () => {
    render(<SegmentedControl label="Pick" options={OPTIONS} value={"z" as "a"} onChange={() => {}} />);
    expect(document.querySelector("[data-thumb]")).toBeNull();
    expect(screen.getAllByRole("radio").map((b) => b.tabIndex)).toEqual([0, -1, -1]);
  });
});
