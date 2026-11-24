// The layout rules `npm run check:responsive` applies to each page, viewport and theme. `checkLayout` runs inside
// the page (serialized with toString), so it uses only browser APIs. Each rule is one question with one answer:
//
//   page-scroll     the page scrolls sideways: documentElement.scrollWidth > the viewport width, or the
//                   [data-scroll-root] content column's scrollWidth > its clientWidth.
//   offscreen       a visible element, or its own text, ends past the viewport's right edge, and no ancestor of it
//                   clips or scrolls sideways (an overflow-x:auto table wrapper is fine; the wrapper itself is checked
//                   too). A control (a button or a link) past the edge is reported even so when its nearest sideways
//                   scrolling ancestor is a table wrapper (a box whose direct child is a <table>): it is out of sight
//                   and out of reach (the Skills card's Copy Path at 390px, 2026-11-24). The scroll root, plots that
//                   scroll on purpose and tab lists stay skipped. Only the outermost such element of a chain is reported.
//   letter-wrap     text in a box narrower than 12ch breaks a word across lines (the old model_by column, PR #530,
//                   was 9ch wide).
//   tall-fixed      a position:fixed or sticky element covers more than 40% of the viewport's height.
//   overlay-bounds  an open dialog, popover, menu, listbox or tooltip extends past the viewport.
//   small-target    a painted interactive element (button, link, input, select, textarea, summary, or a role of
//                   button, menuitem, checkbox, radio, switch, tab) is smaller than 24x24 CSS px; links in running
//                   text count too. An input inside a <label> is measured by the label's box, which clicks it (the
//                   Checkbox's 16px box sits in a 32px label).
//   unreachable     the page is taller than the viewport but html or body hides vertical overflow.
//
// The page template's structure (docs/design/09-dashboard-shell.md, design-system/patterns.md), one rule each:
//
//   one-h1          the page shows other than one h1.
//   heading-size    an h1 or h2 is not the font size of the page's first one; responsive-check.mjs also compares each
//                   page's sizes with the first page's at the same viewport and theme.
//   page-width      <main>'s max-width is neither --page-wide nor --page-read (PageHeader's width prop picks one).
//   button-height   a button is not 28px or 32px tall (a switch, a listbox option, a menu item and a chart's bar,
//                   [data-chart-bar], whose height is the chart's, are not buttons).
//   raw-name        visible text holds a snake_case name or a wi_ ID outside [data-raw] (code and pre count as raw).
//   title-wrap      a row title ([data-row-title]: Work, Tasks and Health's Runners rows) wraps onto more than two
//                   lines, so the ID, badge or time beside it squeezed it (design 09-dashboard-shell, 2026-11-22).
//
// Elements that are not painted (display:none, visibility:hidden, opacity:0, zero size) and screen-reader-only
// boxes (1px, clipped) are skipped.

export const LIMITS = { letterWrapCh: 12, maxFixedShare: 0.4, buttonHeights: [28, 32], pageWidths: ["--page-wide", "--page-read"], maxTitleLines: 2, minTarget: 24 };

/**
 * Runs in the page: `failures` as { rule, selector, detail }, each failing element marked for the screenshot, and
 * `sizes`, the font size of the page's first h1 and h2 (null when it has none) for the comparison across pages.
 */
