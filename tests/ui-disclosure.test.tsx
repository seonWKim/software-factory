// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Disclosure } from "../web/src/components/ui/disclosure.js";
import { Markdown } from "../web/src/components/ui/markdown.js";

afterEach(cleanup);

const summary = (name: string) => screen.getByText(name).closest("summary")!;
const details = (name: string) => summary(name).closest("details")!;

describe("Disclosure", () => {
  it("renders one native details with a summary, closed by default", () => {
    render(<Disclosure summary="More" data-x="1"><p>Body</p></Disclosure>);
    expect(document.querySelectorAll("details")).toHaveLength(1);
    expect(details("More").open).toBe(false);
    expect(details("More").dataset.x).toBe("1");
    expect(summary("More").getAttribute("aria-expanded")).toBe("false");
  });

  it("starts open with defaultOpen and toggles open and closed on click, keeping aria-expanded in step", () => {
    const onToggle = vi.fn();
    render(<Disclosure summary="More" defaultOpen onToggle={onToggle}><p>Body</p></Disclosure>);
    expect(details("More").open).toBe(true);
    expect(summary("More").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(summary("More"));
    expect(details("More").open).toBe(false);
    expect(summary("More").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary("More"));
    expect(details("More").open).toBe(true);
    expect(onToggle.mock.calls).toEqual([[false], [true]]);
  });

  it("opens and closes from the keyboard with Enter and Space", () => {
    render(<Disclosure summary="More"><p>Body</p></Disclosure>);
    expect(summary("More").tabIndex).not.toBe(-1);
    fireEvent.keyDown(summary("More"), { key: "Enter" });
    expect(details("More").open).toBe(true);
    fireEvent.keyDown(summary("More"), { key: " " });
    expect(details("More").open).toBe(false);
    fireEvent.keyDown(summary("More"), { key: "a" });
    expect(details("More").open).toBe(false);
  });

  it("draws one marker, and a lazy body is mounted only while open", () => {
    render(<Disclosure lazy summary="More"><p>Body</p></Disclosure>);
    expect(summary("More").querySelectorAll("svg")).toHaveLength(1);
    expect(screen.queryByText("Body")).toBeNull();
    fireEvent.click(summary("More"));
    expect(screen.getByText("Body")).not.toBeNull();
  });

  it("is what Markdown folds with, the summary and body still markdown", () => {
    render(<Markdown text={"<details><summary>**Long** part</summary>\n- one\n- `two`\n</details>"} />);
    const s = document.querySelector("details > summary")!;
    expect(s.getAttribute("aria-expanded")).toBe("false");
    expect(s.querySelector("strong")!.textContent).toBe("Long");
    expect(document.querySelectorAll("details li")).toHaveLength(2);
    expect(document.querySelector("details code")!.textContent).toBe("two");
  });
});
