import { X } from "lucide-react";
import { type ComponentProps, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";
import { Button } from "./button.js";
import { CARD_TITLE } from "./card.js";
import { FOCUS } from "./control.js";
import { ModalPanel } from "./dialog.js";
import { useWide } from "./parts.js";

// Popover (the details of one thing on a page, anchored beside it, like a macOS popover) and ChipButton (a content
// chip that opens one, such as a calendar event). Plain React: no positioning library, so the panel's place is a
// measured check when it opens and when the window scrolls or resizes, as Select and OverflowMenu measure theirs.

/** The room kept between the panel and its anchor, and between the panel and the window's edges. */
const GAP_PX = 8;

export interface PopoverProps {
  /** The element it opens from: the panel sits beside it, and focus goes back to it when the panel closes. */
  anchor: RefObject<HTMLElement | null>;
  /** The panel's heading, shown whole (it wraps, never cut). */
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** A line pinned under the body (a link out, such as a calendar event's link to its calendar): it stays in view while the body scrolls. */
  footer?: ReactNode;
}

/**
 * Where the panel sits, always whole inside the window: right of the anchor, else left of it; beside it, its top is
 * the anchor's top, flipped (its bottom on the anchor's bottom) when it would run past the window's bottom, then
 * shifted inside the window. With no room on either side it goes under the anchor, flipped over it when it would run
 * past the bottom and fits above, else on the side with more room, shifted inside. The panel is fixed and rendered
 * into `document.body`, so no scrolling or clipping box of the page cuts it.
 */
export function place(anchor: DOMRect, panel: { width: number; height: number }, win = { width: innerWidth, height: innerHeight }): { left: number; top: number } {
  const [w, h] = [win.width, win.height];
  const clamp = (v: number, max: number) => Math.max(GAP_PX, Math.min(v, max - GAP_PX));
  const besideTop = clamp(anchor.top + panel.height <= h - GAP_PX ? anchor.top : anchor.bottom - panel.height, h - panel.height);
  if (anchor.right + GAP_PX + panel.width <= w - GAP_PX) return { left: anchor.right + GAP_PX, top: besideTop };
  if (anchor.left - GAP_PX - panel.width >= GAP_PX) return { left: anchor.left - GAP_PX - panel.width, top: besideTop };
  const left = clamp(anchor.left, w - panel.width);
  const below = anchor.bottom + GAP_PX;
  const above = anchor.top - GAP_PX - panel.height;
  if (below + panel.height <= h - GAP_PX) return { left, top: below };
  if (above >= GAP_PX) return { left, top: above };
  return { left, top: clamp(h - anchor.bottom >= anchor.top ? below : above, h - panel.height) };
}

/**
 * The details of one thing, anchored beside it from `sm` up: a non-modal native `<dialog>` (opened with `show()`, so
 * the page stays usable) rendered into `document.body`, 20rem wide, at most 32rem tall (and the window's height less
 * 8px each side), so it can sit beside its anchor (see `place`), with a header (the whole title and a close icon
 * button) over a body that keeps its content height and scrolls only past the max height, and an optional `footer`
 * pinned under the body. A Popover opened from inside another (an event in a day's list) stacks over it: a press in
 * the later one does not close the earlier, and Esc closes the top one only. Below `sm` it is a `ModalPanel`
 * (a sheet over the page) with the same whole title and body. Esc, the close button and a press outside it (not on the
 * anchor, which toggles it itself) close it; focus goes into its body on open and back to the anchor on close, unless
 * the owner moved it elsewhere (pressing another chip).
 */
export function Popover({ anchor, title, onClose, children, footer }: PopoverProps) {
  const wide = useWide();
  if (!wide) {
    return (
      // The title in `header`, so it wraps whole; ModalPanel's own title is one line, cut (it stays the hidden heading).
      <ModalPanel title={title} header={<p aria-hidden data-raw className="text-base font-semibold text-pretty wrap-anywhere">{title}</p>} size="md" onClose={onClose} returnFocusTo={anchor} footer={footer}>
        {children}
      </ModalPanel>
    );
  }
  return (
    <AnchoredPanel anchor={anchor} title={title} onClose={onClose} footer={footer}>
      {children}
    </AnchoredPanel>
  );
}

function AnchoredPanel({ anchor, title, onClose, children, footer }: PopoverProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  // Opened first, then measured: a closed <dialog> has no size. Measured again when the window scrolls or resizes, or
  // the panel's own size changes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) {
      if (typeof el.show === "function") el.show();
      else el.setAttribute("open", "");
    }
    const measure = () => {
      const a = anchor.current;
      if (!a) return;
      setAt(place(a.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight }));
    };
    measure();
    const resized = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    resized?.observe(el);
    addEventListener("resize", measure);
    addEventListener("scroll", measure, true);
    return () => {
      resized?.disconnect();
      removeEventListener("resize", measure);
      removeEventListener("scroll", measure, true);
    };
  }, [anchor]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.querySelector<HTMLElement>("[data-panel-body]")?.focus({ preventScroll: true });
    // The popovers open now, in the order they opened (each is appended to body); the last is on top.
    const open = () => [...document.querySelectorAll("dialog[data-popover][open]")];
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || open().at(-1) !== el) return;
      e.preventDefault();
      close.current();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      const later = open().slice(open().indexOf(el) + 1);
      if (!el.contains(target) && !anchor.current?.contains(target) && !later.some((p) => p.contains(target))) close.current();
    };
    addEventListener("keydown", onKey);
    addEventListener("pointerdown", onDown);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("pointerdown", onDown);
      // Back to the anchor when focus was in the panel (Esc, the close button) or nowhere; not when another control took it.
      const focused = document.activeElement;
      const back = focused === null || focused === document.body || el.contains(focused);
      if (el.open && typeof el.close === "function") el.close();
      if (back && anchor.current?.isConnected) anchor.current.focus({ preventScroll: true });
    };
    // Listens once per mount.
  }, []);

  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-popover
      style={at ?? { visibility: "hidden" }}
      className={cn(
        "fixed z-40 m-0 max-h-[min(32rem,calc(100dvh-1rem))] w-80 flex-col overflow-hidden p-0 open:flex",
        "rounded-box border border-border bg-surface text-text-1 shadow-lg",
      )}
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border py-2 pr-2 pl-4">
        <h2 id={titleId} data-raw className={cn(CARD_TITLE, "min-w-0 flex-1 pt-1.5 text-pretty wrap-anywhere")}>
          {title}
        </h2>
        <Button variant="ghost" size="icon" aria-label={t("common.close")} onClick={onClose} className="text-text-2">
          <X aria-hidden className="size-4" />
        </Button>
      </header>
      {/* Its content height (flex: 0 1 auto), shrinking to the max height: never flex-1, whose zero basis Safari and the
          cmux browser take as the body's height, drawing it 24px tall under a scrollbar (owner #92). */}
      <div data-panel-body tabIndex={-1} className="min-h-0 flex-initial overflow-y-auto overscroll-contain px-4 py-3 text-sm outline-none">
        {children}
      </div>
      {footer !== undefined && <footer data-panel-footer className="shrink-0 border-t border-border px-4 py-2 text-sm">{footer}</footer>}
    </dialog>,
    document.body,
  );
}

/** A chip's title cut at 2 lines: the chip opens the whole text, so it needs no Clamp "Show more" of its own. */
export const CHIP_TITLE = "line-clamp-2 wrap-anywhere";

/**
 * A content chip that opens a Popover (a calendar event): a plain button as tall as its content (at least 24px, so a
 * one-line chip is still a target), filling its width, text left-aligned, a `surface-2` hover fill, the shared focus
 * ring, `aria-haspopup="dialog"` and `aria-expanded`. Marked `data-chip`: check:responsive's button heights (28 or
 * 32px) are for controls, not for content whose height is its text's.
 */
export function ChipButton({ open, className, ...props }: ComponentProps<"button"> & { open: boolean }) {
  return (
    <button
      type="button"
      data-chip
      aria-haspopup="dialog"
      aria-expanded={open}
      className={cn("flex min-h-6 w-full min-w-0 cursor-default rounded-control text-left motion-safe:transition-colors", FOCUS, className)}
      {...props}
    />
  );
}
