// The layout rules `npm run check:responsive` applies to each page, viewport and theme. `checkLayout` runs inside
// the page (serialized with toString), so it uses only browser APIs. Each rule is one question with one answer:
//
//   page-scroll     the page scrolls sideways: documentElement.scrollWidth > the viewport width, or the
//                   [data-scroll-root] content column's scrollWidth > its clientWidth.
//   offscreen       a visible element, or its own text, ends past the viewport's right edge, and no ancestor of it
//                   clips or scrolls sideways (an overflow-x:auto table wrapper is fine; the wrapper itself is checked
//                   too). A control (a button or a link) past the edge is reported even so when its nearest sideways
//                   scrolling ancestor is a table wrapper (a box whose direct child is a <table>, as Table's in
//                   ui/parts.tsx): it is out of sight and out of reach (the Skills Copy Path at 390px, the item page
//                   Runs actions at 768-1024px, both 2026-11-24). A wrapper marked [data-scroll-x] holds a table that
//                   scrolls sideways on purpose and is skipped. The scroll root, plots that scroll on purpose (the
//                   Workers timeline and graph), tab lists and code blocks are not table wrappers and stay skipped.
//                   Only the outermost such element of a chain is reported. Inside the [data-scroll-root] content
//                   column, an element that starts left of the column's left edge is reported too: the column scrolls
//                   only to the right, so that part is out of reach (Chat's error row, a long request id in a
//                   right-aligned flex row, ran under the sidebar at 390-768px, 2026-11-27).
//   letter-wrap     text in a box narrower than 12ch breaks a word across lines (the old model_by column, PR #530,
//                   was 9ch wide).
//   tall-fixed      a position:fixed or sticky element covers more than 40% of the viewport's height (an open
//                   dialog or popover is an overlay the owner opened and closes, so it is left to overlay-bounds).
//   overlay-bounds  an open dialog, popover, menu, listbox or tooltip extends past the viewport.
//   small-target    a painted interactive element (button, link, input, select, textarea, summary, or a role of
//                   button, menuitem, checkbox, radio, switch, tab) is smaller than 24x24 CSS px; links in running
//                   text count too. An input inside a <label> is measured by the label's box, which clicks it (the
//                   Checkbox's 16px box sits in a 32px label).
//   unreachable     the page is taller than the viewport but html or body hides vertical overflow.
//   panel-collapsed an open dialog's or popover's body ([data-panel-body], [data-dialog-body]) is under
//                   `minPanelBodyPx` (60px) tall while its content is taller: Safari and the cmux browser drew the
//                   calendar event popover's body 24px tall under a scrollbar (owner #92) when it grew from a zero
//                   flex basis. Headless WebKit lays that case out right, so the rule guards the outcome in every engine.
//
// The page template's structure (docs/design/09-dashboard-shell.md, design-system/patterns.md), one rule each:
//
//   one-h1          the page shows other than one h1.
//   heading-size    an h1 or h2 is not the font size of the page's first one; responsive-check.mjs also compares each
//                   page's sizes with the first page's at the same viewport and theme.
//   page-width      <main>'s max-width is neither --page-wide nor --page-read (PageHeader's width prop picks one).
//   prose-width     a paragraph of the item page's About ([data-about-request], [data-about-spec]: p and li) of more
//                   than `proseMinLines` (2) lines has a line of more than `maxProseChars` (75) characters, counted
//                   per rendered line (the 75ch cap of design 09-dashboard-item-about; the owner saw about 150).
//   button-height   a button is not 28px or 32px tall (a switch, a listbox option, a menu item, a chart's bar,
//                   [data-chart-bar], whose height is the chart's, a content chip, [data-chip] (a calendar event),
//                   whose height is its text's, and an image thumbnail, [data-thumb], whose height is the picture's, are
//                   not checked; small-target still holds the chip to 24px).
//   raw-name        visible text holds a snake_case name or a wi_ ID outside [data-raw] (code and pre count as raw).
//   title-wrap      a row title ([data-row-title]: Work, Tasks and Health's Runners rows) wraps onto more than two
//                   lines, so the ID, badge or time beside it squeezed it (design 09-dashboard-shell, 2026-11-22).
//
// The item page (docs/design/09-dashboard-item.md, 2026-11-28):
//
//   item-primary-top  on the item page ([data-item-main]) at a viewport 1280px wide or more (the widest the check runs;
//                   the target is 1440x900), the first primary Button's top is `itemPrimaryTopPx` (600) or more from the
//                   top of the page: the decision and its action must open the page, not sit under About.
//
// Alignment (design 09-dashboard-components, 2026-11-24, the owner's "vertical and horizontal alignments are all wrong"):
//
//   row-align       in a row (a table body's <tr>, [data-row], [data-list-row], [data-item-row], [role=row], a table
//                   card's <li>), a control or badge (button, link, input, select, switch, checkbox, combobox,
//                   [data-level], [data-status]) that sits on the row's first text line has its vertical centre more
//                   than `rowAlignPx` (3px) from that line's centre. The line is the row's first painted text outside a
//                   control or badge; a control on a later line (a details line) is not compared, and a nested row's
//                   controls belong to the nested row. A control that wraps onto lines of its own is measured by its
//                   first line. A 28px button in a top-aligned table cell is 5px low; a 32px "⋯" is 7px low.
//                   An open menu, listbox, dialog or popover inside the row is an overlay and is not compared.
//   toolbar-height  in a toolbar ([role=toolbar], or PageToolbar's control row [data-toolbar]), the controls (buttons,
//                   inputs, selects, comboboxes; a SegmentedControl as one) are not all one height: a 28px sm Button
//                   beside the 32px search Input (Work, until 2026-11-24).
//
//   disclosure-align a Disclosure (<details>) right under a bordered box (its previous sibling has a left border: a
//                   bordered list, a table) has its chevron ([data-chevron], else its summary) more than 1px from that
//                   box's left edge, so the toggle no longer reads as belonging to the list (the audit's "Details"
//                   13px in from the Host sleeps list, 2026-11-24).
//
// `[data-align-skip]` on an element, or on an ancestor inside the row or toolbar, leaves it out of both (a control that
// is meant to sit off the line, such as a tall preview). Rules in `limits.warnOnly` are reported as warnings: they
// print but do not fail the check (see LIMITS).
//
// Elements that are not painted (display:none, visibility:hidden, opacity:0, zero size) and screen-reader-only
// boxes (1px, clipped) are skipped.

