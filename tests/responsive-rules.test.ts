// The page-scroll rule of `npm run check:responsive` (scripts/responsive/rules.mjs) also reads the scroll root.
// Run against a stand-in document, no browser.
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
type Failure = { rule: string; detail: string };
const { checkLayout, LIMITS } = (await import(pathToFileURL(join(ROOT, "scripts", "responsive", "rules.mjs")).href)) as {
  checkLayout: (limits: unknown) => { failures: Failure[] };
  LIMITS: unknown;
};

/** A body with one element the rule can find: the scroll root, with the given widths. */
function pageWith(scroll: { scrollWidth: number; clientWidth: number }) {
  const root = { ...scroll, setAttribute() {} };
  const empty = { querySelectorAll: () => [], querySelector: () => null };
  vi.stubGlobal("window", { innerHeight: 844 });
  vi.stubGlobal("getComputedStyle", () => ({ overflowY: "visible", fontSize: "16px", getPropertyValue: () => "" }));
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  vi.stubGlobal("document", {
    documentElement: { clientWidth: 390, scrollWidth: 390, setAttribute() {}, getAttribute: () => null, parentElement: null, nodeType: 1, tagName: "HTML", classList: [] },
    body: { ...empty, setAttribute() {}, createTreeWalker: undefined },
    querySelector: (q: string) => (q === "[data-scroll-root]" ? root : null),
    createTreeWalker: () => ({ nextNode: () => null }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("check:responsive page-scroll", () => {
  it("fails when the scroll root scrolls sideways though the document fits", () => {
    pageWith({ scrollWidth: 433, clientWidth: 334 });
    const f = checkLayout(LIMITS).failures.filter((x) => x.rule === "page-scroll");
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain("433");
  });

  it("passes when the scroll root fits", () => {
    pageWith({ scrollWidth: 334, clientWidth: 334 });
    expect(checkLayout(LIMITS).failures.filter((x) => x.rule === "page-scroll")).toEqual([]);
  });
});
