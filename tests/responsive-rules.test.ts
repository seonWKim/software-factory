// Rules of `npm run check:responsive` (scripts/responsive/rules.mjs): page-scroll also reads the scroll root,
// small-target measures a labelled input by its label, and offscreen reports a control past the edge inside a scrolling box. Run against a stand-in document, no browser.
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
type Failure = { rule: string; detail: string };
const { checkLayout, LIMITS } = (await import(pathToFileURL(join(ROOT, "scripts", "responsive", "rules.mjs")).href)) as {
  checkLayout: (limits: unknown) => { failures: Failure[] };
  LIMITS: unknown;
};

type Box = { width: number; height: number };

/** A painted stand-in element of the given tag and box, inside `label` when given. */
function element(tag: string, box: Box, label: unknown = null) {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: "",
    classList: [],
    childNodes: [],
    children: [] as unknown[],
    parentElement: null as unknown,
    getAttribute: () => null,
    setAttribute() {},
    matches: (q: string) => q.split(",").some((p) => p.trim().split(/[:[]/)[0] === tag),
    closest: (q: string) => (q === "label" ? label : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: box.width, bottom: box.height, ...box }),
  };
  return el;
}

const BASE_STYLE = { overflowX: "visible", overflowY: "visible", display: "block", visibility: "visible", opacity: "1", position: "static", clip: "auto", fontSize: "16px", font: "16px sans-serif", paddingLeft: "0", paddingRight: "0", borderLeftWidth: "0", borderRightWidth: "0", getPropertyValue: () => "" };

/** A page whose scroll root has the given widths and whose body holds `elements`. */
function pageWith(scroll: { scrollWidth: number; clientWidth: number }, elements: unknown[] = []) {
  const root = { ...scroll, setAttribute() {} };
  const empty = { querySelectorAll: (q: string) => (q === "*" ? elements : []), querySelector: () => null };
  vi.stubGlobal("window", { innerHeight: 844 });
  // A stand-in's own `css` overrides the default style (a scrolling wrapper's overflowX).
  vi.stubGlobal("getComputedStyle", (el: { css?: Record<string, string> } | null) => ({ ...BASE_STYLE, ...el?.css }));
  vi.stubGlobal("CSS", { escape: (v: string) => v });
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  vi.stubGlobal("document", {
    documentElement: { clientWidth: 390, scrollWidth: 390, setAttribute() {}, getAttribute: () => null, parentElement: null, nodeType: 1, tagName: "HTML", classList: [] },
    body: { ...empty, setAttribute() {}, createTreeWalker: undefined },
    querySelector: (q: string) => (q === "[data-scroll-root]" ? root : null),
    createTreeWalker: () => ({ nextNode: () => null }),
    createElement: () => ({ getContext: () => ({ font: "", measureText: () => ({ width: 8 }) }) }),
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

describe("check:responsive small-target", () => {
  const fits = { scrollWidth: 334, clientWidth: 334 };
  const small = (elements: unknown[]) => {
    pageWith(fits, elements);
    return checkLayout(LIMITS).failures.filter((x) => x.rule === "small-target");
  };

  it("measures an input inside a label by the label's box", () => {
    const label = element("label", { width: 32, height: 32 });
    expect(small([element("input", { width: 16, height: 16 }, label)])).toEqual([]);
  });

  it("fails an input under 24px with no label", () => {
    expect(small([element("input", { width: 16, height: 16 })])).toHaveLength(1);
  });

  it("fails a button under 24px tall", () => {
    expect(small([element("button", { width: 200, height: 20 })])).toHaveLength(1);
  });
});

describe("check:responsive page-scroll culprit", () => {
  it("names the widest element no ancestor clips", () => {
    const wide = { ...element("p", { width: 568, height: 20 }), getAttribute: (n: string) => (n === "data-testid" ? "wide-row" : null) };
    pageWith({ scrollWidth: 568, clientWidth: 334 });
    const doc = (globalThis as unknown as { document: { querySelector: (q: string) => Record<string, unknown> | null } }).document;
    const root = doc.querySelector("[data-scroll-root]")!;
    root.querySelectorAll = () => [element("p", { width: 100, height: 20 }), wide];
    root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 334, bottom: 800, width: 334, height: 800 });
    const f = checkLayout(LIMITS).failures.filter((x) => x.rule === "page-scroll");
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain('[data-testid="wide-row"]');
  });
});

describe("check:responsive offscreen inside a scrolling box", () => {
  /** `tag` at x `left` to `right`, inside a card in an overflow-x:auto table wrapper that is as wide as the window. */
  const inScroller = (tag: string, left: number, right: number) => {
    const wrapper = { ...element("div", { width: 390, height: 600 }), css: { overflowX: "auto" } };
    const card = { ...element("li", { width: 390, height: 120 }), parentElement: wrapper };
    const el = { ...element(tag, { width: right - left, height: 28 }), parentElement: card };
    wrapper.children = [card];
    card.children = [el];
    el.getBoundingClientRect = () => ({ left, top: 0, right, bottom: 28, width: right - left, height: 28 });
    return [wrapper, card, el];
  };
  const offscreen = (elements: unknown[]) => {
    pageWith({ scrollWidth: 334, clientWidth: 334 }, elements);
    return checkLayout(LIMITS).failures.filter((x) => x.rule === "offscreen");
  };

  it("fails a card's button past the window's right edge (the Skills Copy Path at x 440 to 485)", () => {
    const f = offscreen(inScroller("button", 440, 485));
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain("485");
  });

  it("fails a link past the right edge", () => {
    expect(offscreen(inScroller("a", 360, 420))).toHaveLength(1);
  });

  it("passes a button that fits, and text past the edge that the scrolling box holds", () => {
    expect(offscreen(inScroller("button", 300, 390))).toEqual([]);
    expect(offscreen(inScroller("span", 300, 600))).toEqual([]);
  });
});
