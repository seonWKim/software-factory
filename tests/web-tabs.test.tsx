// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs } from "../web/src/components/ui/tabs.js";

afterEach(cleanup);

const OPTIONS = [
  { id: "", label: "All projects" },
  { id: "home", label: "Home" },
  { id: "garden", label: "Garden" },
] as const;

function Host({ start = "" }: { start?: string }) {
  const [value, setValue] = useState(start);
  return <Tabs label="Project" options={OPTIONS} value={value} onChange={setValue} />;
}

const tabs = () => screen.getAllByRole("tab");
const selected = () => tabs().filter((b) => b.getAttribute("aria-selected") === "true").map((b) => b.textContent);

describe("Tabs", () => {
  it("is a named tablist of tabs; only the selected one has aria-selected and tabindex 0", () => {
    render(<Host start="home" />);
    expect(screen.getByRole("tablist", { name: "Project" })).toBeTruthy();
    expect(tabs().map((b) => b.textContent)).toEqual(["All projects", "Home", "Garden"]);
    expect(selected()).toEqual(["Home"]);
    expect(tabs().map((b) => b.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  it("a click selects the tab", () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("tab", { name: "Garden" }));
    expect(selected()).toEqual(["Garden"]);
  });

  it("ArrowRight and ArrowLeft move focus and selection, wrapping at the ends", () => {
    render(<Host />);
    const key = (k: string) => fireEvent.keyDown(document.activeElement ?? tabs()[0], { key: k });
    tabs()[0].focus();
    key("ArrowRight");
    expect(selected()).toEqual(["Home"]);
    expect(document.activeElement).toBe(tabs()[1]);
    key("ArrowRight");
    key("ArrowRight");
    expect(selected()).toEqual(["All projects"]);
    key("ArrowLeft");
    expect(selected()).toEqual(["Garden"]);
    expect(document.activeElement).toBe(tabs()[2]);
  });

  it("Home and End go to the first and last tab", () => {
    render(<Host start="home" />);
    tabs()[1].focus();
    fireEvent.keyDown(tabs()[1], { key: "End" });
    expect(selected()).toEqual(["Garden"]);
    fireEvent.keyDown(document.activeElement, { key: "Home" });
    expect(selected()).toEqual(["All projects"]);
    expect(document.activeElement).toBe(tabs()[0]);
  });

  it("scrolls sideways in its own box and uses tokens only", () => {
    render(<Host />);
    const list = screen.getByRole("tablist");
    expect(list.className).toMatch(/overflow-x-auto/);
    expect(list.className).toMatch(/flex-nowrap/);
    expect(tabs()[0].className).toMatch(/whitespace-nowrap/);
    expect(readFileSync("web/src/components/ui/tabs.tsx", "utf8")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
