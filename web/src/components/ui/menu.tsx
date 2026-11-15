import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { Button } from "./button.js";
import { DISABLED, FOCUS } from "./control.js";

// OverflowMenu (a "more" button with a short list of actions) and Tooltip (a short hint on hover and focus, which
// stays open while hovered or focused so a link in it works).
// Plain React: no positioning library, so both sit by CSS next to their trigger.

export interface MenuItem {
  label: string;
  onSelect(): void;
  danger?: boolean;
  disabled?: boolean;
}

/** A "more" button that opens a list of actions; Esc, a click outside or choosing an item closes it. */
export function OverflowMenu({ label, items }: { label: string; items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    addEventListener("keydown", onKey);
    addEventListener("mousedown", onDown);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("mousedown", onDown);
    };
  }, [open]);
  return (
    <div ref={root} className="relative inline-block">
      <Button variant="ghost" size="icon" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        <span aria-hidden>⋯</span>
      </Button>
      {open && (
        <ul id={id} role="menu" aria-label={label} className="absolute right-0 z-10 mt-1 min-w-40 rounded-control border border-border bg-surface py-1 shadow">
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cn(
                  "block w-full px-3 py-1.5 text-left text-sm enabled:hover:bg-surface-2",
                  FOCUS,
                  "focus-visible:-outline-offset-2",
                  DISABLED,
                  item.danger && "text-pill-bad-fg",
                )}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Where the bubble sits along its trigger: centred (default), from its left edge, or ending at its right edge. */
const ALIGN = { center: "left-1/2 -translate-x-1/2", start: "left-0", end: "right-0" } as const;

/**
 * A short hint for its child, shown on hover and on keyboard focus, hidden by Esc. `placement` is above (default) or
 * below. It stays open while the pointer or focus is inside it, so a link in `text` can be clicked or tabbed to.
 */
export function Tooltip({ text, placement = "top", align = "center", className, children }: {
  text: ReactNode;
  placement?: "top" | "bottom";
  align?: keyof typeof ALIGN;
  /** Classes for the wrapper around the trigger, such as a size. */
  className?: string;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <span
      className={cn("relative inline-flex", className)}
      aria-describedby={shown ? id : undefined}
      onMouseEnter={() => setShown(true)}
      onMouseLeave={() => setShown(false)}
      onFocus={() => setShown(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setShown(false)}
      onKeyDown={(e) => e.key === "Escape" && setShown(false)}
    >
      {children}
      {shown && (
        // The padding, not a margin, bridges trigger and bubble, so the pointer can move onto the bubble.
        <span id={id} role="tooltip" className={cn("absolute z-10", ALIGN[align], placement === "top" ? "bottom-full pb-1" : "top-full pt-1")}>
          <span className="block w-max max-w-56 rounded-control bg-text-1 px-2 py-1 text-xs text-surface">{text}</span>
        </span>
      )}
    </span>
  );
}
