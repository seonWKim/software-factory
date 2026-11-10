// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { shortSource } from "../web/src/lib/format.js";
import { ItemTitle } from "../web/src/views/common.js";

// Local item ids (`local-<uuid>`) are 40+ characters; shown in full they widened the Floor, Queue and Work items
// pages past a 390px screen. They show short, like `#N` for issues, with the full id kept on hover.

const LOCAL = "local-30331a68-38a4-4a4e-83ed-30c3d0b7a040";

afterEach(cleanup);

describe("shortSource", () => {
  it("keeps the first 8 characters of a local id, and its phase numbers", () => {
    expect(shortSource(LOCAL)).toBe("30331a68");
    expect(shortSource(`${LOCAL}-phase-3-phase-2`)).toBe("30331a68-p3-p2");
    expect(shortSource("local-filed-0123456789abcdef")).toBe("01234567");
  });

  it("still shortens issue ids to #N and leaves other ids as they are", () => {
    expect(shortSource("o/r#192")).toBe("#192");
    expect(shortSource("system:improve:x")).toBe("system:improve:x");
  });
});

describe("ItemTitle", () => {
  it("shows a local id short, with the full id in title and the link unchanged", () => {
    render(<ItemTitle id="wi_1" title="Some work" source={{ id: LOCAL, link: `local:${LOCAL}` }} />);
    const link = screen.getByText("30331a68");
    expect(link.getAttribute("title")).toBe(LOCAL);
    expect(link.getAttribute("href")).toBe(`local:${LOCAL}`);
    expect(link.className).toContain("truncate");
    expect(screen.queryByText(LOCAL)).toBeNull();
  });
});
