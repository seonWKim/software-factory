// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { shortItemId, shortSource } from "../web/src/lib/format.js";
import { ItemTitle } from "../web/src/views/common.js";
import { ItemFacts } from "../web/src/views/item-facts.js";

// Local item ids (`local-<uuid>`) are 40+ characters; shown in full they widened the Floor, Queue and Work items
// pages past a 390px screen. They show short, like `#N` for issues, with the full id kept on hover. A work item itself
// shows its own short ID (shortItemId, design 09-dashboard-item); shortSource stays for source references.

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

describe("shortItemId", () => {
  it("is the 8 hex characters after wi_, the short ID the CLI accepts; any other ID as it is", () => {
    expect(shortItemId("wi_c86970ff1a73401c952d9228d6156b6d")).toBe("c86970ff");
    expect(shortItemId("wi_spec1")).toBe("wi_spec1");
    expect(shortItemId(LOCAL)).toBe(LOCAL);
  });
});

describe("ItemTitle", () => {
  it("is the title linked to the item page: no source link, no truncate", () => {
    const { container } = render(<ItemTitle id="wi_1" title="Some work" />);
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("/app/items/wi_1");
    expect(links[0].textContent).toBe("Some work");
    expect(links[0].className).not.toContain("truncate");
    expect(screen.queryByText("30331a68")).toBeNull();
  });
});

describe("ItemFacts Source", () => {
  const item = (link: string) => ({
    id: "wi_c86970ff1a73401c952d9228d6156b6d", item_phase: "open", close_reason: null, source: { id: LOCAL, link },
    tier: null, change_ref: null, change_url: null, spec_comment_url: null, loop_count: 0, restart_count: 0, token_cost: 0,
    updated_at: new Date(0).toISOString(),
  });
  const facts = (container: HTMLElement) => [...container.querySelectorAll("dt")].map((d) => d.textContent);

  it("hides the Source fact when the source has no http link: no value repeats the breadcrumb short ID", () => {
    const { container } = render(<ItemFacts item={item(`local:${LOCAL}`)} now={0} />);
    expect(facts(container)).not.toContain("Source");
    const values = [...container.querySelectorAll("dd")].map((d) => d.textContent);
    expect(values).not.toContain(shortItemId("wi_c86970ff1a73401c952d9228d6156b6d"));
  });

  it("still shows the Source fact, linked, for an http source", () => {
    const { container } = render(<ItemFacts item={item("https://github.com/o/r/issues/1")} now={0} />);
    expect(facts(container)).toContain("Source");
    expect(container.querySelector("dd a")!.getAttribute("href")).toBe("https://github.com/o/r/issues/1");
  });
});
