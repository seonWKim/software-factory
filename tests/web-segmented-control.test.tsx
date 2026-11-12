// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SegmentedControl } from "../web/src/components/ui/segmented-control.js";

// The shared segmented control (docs/design/09-brand-and-tokens.md): one row that never wraps, the selected segment
// marked with aria-pressed and filled with the accent in both themes.

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

const pressed = () => screen.getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);

describe("SegmentedControl", () => {
  it("is a named group of buttons; only the selected one is aria-pressed, and a click moves it", () => {
    render(<Host />);
    const group = screen.getByRole("group", { name: "View" });
    expect([...group.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Inbox", "Today", "Upcoming"]);
    expect(pressed()).toEqual(["Today"]);
    expect(screen.getByRole("button", { name: "Inbox" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Upcoming" }));
    expect(pressed()).toEqual(["Upcoming"]);
  });

  it("stays one row (no wrap) and fills the selected segment with the accent, from tokens only", () => {
    render(<Host />);
    const group = screen.getByRole("group", { name: "View" }).className.split(/\s+/);
    expect(group).toEqual(expect.arrayContaining(["inline-flex", "flex-nowrap", "border", "border-border-strong"]));
    expect(group).not.toContain("flex-wrap");
    const segment = screen.getByRole("button", { name: "Today" }).className.split(/\s+/);
    expect(segment).toEqual(expect.arrayContaining(["whitespace-nowrap", "min-h-7", "aria-pressed:bg-accent", "aria-pressed:text-on-solid"]));
    expect(readFileSync("web/src/components/ui/segmented-control.tsx", "utf8")).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});