export function checkLayout(limits) {
  const W = document.documentElement.clientWidth;
  const H = window.innerHeight;
  const out = [];
  const styles = new Map();
  const style = (el) => {
    let s = styles.get(el);
    if (!s) styles.set(el, (s = getComputedStyle(el)));
    return s;
  };

  /** A short CSS selector: the nearest id or data-testid, then tag.class:nth-of-type steps (at most 5). */
  const selector = (el) => {
    const steps = [];
    for (let e = el; e && e.nodeType === 1 && steps.length < 5; e = e.parentElement) {
      if (e.id) {
        steps.unshift(`#${CSS.escape(e.id)}`);
        break;
      }
      const testid = e.getAttribute("data-testid");
      if (testid) {
        steps.unshift(`[data-testid="${testid}"]`);
        break;
      }
      const tag = e.tagName.toLowerCase();
      if (tag === "body" || tag === "html") {
        steps.unshift(tag);
        break;
      }
      const label = e.getAttribute("aria-label");
      let step = label ? `${tag}[aria-label="${label.replace(/"/g, '\\"')}"]` : tag;
      if (!label) {
        const cls = [...e.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join("");
        step += cls;
        const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
        if (same.length > 1) step += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      steps.unshift(step);
    }
    return steps.join(" > ");
  };

  const fail = (rule, el, detail) => {
    el.setAttribute("data-responsive-fail", rule);
    out.push({ rule, selector: selector(el), detail });
  };

  const painted = (el) => {
    const s = style(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0" || s.display === "contents") return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false; // empty, or an sr-only box
    if (s.position === "absolute" && s.clip !== "auto" && s.clip !== "") return false; // sr-only (clip: rect(0 0 0 0))
    return true;
  };

  // Whether some ancestor below <body> clips or scrolls sideways, so overflowing it does not widen the page.
  const clippedX = new Map();
  const insideClipX = (el) => {
    const p = el.parentElement;
    if (!p || p === document.body || p === document.documentElement) return false;
    let v = clippedX.get(p);
    if (v === undefined) {
      v = style(p).overflowX !== "visible" || insideClipX(p);
      clippedX.set(p, v);
    }
    return v;
  };
  // The nearest ancestor below <body> that clips or scrolls sideways, or null.
  const scrollerX = (el) => {
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      if (style(a).overflowX !== "visible") return a;
    }
    return null;
  };
  // A table wrapper (Table's overflow-x box at `sm` and up) holds its <table> as a direct child. The scroll root,
  // a plot that scrolls on purpose (the Workers timeline and graph) and a scrolling tab list are not table wrappers.
  const tableWrapper = (box) => [...(box.children ?? [])].some((c) => c.tagName === "TABLE");
  const control = "button, a[href]";
  const pastRight = (el) => {
    if (el.getBoundingClientRect().right <= W + 1) return false;
    if (!insideClipX(el)) return true;
    if (!el.matches(control)) return false;
    const box = scrollerX(el);
    return box !== null && tableWrapper(box);
  };

  // page-scroll
  const sw = document.documentElement.scrollWidth;
  if (sw > W + 1) fail("page-scroll", document.documentElement, `scrollWidth ${sw}px > viewport ${W}px`);
  // The app scrolls inside its content column, so the document can fit while the column scrolls sideways.
  const root = document.querySelector("[data-scroll-root]");
  if (root && root.scrollWidth > root.clientWidth + 1) {
    // The widest element that no ancestor clips, so the next run shows which one makes the column scroll.
    let widest = null;
    for (const el of root.querySelectorAll?.("*") ?? []) {
      if (!painted(el)) continue;
      let clipped = false;
      for (let a = el.parentElement; a && a !== root; a = a.parentElement) if (style(a).overflowX !== "visible") clipped = true;
      if (clipped) continue;
      const w = el.getBoundingClientRect().right - root.getBoundingClientRect().left;
      if (!widest || w > widest.w) widest = { el, w };
    }
    const named = widest ? `; widest unclipped element ${selector(widest.el)} ends ${Math.round(widest.w)}px from the column's left` : "";
    fail("page-scroll", root, `scroll root scrollWidth ${root.scrollWidth}px > clientWidth ${root.clientWidth}px${named}`);
  }

  // unreachable
  const sh = document.documentElement.scrollHeight;
  for (const el of [document.documentElement, document.body]) {
    const oy = style(el).overflowY;
    if (sh > H + 1 && (oy === "hidden" || oy === "clip")) fail("unreachable", el, `content ${sh}px tall in a ${H}px viewport with overflow-y:${oy}`);
  }

  const chWidth = new Map();
  const ch = (el) => {
    const font = style(el).font;
    let w = chWidth.get(font);
    if (w === undefined) {
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.font = font;
      w = ctx.measureText("0").width || parseFloat(style(el).fontSize) / 2;
      chWidth.set(font, w);
    }
    return w;
  };

  const textRight = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().right;
  };

  const interactive = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=tab]';
  const overlays = "dialog[open], :popover-open, [role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=tooltip]";
  for (const el of document.body.querySelectorAll("*")) {
    if (!painted(el)) continue;
    const r = el.getBoundingClientRect();
    const s = style(el);

    // offscreen: the outermost element of a chain that ends past the right edge, or an element whose own text
    // runs past it (a long unbreakable word overflowing a box that itself fits).
    if (pastRight(el)) {
      if (!(el.parentElement && el.parentElement !== document.body && painted(el.parentElement) && pastRight(el.parentElement))) {
        fail("offscreen", el, `right edge at ${Math.round(r.right)}px, viewport ${W}px`);
      }
    } else if (!insideClipX(el) && s.overflowX === "visible") {
      const right = Math.max(0, ...[...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => textRight(n)));
      if (right > W + 1) fail("offscreen", el, `its text runs to ${Math.round(right)}px, viewport ${W}px`);
    }

    // small-target
    if (el.matches(interactive)) {
      const label = el.matches("input") ? el.closest("label") : null;
      const hit = label ? label.getBoundingClientRect() : r;
      if (hit.width < limits.minTarget - 0.5 || hit.height < limits.minTarget - 0.5) {
        fail("small-target", el, `${Math.round(hit.width)}x${Math.round(hit.height)}px, under ${limits.minTarget}x${limits.minTarget}px`);
      }
    }

    // tall-fixed
    if (s.position === "fixed" || s.position === "sticky") {
      const shown = Math.min(r.bottom, H) - Math.max(r.top, 0);
      if (shown > H * limits.maxFixedShare) {
        fail("tall-fixed", el, `${s.position} element covers ${Math.round(shown)}px of a ${H}px viewport (> ${limits.maxFixedShare * 100}%)`);
      }
    }

    // overlay-bounds: only floating ones (fixed, absolute, or the top layer); an inline listbox scrolls with the page.
    if (el.matches(overlays) && (s.position === "fixed" || s.position === "absolute" || el.matches("dialog[open], :popover-open"))) {
      if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) {
        fail("overlay-bounds", el, `box ${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} in a ${W}x${H} viewport`);
      }
    }

    // letter-wrap: a narrow box whose own text breaks inside a word.
    const limit = limits.letterWrapCh * ch(el);
    const px = (v) => parseFloat(v) || 0;
    const inner = r.width - px(s.paddingLeft) - px(s.paddingRight) - px(s.borderLeftWidth) - px(s.borderRightWidth);
    if (inner >= limit) continue;
    for (const node of el.childNodes) {
      if (node.nodeType !== 3) continue;
      const text = node.textContent;
      const broken = [...text.matchAll(/\S{2,}/g)].find((m) => {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const tops = new Set([...range.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top)));
        return tops.size > 1;
      });
      if (broken) {
        fail("letter-wrap", el, `"${broken[0].slice(0, 24)}" breaks across lines in a ${Math.round(inner)}px box (${limits.letterWrapCh}ch = ${Math.round(limit)}px)`);
        break;
      }
    }
  }

  // one-h1, heading-size
  const sizes = {};
  for (const tag of ["h1", "h2"]) {
    const shown = [...document.body.querySelectorAll(tag)].filter(painted);
    if (tag === "h1" && shown.length !== 1) fail("one-h1", shown[1] ?? document.body, `${shown.length} visible h1 elements`);
    sizes[tag] = shown.length > 0 ? style(shown[0]).fontSize : null;
    for (const h of shown.slice(1)) {
      if (style(h).fontSize !== sizes[tag]) fail("heading-size", h, `${tag} at ${style(h).fontSize}, the page's first ${tag} at ${sizes[tag]}`);
    }
  }

  // page-width: each token resolved to px (a rem value at the root's font size).
  const main = document.querySelector("main");
  const rootPx = parseFloat(style(document.documentElement).fontSize);
  const toPx = (v) => (v.trim().endsWith("rem") ? parseFloat(v) * rootPx : parseFloat(v));
  const widths = limits.pageWidths.map((name) => toPx(style(document.documentElement).getPropertyValue(name)));
  if (!main) fail("page-width", document.body, "no <main>");
  else if (!widths.some((w) => Math.abs(toPx(style(main).maxWidth) - w) < 0.5)) {
    fail("page-width", main, `max-width ${style(main).maxWidth}, not ${limits.pageWidths.map((n, i) => `${n} (${widths[i]}px)`).join(" or ")}`);
  }

  // button-height
  for (const b of document.body.querySelectorAll("button:not([role=switch], [role=option], [role=menuitem], [data-chart-bar])")) {
    if (!painted(b)) continue;
    const h = Math.round(b.getBoundingClientRect().height);
    if (!limits.buttonHeights.includes(h)) fail("button-height", b, `${h}px tall, not ${limits.buttonHeights.join(" or ")}px`);
  }

  // title-wrap: the lines a row title's text takes, counted from its text's line boxes (a control laid over the title,
  // such as the Tasks title's open button, is not text of it).
  for (const el of document.body.querySelectorAll("[data-row-title]")) {
    if (!painted(el)) continue;
    const tops = [];
    const texts = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = texts.nextNode(); n; n = texts.nextNode()) {
      if (!n.textContent.trim() || (n.parentElement !== el && n.parentElement.closest("button"))) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const q of range.getClientRects()) if (q.width > 0 && q.height > 0) tops.push(q.top);
    }
    const lineHeight = parseFloat(style(el).lineHeight) || parseFloat(style(el).fontSize) * 1.2;
    const lines = tops.sort((a, b) => a - b).filter((top, i, all) => i === 0 || top - all[i - 1] > lineHeight / 2).length;
    if (lines > limits.maxTitleLines) fail("title-wrap", el, `${lines} lines, more than ${limits.maxTitleLines}`);
  }

  // raw-name: one failure per element whose own text holds the name.
  const raw = /\b(?:wi_[0-9a-z]+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const named = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || named.has(el) || el.closest("[data-raw], code, pre, script, style") || !painted(el)) continue;
    const m = raw.exec(n.textContent);
    if (!m) continue;
    named.add(el);
    fail("raw-name", el, `"${m[0].slice(0, 40)}" outside [data-raw]`);
  }
  return { failures: out, sizes };
}
