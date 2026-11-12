import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { Button } from "./button.js";
import { DISABLED, FOCUS } from "./control.js";

// OverflowMenu (a "more" button with a short list of actions) and Tooltip (a short hint on hover and focus).
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

/** A short hint for its child, shown on hover and on keyboard focus, hidden by Esc. `placement` is above (default) or below. */
export function Tooltip({ text, placement = "top", children }: { text: string; placement?: "top" | "bottom"; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <span
      className="relative inline-flex"
      aria-describedby={shown ? id : undefined}
      onMouseEnter={() => setShown(true)}
      onMouseLeave={() => setShown(false)}
      onFocus={() => setShown(true)}
      onBlur={() => setShown(false)}
      onKeyDown={(e) => e.key === "Escape" && setShown(false)}
    >
      {children}
      {shown && (
        <span
          id={id}
          role="tooltip"
          className={cn(
            "pointer-events-none absolute left-1/2 z-10 w-max max-w-56 -translate-x-1/2 rounded-control bg-text-1 px-2 py-1 text-xs text-surface",
            placement === "top" ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {text}
        </span>
      )}
    </span>
  );
}
