// The layout rules `npm run check:responsive` applies to each page, viewport and theme. `checkLayout` runs inside
// the page (serialized with toString), so it uses only browser APIs. Each rule is one question with one answer:
//
//   page-scroll     the page scrolls sideways: documentElement.scrollWidth > the viewport width.
//   offscreen       a visible element, or its own text, ends past the viewport's right edge, and no ancestor of it
//                   clips or scrolls sideways (an overflow-x:auto table wrapper is fine; the wrapper itself is checked
//                   too). Only the outermost such element of a chain is reported.
//   letter-wrap     text in a box narrower than 12ch breaks a word across lines (the old model_by column, PR #530,
//                   was 9ch wide).
//   tall-fixed      a position:fixed or sticky element covers more than 40% of the viewport's height.
//   overlay-bounds  an open dialog, popover, menu, listbox or tooltip extends past the viewport.
//   unreachable     the page is taller than the viewport but html or body hides vertical overflow.
//
// Elements that are not painted (display:none, visibility:hidden, opacity:0, zero size) and screen-reader-only
// boxes (1px, clipped) are skipped.

export const LIMITS = { letterWrapCh: 12, maxFixedShare: 0.4 };

/** Runs in the page: the failures as { rule, selector, detail }; marks each failing element for the screenshot. */
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
  const pastRight = (el) => el.getBoundingClientRect().right > W + 1 && !insideClipX(el);

  // page-scroll
  const sw = document.documentElement.scrollWidth;
  if (sw > W + 1) fail("page-scroll", document.documentElement, `scrollWidth ${sw}px > viewport ${W}px`);

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
  return out;
}
