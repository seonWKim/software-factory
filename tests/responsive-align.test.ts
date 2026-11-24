// The alignment rules of `npm run check:responsive` (scripts/responsive/rules.mjs): row-align (a control or badge off its
// row's first text line by more than 3px) and toolbar-height (a toolbar's controls not one height), the
// [data-align-skip] opt-out and LIMITS.warnOnly. Run against a stand-in document of boxes, no browser.
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
type Failure = { rule: string; detail: string; warn?: boolean };
type Limits = Record<string, unknown> & { warnOnly: string[] };
const { checkLayout, LIMITS } = (await import(pathToFileURL(join(ROOT, "scripts", "responsive", "rules.mjs")).href)) as {
  checkLayout: (limits: unknown) => { failures: Failure[] };
  LIMITS: Limits;
};

/** What a stand-in is, for `matches` and `closest`: a row, an aligned control or badge, a toolbar, a radiogroup, an open menu or popover. */
type Kind = "row" | "aligned" | "toolbar" | "radiogroup" | "overlay" | "plain";
/** Which kind a selector of rules.mjs asks for, by a token only that selector has. */
const kindOf = (sel: string): Kind | null =>
  sel.includes("tbody > tr") ? "row" : sel.includes("[data-level]") ? "aligned" : sel.includes("[data-toolbar]") ? "toolbar" : sel === "[role=radiogroup]" ? "radiogroup" : sel.includes("[data-popover]") ? "overlay" : null;

interface Node {
  kind: Kind;
  tag: string;
  top: number;
  height: number;
  attrs: Record<string, string>;
  parent: Node | null;
  kids: Node[];
  /** The element's own text node's first line box, [top, height], when it has text. */
  text?: [number, number];
}

function box(kind: Kind, tag: string, top: number, height: number, opts: { attrs?: Record<string, string>; text?: [number, number]; kids?: Node[] } = {}): Node {
  const n: Node = { kind, tag, top, height, attrs: opts.attrs ?? {}, parent: null, kids: opts.kids ?? [], ...(opts.text ? { text: opts.text } : {}) };
  for (const k of n.kids) k.parent = n;
  return n;
}

const all = (n: Node): Node[] => [n, ...n.kids.flatMap(all)];

/** The DOM face of a stand-in: what checkLayout reads of an element. */
const elements = new Map<Node, Record<string, unknown>>();
function el(n: Node): Record<string, unknown> {
  let e = elements.get(n);
  if (e) return e;
  e = {
    nodeType: 1,
    tagName: n.tag.toUpperCase(),
    id: "",
    classList: [],
    childNodes: [],
    get children() {
      return n.kids.map(el);
    },
    get parentElement() {
      return n.parent ? el(n.parent) : null;
    },
    getAttribute: (a: string) => n.attrs[a] ?? (a === "role" && n.kind === "radiogroup" ? "radiogroup" : null),
    setAttribute() {},
    matches: (sel: string) => kindOf(sel) === n.kind,
    closest(sel: string) {
      const want = kindOf(sel);
      for (let p: Node | null = n; p; p = p.parent) if (want !== null && p.kind === want) return el(p);
      return null;
    },
    contains: (o: Record<string, unknown>) => all(n).some((x) => el(x) === o),
    querySelectorAll(sel: string) {
      const want = kindOf(sel);
      // A toolbar's control query asks for buttons, inputs and radiogroups: every aligned or radiogroup box below it.
      if (sel.startsWith("button, input:not([type=hidden], [type=checkbox]")) return all(n).slice(1).filter((x) => x.kind === "aligned" || x.kind === "radiogroup").map(el);
      return want === null ? [] : all(n).slice(1).filter((x) => x.kind === want).map(el);
    },
    getBoundingClientRect: () => ({ left: 0, right: 100, width: 100, top: n.top, bottom: n.top + n.height, height: n.height }),
    get texts() {
      return all(n).filter((x) => x.text).map((x) => ({ textContent: "text", parentElement: el(x), rects: [{ top: x.text![0], bottom: x.text![0] + x.text![1], width: 40, height: x.text![1] }] }));
    },
  };
  elements.set(n, e);
  return e;
}

/** A page whose body holds `roots` (rows, toolbars). */
function pageOf(roots: Node[]) {
  elements.clear();
  const nodes = roots.flatMap(all);
  vi.stubGlobal("window", { innerHeight: 844 });
  vi.stubGlobal("getComputedStyle", () => ({ overflowX: "visible", overflowY: "visible", display: "block", visibility: "visible", opacity: "1", position: "static", clip: "auto", fontSize: "13px", lineHeight: "18px", font: "13px sans-serif", paddingLeft: "0", paddingRight: "0", borderLeftWidth: "0", borderRightWidth: "0", maxWidth: "none", getPropertyValue: () => "" }));
  vi.stubGlobal("CSS", { escape: (v: string) => v });
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  vi.stubGlobal("document", {
    documentElement: { clientWidth: 1280, scrollWidth: 1280, setAttribute() {}, getAttribute: () => null, parentElement: null, nodeType: 1, tagName: "HTML", classList: [] },
    body: {
      setAttribute() {},
      querySelectorAll(sel: string) {
        const want = kindOf(sel);
        return want === null ? [] : nodes.filter((x) => x.kind === want).map(el);
      },
    },
    querySelector: () => null,
    createTreeWalker(root: { texts?: unknown[] }) {
      const list = [...(root.texts ?? [])];
      return { nextNode: () => list.shift() ?? null };
    },
    createRange() {
      let rects: unknown[] = [];
      return { selectNodeContents: (t: { rects: unknown[] }) => (rects = t.rects), getClientRects: () => rects };
    },
    createElement: () => ({ getContext: () => ({ font: "", measureText: () => ({ width: 8 }) }) }),
  });
}

