// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { App } from "../web/src/App.js";
import { PAGES } from "../web/src/pages.js";
import { Markdown } from "../web/src/components/ui/markdown.js";
import { installShellFixtures, mount, waitBadge, RESPONSES } from "./ui-shell-fixtures.js";

installShellFixtures();

const RULES = ["label-content-name-mismatch", "heading-order"];
const check = async () => {
  const r = await axe.run(document.body, { runOnly: { type: "rule", values: RULES } });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
};

describe("axe: sidebar link names and heading order", () => {
  for (const p of PAGES) {
    it(`/app/${p.path} reports neither rule`, async () => {
      history.replaceState(null, "", `/app/${p.path}`);
      mount();
      await waitBadge();
      expect(await check()).toEqual([]);
    });
  }

  it("the Tasks link is named by its label, the count and its words", async () => {
    history.replaceState(null, "", "/app/tasks");
    mount();
    expect(await screen.findByRole("link", { name: "Tasks, 4 need you" })).toBeTruthy();
  });

  it("a thread message's ## heading steps down from the Thread title without a skip", async () => {
    const detail = RESPONSES["/api/v1/items/wi_1"];
    expect(detail).toBeTruthy();
    const body = { ...detail, thread: [{ id: 1, at: detail.item.created_at, author: "factory", channel: "factory", kind: "note", body: "## Factory check\n\ntext\n\n### Deeper\n\nmore" }] };
    RESPONSES["/api/v1/items/wi_1"] = body;
    history.replaceState(null, "", "/app/items/wi_1");
    mount();
    await screen.findByRole("heading", { name: "Factory check" });
    expect(screen.getByRole("heading", { name: "Factory check" }).tagName).toBe("H3");
    expect(screen.getByRole("heading", { name: "Deeper" }).tagName).toBe("H4");
    expect(await check()).toEqual([]);
    RESPONSES["/api/v1/items/wi_1"] = detail;
  });

  it("Markdown keeps h(N+2) unless renumberHeadings is set", () => {
    const text = "## A\n\n#### B";
    const { container, rerender } = render(<Markdown text={text} />);
    expect([...container.querySelectorAll("h3,h4,h5,h6")].map((h) => h.tagName)).toEqual(["H4", "H6"]);
    rerender(<Markdown text={text} renumberHeadings />);
    expect([...container.querySelectorAll("h3,h4,h5,h6")].map((h) => h.tagName)).toEqual(["H3", "H4"]);
    cleanup();
  });
});
