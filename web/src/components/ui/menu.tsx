import { Check } from "lucide-react";
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
  /** Set on a list that picks one of its items: the current one is true, the others false (aria-checked, a check mark). */
  checked?: boolean;
  /** The item's `data-action`: the command it sends (a decision's actions carry one each). */
  action?: string;
}

/**
 * A button that opens a list of actions; Esc, a click outside or choosing an item closes it. The button shows "⋯"
 * unless `icon` is given (a picker such as the theme menu); items with `checked` mark the current choice.
 */
export function OverflowMenu({ label, items, icon }: { label: string; items: readonly MenuItem[]; icon?: ReactNode }) {
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
        {icon ?? <span aria-hidden>⋯</span>}
      </Button>
      {open && (
        <ul id={id} role="menu" aria-label={label} className="absolute right-0 z-10 mt-1 min-w-40 rounded-control border border-border bg-surface py-1 shadow">
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                aria-checked={item.checked}
                {...(item.action ? { "data-action": item.action } : {})}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm enabled:hover:bg-surface-2",
                  FOCUS,
                  "focus-visible:-outline-offset-2",
                  DISABLED,
                  item.danger && "text-pill-bad-fg",
                )}
              >
                {item.checked !== undefined && <Check aria-hidden className={cn("size-4 shrink-0", !item.checked && "invisible")} />}
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
