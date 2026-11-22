import { Check } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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

/** The room kept between an opened list and the edge of the page content (or of the viewport). */
const EDGE_PX = 8;

/**
 * A button that opens a list of actions; Esc, a click outside or choosing an item closes it. The button shows "⋯"
 * unless `icon` is given (a picker such as the theme menu); items with `checked` mark the current choice.
 * The list ends at the button's right edge, or starts at its left edge when ending there would put its left part past
 * the left edge of the page content (`main`, else the viewport), where the sidebar would cover its labels.
 */
export function OverflowMenu({ label, items, icon }: { label: string; items: readonly MenuItem[]; icon?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [fromStart, setFromStart] = useState(false);
  const id = useId();
  // A measured check when it opens (no positioning library), as Select picks above or below.
  useLayoutEffect(() => {
    if (!open || !root.current || !list.current) return;
    const button = root.current.getBoundingClientRect();
    const edge = (root.current.closest("main")?.getBoundingClientRect().left ?? 0) + EDGE_PX;
    setFromStart(button.right - list.current.getBoundingClientRect().width < edge);
  }, [open]);
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
        <ul ref={list} id={id} role="menu" aria-label={label} data-side={fromStart ? "start" : "end"} className="absolute z-10 mt-1 min-w-40 rounded-control border border-border bg-surface py-1 shadow data-[side=end]:right-0 data-[side=start]:left-0">
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
/** `beside`: level with the trigger's top, to its right (`start`, `center`) or its left (`end`); for a trigger inside a scroller that would clip a bubble above it. */
const BESIDE = { center: "left-full pl-1", start: "left-full pl-1", end: "right-full pr-1" } as const;
const PLACE = { top: "bottom-full pb-1", bottom: "top-full pt-1" } as const;

/**
 * A short hint for its child, shown on hover and on keyboard focus, hidden by Esc. `placement` is above (default),
 * below, or beside the trigger from its top edge. It stays open while the pointer or focus is inside it, so a link in `text` can be clicked or tabbed to.
 */
export function Tooltip({ text, placement = "top", align = "center", className, children }: {
  text: ReactNode;
  placement?: "top" | "bottom" | "beside";
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
        <span id={id} role="tooltip" className={cn("absolute z-10", placement === "beside" ? cn("top-0", BESIDE[align]) : cn(ALIGN[align], PLACE[placement]))}>
          <span className="block w-max max-w-56 rounded-control bg-text-1 px-2 py-1 text-xs text-surface">{text}</span>
        </span>
      )}
    </span>
  );
}
