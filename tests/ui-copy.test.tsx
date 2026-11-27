// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// tsconfig.test.json checks this file without JSX: the components load by specifiers the node check skips.
const COPY_MODULE = "../web/src/components/ui/copy.js";
const MD_MODULE = "../web/src/components/ui/markdown.js";
const { CopyIcon } = (await import(/* @vite-ignore */ COPY_MODULE)) as { CopyIcon: FunctionComponent<{ value: string; what: string }> };
const { Markdown } = (await import(/* @vite-ignore */ MD_MODULE)) as { Markdown: FunctionComponent<{ text: string }> };

let written: string[];
const withClipboard = () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (v: string) => void written.push(v) } });
};

beforeEach(() => {
  written = [];
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "clipboard");
});

const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};
const live = () => document.querySelector("[aria-live=polite]") as HTMLElement;

describe("CopyIcon", () => {
  it("is a ghost icon Button that writes the value, then says Copied for 1.5 s in an aria-live element", async () => {
    withClipboard();
    render(createElement(CopyIcon, { value: "hello", what: "reply" }));
    const button = screen.getByRole("button", { name: "Copy reply" });
    expect(button.className).toContain("size-8");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(live().textContent).toBe("");
    await click("Copy reply");
    expect(written).toEqual(["hello"]);
    expect(live().textContent).toBe("Copied");
    await act(async () => void vi.advanceTimersByTime(1500));
    expect(live().textContent).toBe("");
  });

  it("shows nothing with no clipboard", async () => {
    render(createElement(CopyIcon, { value: "hello", what: "reply" }));
    await click("Copy reply");
    expect(live().textContent).toBe("");
  });
});

describe("Markdown code blocks", () => {
  it("has a Copy button under each fenced block that writes the code without its fence lines", async () => {
    withClipboard();
    render(createElement(Markdown, { text: "Run:\n\n```sh\nnpm test\nnpm run lint\n```\n\nthen\n\n```\nsecond\n```" }));
    const buttons = screen.getAllByRole("button", { name: "Copy code" });
    expect(buttons).toHaveLength(2);
    const pre = document.querySelector("pre") as HTMLElement;
    expect(pre.nextElementSibling?.contains(buttons[0]!)).toBe(true);
    await act(async () => {
      fireEvent.click(buttons[0]!);
    });
    expect(written).toEqual(["npm test\nnpm run lint"]);
  });
});

describe("one copy path", () => {
  it("the views write no clipboard of their own", () => {
    for (const f of ["web/src/views/chat-page.tsx", "web/src/views/chat-card.tsx", "web/src/components/ui/markdown.tsx"]) {
      const source = readFileSync(f, "utf8");
      expect(source).not.toMatch(/clipboard|copyToClipboard/);
      expect(source).toContain("CopyIcon");
    }
    expect(readFileSync("web/src/components/ui/copy.tsx", "utf8")).toMatch(/variant="ghost" size="icon"/);
  });
});