export const LIMITS = {
  letterWrapCh: 12,
  maxFixedShare: 0.4,
  buttonHeights: [28, 32],
  pageWidths: ["--page-wide", "--page-read"],
  maxTitleLines: 2,
  maxProseChars: 75,
  proseMinLines: 2,
  minTarget: 24,
  rowAlignPx: 3,
  itemPrimaryTopPx: 600,
  minPanelBodyPx: 60,
  // Rules that print but do not fail: a new rule lands here while the fix it waits on is in progress, named in a
  // comment. row-align was here until the table and row centring (9a4c1d07) reached main, 2026-11-24.
  warnOnly: [],
};

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
    out.push({ rule, selector: selector(el), detail, ...(limits.warnOnly?.includes(rule) ? { warn: true } : {}) });
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
  // A table wrapper holds its <table> as a direct child and is not opted out with [data-scroll-x].
  const tableWrapper = (box) => box.getAttribute("data-scroll-x") === null && [...(box.children ?? [])].some((c) => c.tagName === "TABLE");
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
  const rootLeft = root ? root.getBoundingClientRect().left : null;
  // Whether an ancestor between `el` and the content column clips or scrolls sideways.
  const clippedBelowRoot = (el) => {
    for (let a = el.parentElement; a && a !== root; a = a.parentElement) if (style(a).overflowX !== "visible") return true;
    return false;
  };
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

    // offscreen (left): past the content column's left edge, with nothing between it and the column clipping it.
    if (rootLeft !== null && root.contains(el) && el !== root && r.left < rootLeft - 1 && !clippedBelowRoot(el)) {
      const p = el.parentElement;
      if (!(p && p !== root && painted(p) && p.getBoundingClientRect().left < rootLeft - 1 && !clippedBelowRoot(p))) {
        fail("offscreen", el, `left edge at ${Math.round(r.left)}px, the content column starts at ${Math.round(rootLeft)}px`);
      }
    }

    // small-target
    if (el.matches(interactive)) {
      const label = el.matches("input") ? el.closest("label") : null;
      const hit = label ? label.getBoundingClientRect() : r;
      if (hit.width < limits.minTarget - 0.5 || hit.height < limits.minTarget - 0.5) {
        fail("small-target", el, `${Math.round(hit.width)}x${Math.round(hit.height)}px, under ${limits.minTarget}x${limits.minTarget}px`);
      }
    }

    // tall-fixed (an open dialog or popover is an overlay, held by overlay-bounds instead)
    if ((s.position === "fixed" || s.position === "sticky") && !el.matches("dialog[open]")) {
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

  // prose-width: characters per rendered line of About's paragraphs, counted character by character.
  for (const p of document.body.querySelectorAll("[data-about-request] p, [data-about-spec] p, [data-about-spec] li")) {
    if (!painted(p)) continue;
    const perLine = new Map();
    const texts = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    for (let n = texts.nextNode(); n; n = texts.nextNode()) {
      for (let i = 0; i < n.textContent.length; i++) {
        if (!n.textContent[i].trim()) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        const q = [...range.getClientRects()].find((x) => x.width > 0 && x.height > 0);
        if (q) perLine.set(Math.round(q.top), (perLine.get(Math.round(q.top)) ?? 0) + 1);
      }
    }
    const longest = Math.max(0, ...perLine.values());
    if (perLine.size > limits.proseMinLines && longest > limits.maxProseChars) {
      fail("prose-width", p, `${perLine.size} lines, the longest ${longest} characters, over ${limits.maxProseChars}`);
    }
  }

  // button-height
  for (const b of document.body.querySelectorAll("button:not([role=switch], [role=option], [role=menuitem], [data-chart-bar], [data-chip], [data-thumb])")) {
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
  // row-align
  const ROWS = "tbody > tr, [data-row], [data-list-row], [data-item-row], [role=row], ul[data-cards] > li";
  const ALIGNED = "button, a[href], input:not([type=hidden]), select, [role=switch], [role=checkbox], [role=combobox], [data-level], [data-status]";
  // An open menu, listbox, dialog or popover floats over the row (OverflowMenu's list is `fixed` but stays the row's
  // DOM descendant): an overlay, not row content, so neither its items nor its text are measured against the row.
  const OVERLAY = "[role=menu], [role=listbox], [role=dialog], dialog, [data-popover]";
  const skipped = (el, within) => {
    for (let e = el; e; e = e.parentElement) {
      if (e.getAttribute("data-align-skip") !== null) return true;
      if (e === within) return false;
      if (e.matches(OVERLAY)) return true;
    }
    return false;
  };
  /** The first line box of `el`'s first painted text: [top, bottom], or null. */
  const firstLine = (el, accept) => {
    const texts = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = texts.nextNode(); n; n = texts.nextNode()) {
      if (!n.textContent.trim() || !accept(n.parentElement)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const q = [...range.getClientRects()].find((x) => x.width > 0 && x.height > 0);
      if (q) return [q.top, q.bottom];
    }
    return null;
  };
  for (const row of document.body.querySelectorAll(ROWS)) {
    if (!painted(row) || row.getAttribute("data-align-skip") !== null) continue;
    const own = (el) => el.closest(ROWS) === row && !skipped(el, row);
    const line = firstLine(row, (p) => own(p) && painted(p) && !p.closest(ALIGNED));
    if (!line) continue;
    const centre = (line[0] + line[1]) / 2;
    const seen = [];
    for (const el of row.querySelectorAll(ALIGNED)) {
      if (!own(el) || !painted(el) || seen.some((s) => s.contains(el))) continue;
      seen.push(el);
      let [top, bottom] = [el.getBoundingClientRect().top, el.getBoundingClientRect().bottom];
      if (bottom <= line[0] || top >= line[1]) continue; // on another line of the row
      // A control whose text wraps (a long title link) is measured by its first line.
      const lh = parseFloat(style(el).lineHeight) || parseFloat(style(el).fontSize) * 1.2;
      if (bottom - top > lh * 1.5 && bottom - top > 40) {
        const first = firstLine(el, () => true);
        if (first) [top, bottom] = first;
      }
      const off = (top + bottom) / 2 - centre;
      if (Math.abs(off) > limits.rowAlignPx) {
        fail("row-align", el, `centre ${off > 0 ? "+" : ""}${Math.round(off * 10) / 10}px from the row's first text line (${Math.round(bottom - top)}px tall), over ${limits.rowAlignPx}px`);
      }
    }
  }

  // toolbar-height
  for (const bar of document.body.querySelectorAll("[role=toolbar], [data-toolbar]")) {
    if (!painted(bar)) continue;
    const controls = [...bar.querySelectorAll("button, input:not([type=hidden], [type=checkbox], [type=radio]), select, [role=radiogroup], [role=combobox]")].filter(
      (el) => painted(el) && !skipped(el, bar) && !el.closest("[role=tablist], [role=menu], [role=listbox], dialog") && !(el.parentElement?.closest("[role=radiogroup]") && el.getAttribute("role") !== "radiogroup"),
    );
    const heights = controls.map((el) => Math.round(el.getBoundingClientRect().height));
    const counts = new Map();
    for (const h of heights) counts.set(h, (counts.get(h) ?? 0) + 1);
    if (counts.size < 2) continue;
    // The height most controls have; on a tie, the taller (the 32px control height).
    const main = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    controls.forEach((el, i) => {
      if (heights[i] !== main) fail("toolbar-height", el, `${heights[i]}px tall in a toolbar of ${main}px controls`);
    });
  }

  // item-primary-top
  const itemMain = document.body.querySelectorAll("[data-item-main]")[0];
  if (itemMain && W >= 1280) {
    const primary = [...itemMain.querySelectorAll("button.bg-accent")].find(painted);
    if (primary) {
      const top = Math.round(primary.getBoundingClientRect().top + window.scrollY);
      if (top >= limits.itemPrimaryTopPx) fail("item-primary-top", primary, `primary button ${top}px from the top, limit ${limits.itemPrimaryTopPx}px`);
    }
  }

  // disclosure-align
  for (const d of document.body.querySelectorAll("details")) {
    const box = d.previousElementSibling;
    if (!box || !painted(d) || !painted(box) || parseFloat(style(box).borderLeftWidth) === 0) continue;
    const summary = d.querySelector(":scope > summary");
    const mark = summary?.querySelector("[data-chevron]") ?? summary;
    if (!mark || !painted(mark)) continue;
    const off = mark.getBoundingClientRect().left - box.getBoundingClientRect().left;
    if (Math.abs(off) > 1) fail("disclosure-align", summary, `chevron ${off > 0 ? "+" : ""}${Math.round(off)}px from the left edge of the bordered box above it`);
  }

  // panel-collapsed
  for (const body of document.body.querySelectorAll("dialog[open] [data-panel-body], dialog[open] [data-dialog-body]")) {
    if (!painted(body)) continue;
    const [shown, full] = [body.clientHeight, body.scrollHeight];
    if (shown < Math.min(limits.minPanelBodyPx, full) - 1) fail("panel-collapsed", body, `${shown}px tall showing ${full}px of content, under ${limits.minPanelBodyPx}px`);
  }

  return { failures: out, sizes };
}
