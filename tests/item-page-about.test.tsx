// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../web/src/components/ui/markdown.js";
import { installItemPageFixtures, mountItem as mount, src } from "./ui-shell-fixtures.js";

// The item page About block and the Markdown renderer it uses.

installItemPageFixtures();

describe("Markdown", () => {
  it("escapes raw HTML and links only http(s) URLs; a javascript: link is plain text", () => {
    const { container } = render(
      <Markdown text={'<script>alert(1)</script> <img src=x onerror="alert(2)">\n\n[safe](https://example.com/a) [bad](javascript:alert(3)) [rel](/local) **bold**'} />,
    );
    expect(container.querySelector("script, img")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["safe", "https://example.com/a"]]);
    expect(container.textContent).toContain("bad");
    expect(container.textContent).not.toContain("javascript:");
    expect(container.textContent).toContain("rel");
    expect(container.querySelector("strong")!.textContent).toBe("bold");
  });

  it("renders headings, lists, numbered lists and fenced code", () => {
    const { container } = render(<Markdown text={"# Title\n\n- one\n- two\n\n1. first\n2. second\n\n```\n<raw> code\n```"} />);
    expect(container.querySelector("h3")!.textContent).toBe("Title");
    expect([...container.querySelectorAll("ul > li")].map((l) => l.textContent)).toEqual(["one", "two"]);
    expect([...container.querySelectorAll("ol > li")].map((l) => l.textContent)).toEqual(["first", "second"]);
    expect(container.querySelector("pre code")!.textContent).toBe("<raw> code");
  });

  it("folds a <details> block into a real fold, its summary and body as markdown, other HTML still text", () => {
    const { container } = render(<Markdown text={"<details><summary>What the PR contains</summary>\n\n- a **change**\n\n</details>\n\n<b>after</b>"} />);
    const fold = container.querySelector("details")!;
    expect(fold.querySelector("summary")!.textContent).toBe("What the PR contains");
    expect(fold.querySelector("ul > li strong")!.textContent).toBe("change");
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<b>after</b>");
  });

  it("marks the In short and Decisions for you sections, up to the next heading of their level", () => {
    const { container } = render(<Markdown text={"### In short (AS-IS → TO-BE)\nAS-IS: old\nTO-BE: new\n\n### Problem\nwhy\n\n### Decisions for you\n- pick one\n\n### Done when\n- done"} />);
    const callouts = [...container.querySelectorAll("[data-callout]")];
    expect(callouts.map((c) => c.getAttribute("data-callout"))).toEqual(["summary", "attention"]);
    expect(callouts[0]!.textContent).not.toContain("why");
    expect(callouts[1]!.textContent).toContain("pick one");
    expect(callouts[1]!.textContent).not.toContain("done");
  });

  it("shows AS-IS and TO-BE on separate lines when they arrive in one paragraph", () => {
    const { container } = render(<Markdown text={"AS-IS: the old way →\nTO-BE: the new way"} />);
    expect([...container.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["AS-IS: the old way", "TO-BE: the new way"]);
  });
});

describe("item page: About (the request and the approved spec)", () => {
  it("a request with an approved spec: About under the title with the summary line, the spec collapsed", async () => {
    mount("/app/items/wi_about");
    const about = await screen.findByRole("region", { name: "About" });
    expect(about.textContent).toContain("Item page shows what the work is about");
    // Under the title: About comes before the decision box and every other Card.
    const regions = [...document.querySelectorAll("section[aria-label]")];
    expect(regions[0]).toBe(about);
    const toggle = about.querySelector("summary")!;
    expect(toggle.textContent).toBe("Approved spec");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(about.querySelector("details")!.open).toBe(false);
    expect(within(about).queryAllByRole("button")).toEqual([]);
    expect(about.textContent).not.toMatch(/wi_about/);
  });

  it("expanding the spec shows the problem, the desired output and each done criterion as a list item", async () => {
    mount("/app/items/wi_about");
    const about = await screen.findByRole("region", { name: "About" });
    fireEvent.click(about.querySelector("summary")!);
    expect(about.querySelector("details")!.open).toBe(true);
    for (const label of ["Problem", "Desired output", "Done criteria"]) expect(within(about).getByText(label)).toBeTruthy();
    expect(about.textContent).toContain("The page shows no text about the work.");
    const items = within(within(about).getByRole("list", { name: "Done criteria" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["About shows the summary", "Withheld: the egress scan flagged this text.", "Spec starts collapsed"]);
  });

  it("a withheld text shows the withheld note, never the marker", async () => {
    mount("/app/items/wi_withheld");
    const about = await screen.findByRole("region", { name: "About" });
    expect(about.textContent).toContain("Withheld: the egress scan flagged this text.");
    expect(about.textContent).not.toContain("[withheld");
    // The spec's withheld desired output and criterion read the same way.
    cleanup();
    mount("/app/items/wi_about");
    const spec = await screen.findByRole("region", { name: "About" });
    fireEvent.click(spec.querySelector("summary")!);
    expect(spec.querySelectorAll("[data-withheld]").length).toBe(2);
    expect(spec.textContent).not.toContain("[withheld");
  });

  it("a request with no approved spec: About with the summary only, no spec Disclosure", async () => {
    mount("/app/items/wi_request");
    const about = await screen.findByRole("region", { name: "About" });
    expect(about.textContent).toContain("Only the request so far");
    expect(about.querySelector("details")).toBeNull();
  });

  it("an item with neither a request nor a spec shows no About", async () => {
    mount("/app/items/wi_done");
    await screen.findByRole("table", { name: "Runs" });
    expect(screen.queryByRole("region", { name: "About" })).toBeNull();
  });

  it("at 390 px the About text wraps (break-words)", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    mount("/app/items/wi_about");
    const about = await screen.findByRole("region", { name: "About" });
    const summary = about.querySelector<HTMLElement>("[data-about-request] p")!;
    expect(summary.className).toContain("break-words");
    expect(about.className).toContain("min-w-0");
  });
});
