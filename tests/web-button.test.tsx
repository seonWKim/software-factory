// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "../web/src/components/ui/button.js";

// The shared button (docs/design/09-brand-and-tokens.md): danger has secondary's box with failed-colour text; only a
// confirm dialog's destructive confirm (solid) is filled with the failed colour.

afterEach(cleanup);

const classes = (name: string) => screen.getByRole("button", { name }).className.split(/\s+/);

describe("Button", () => {
  it("the danger variant has secondary's 1px border-strong box and the failed text colour", () => {
    render(
      <>
        <Button variant="secondary">Changes</Button>
        <Button variant="danger">Reject</Button>
      </>,
    );
    expect(classes("Reject")).toEqual(expect.arrayContaining(["border", "border-border-strong", "bg-surface", "text-failed"]));
    expect(classes("Changes")).toEqual(expect.arrayContaining(["border", "border-border-strong", "bg-surface"]));
    expect(classes("Reject")).not.toContain("bg-failed");
  });

  it("the solid danger style is unchanged: filled with the failed colour, on-solid text, no border", () => {
    render(
      <Button variant="danger" solid>
        Reject now
      </Button>,
    );
    const solid = classes("Reject now");
    expect(solid).toEqual(expect.arrayContaining(["bg-failed", "text-on-solid", "enabled:hover:opacity-90"]));
    expect(solid).not.toContain("border");
    expect(solid).not.toContain("text-failed");
  });

  it("the icon size is 32x32", () => {
    render(<Button size="icon" aria-label="More" />);
    expect(classes("More")).toContain("size-8");
  });
});