afterEach(() => vi.unstubAllGlobals());

const found = (rule: string, limits: unknown = LIMITS) => checkLayout(limits).failures.filter((f) => f.rule === rule);

describe("check:responsive row-align", () => {
  // A 41px table row (8px cell padding): its text's 18px first line at y 8 to 26, centre 17.
  const row = (...controls: Node[]) => box("row", "tr", 0, 41, { kids: [box("plain", "td", 0, 41, { text: [8, 18] }), ...controls] });

  it("fails a 32px ⋯ button at the cell's top padding (centre 24, 7px under the text line's 17)", () => {
    pageOf([row(box("aligned", "button", 8, 32))]);
    const f = found("row-align");
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain("+7px");
  });

  it("fails a 28px button 5px low, and a badge 4px high", () => {
    pageOf([row(box("aligned", "button", 8, 28), box("aligned", "span", 4, 18, { attrs: { "data-level": "ok" } }))]);
    expect(found("row-align").map((f) => f.detail.split(" ")[1])).toEqual(["+5px", "-4px"]);
  });

  it("passes a button, a switch and a badge centred on the text line, and one within 3px", () => {
    pageOf([row(box("aligned", "button", 1, 32), box("aligned", "button", 5, 24), box("aligned", "span", 8, 18, { attrs: { "data-level": "ok" } }), box("aligned", "a", 10, 18))]);
    expect(found("row-align")).toEqual([]);
  });

  it("does not compare a control on a later line of the row (its details line)", () => {
    pageOf([box("row", "li", 0, 60, { attrs: { "data-list-row": "" }, kids: [box("plain", "p", 0, 20, { text: [0, 20] }), box("aligned", "button", 30, 28)] })]);
    expect(found("row-align")).toEqual([]);
  });

  it("skips a control marked data-align-skip, or inside a box marked so", () => {
    pageOf([row(box("aligned", "button", 8, 32, { attrs: { "data-align-skip": "" } }), box("plain", "div", 0, 41, { attrs: { "data-align-skip": "" }, kids: [box("aligned", "button", 8, 28)] }))]);
    expect(found("row-align")).toEqual([]);
  });

  it("does not judge an open menu's items inside a row, but still a misaligned control in that row", () => {
    // A ⋯ menu opened in a table card: its list is `fixed` over the row but stays the row's DOM descendant. Its 28px
    // items (one 13px above the line's centre, one 16px below, as CI's Schedules card at 390 had) and its group label
    // are an overlay, not row content.
    const menu = box("overlay", "ul", -14, 70, {
      attrs: { role: "menu" },
      kids: [box("plain", "li", -14, 4, { text: [-14, 4] }), box("aligned", "button", -10, 28), box("aligned", "button", 19, 28)],
    });
    pageOf([row(box("aligned", "button", 1, 32), menu)]);
    expect(found("row-align")).toEqual([]);
    pageOf([row(box("aligned", "button", 8, 32), box("overlay", "ul", 15, 70, { attrs: { role: "menu" }, kids: [box("aligned", "button", 19, 28)] }))]);
    expect(found("row-align").map((f) => f.detail.split(" ")[1])).toEqual(["+7px"]);
  });

  it("leaves a nested row's controls to the nested row", () => {
    const inner = box("row", "li", 30, 41, { kids: [box("plain", "p", 38, 18, { text: [38, 18] }), box("aligned", "button", 31, 32)] });
    pageOf([box("row", "li", 0, 80, { kids: [box("plain", "p", 0, 18, { text: [0, 18] }), inner] })]);
    expect(found("row-align")).toEqual([]);
  });

  it("is a failure, and only a warning while LIMITS.warnOnly names it", () => {
    pageOf([row(box("aligned", "button", 8, 32))]);
    expect(found("row-align")[0]!.warn).toBeUndefined();
    expect(found("row-align", { ...LIMITS, warnOnly: ["row-align"] })[0]!.warn).toBe(true);
  });
});

describe("check:responsive toolbar-height", () => {
  it("fails a 28px sm Button beside the 32px search Input and SegmentedControl (Work's toolbar before 2026-11-24)", () => {
    pageOf([box("toolbar", "div", 0, 32, { attrs: { "data-toolbar": "" }, kids: [box("aligned", "input", 0, 32), box("radiogroup", "div", 0, 32), box("aligned", "button", 2, 28)] })]);
    const f = found("toolbar-height");
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toBe("28px tall in a toolbar of 32px controls");
    expect(f[0]!.warn).toBeUndefined();
  });

  it("passes a toolbar of 32px controls, counting a SegmentedControl's 28px segments as its 32px track", () => {
    const segments = box("radiogroup", "div", 0, 32, { kids: [box("aligned", "button", 2, 28), box("aligned", "button", 2, 28)] });
    pageOf([box("toolbar", "div", 0, 32, { attrs: { "data-toolbar": "" }, kids: [box("aligned", "input", 0, 32), segments, box("aligned", "button", 0, 32)] })]);
    expect(found("toolbar-height")).toEqual([]);
  });

  it("skips a control marked data-align-skip", () => {
    pageOf([box("toolbar", "div", 0, 32, { attrs: { "data-toolbar": "" }, kids: [box("aligned", "input", 0, 32), box("aligned", "button", 2, 28, { attrs: { "data-align-skip": "" } })] })]);
    expect(found("toolbar-height")).toEqual([]);
  });
});
