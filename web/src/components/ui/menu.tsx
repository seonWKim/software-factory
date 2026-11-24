import { Check, type LucideIcon } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { Button } from "./button.js";
import { DISABLED, FOCUS } from "./control.js";
import { Kbd } from "./notice.js";

// OverflowMenu (a "more" button with a short list of actions, in the look of a native macOS menu) and Tooltip (a short
// hint on hover and focus, which stays open while hovered or focused so a link in it works).
// Plain React: no positioning library, so both sit by CSS next to their trigger.

export interface MenuItem {
  label: string;
  onSelect(): void;
  danger?: boolean;
  disabled?: boolean;
  /** Set on a list that picks one of its items: the current one is true, the others false (a menuitemradio with a check mark). */
  checked?: boolean;
  /** A leading icon from lucide-react; when any item has one, every item keeps the icon column so the labels align. */
  icon?: LucideIcon;
  /** The item's `data-action`: the CLI command it sends (a decision's actions carry one each). */
  action?: string;
  /** The item's `data-item`: the ID of the work item or task its action is for. */
  item?: string;
  /** The key that does the same, shown in a Kbd at the item's end (Kbd `hint`) and named by `aria-keyshortcuts`. */
  shortcut?: string;
}

/** A line between two groups of items. */
export interface MenuSeparator {
  separator: true;
}

/** A small heading over the items after it (such as "Appearance" over System, Light and Dark). */
export interface MenuGroupLabel {
  group: string;
}

export type MenuEntry = MenuItem | MenuSeparator | MenuGroupLabel;

const isItem = (e: MenuEntry): e is MenuItem => "onSelect" in e;

/** The room kept between an opened list and the edge of the page content (or of the viewport). */
const EDGE_PX = 8;

/** The menu panel: the elevated surface, box radius, the floating shadow, 4px inside. */
export const MENU_PANEL = "absolute z-20 min-w-48 max-w-[calc(100vw-1rem)] rounded-box border border-border bg-surface/95 p-1 shadow-lg backdrop-blur-md";
/** One item: 28px high, a highlight pill (control radius) on hover and keyboard focus. */
export const MENU_ITEM = "flex h-7 w-full items-center gap-2 rounded-control px-2 text-left text-sm whitespace-nowrap outline-none";

/** The menu's enabled items, in order. */
function itemsIn(list: HTMLElement | null): HTMLButtonElement[] {
  return list ? [...list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")] : [];
}

/**
 * A button that opens a menu of actions; Esc, Tab, a click outside or choosing an item closes it, and the focus goes back
 * to the button. The button shows "⋯" unless `icon` is given. Entries are items (optional icon, check, shortcut,
 * `danger`, `disabled`), separators and group labels. Keys: Enter, Space, ArrowDown or ArrowUp on the button opens it
 * on the first (last) item; ArrowDown and ArrowUp move round the items, Home and End jump, a letter moves to the next
 * item starting with it. The pointer moves the highlight too, so hover and keyboard show one pill.
 * The list ends at the button's right edge, or starts at its left edge when ending there would put its left part past
 * the left edge of the page content (`main`, else the viewport), where the sidebar would cover its labels; it opens
 * above the button when the viewport has no room below and there is more above.
 */
export function OverflowMenu({ label, items, icon }: { label: string; items: readonly MenuEntry[]; icon?: ReactNode }) {
  const [open, setOpen] = useState<false | "first" | "last">(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [fromStart, setFromStart] = useState(false);
  const [up, setUp] = useState(false);
  const id = useId();
  const withIcons = items.some((e) => isItem(e) && e.icon !== undefined);
  const withChecks = items.some((e) => isItem(e) && e.checked !== undefined);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  // A measured check when it opens (no positioning library), as Select picks above or below; then the focus goes in.
  useLayoutEffect(() => {
    if (!open || !root.current || !list.current) return;
    const button = root.current.getBoundingClientRect();
    const panel = list.current.getBoundingClientRect();
    const edge = (root.current.closest("main")?.getBoundingClientRect().left ?? 0) + EDGE_PX;
    setFromStart(button.right - panel.width < edge && button.left + panel.width <= innerWidth - EDGE_PX);
    const below = innerHeight - button.bottom;
    setUp(below < panel.height + EDGE_PX && button.top > below);
    const all = itemsIn(list.current);
    (open === "last" ? all.at(-1) : all[0])?.focus({ preventScroll: true });
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    // Esc with the focus outside the menu (the menu's own Esc stops at its root, below) still closes it.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", onDown);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("mousedown", onDown);
      removeEventListener("keydown", onKey);
    };
  }, [open]);
  const onListKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const all = itemsIn(list.current);
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => all[(i + all.length) % all.length]?.focus();
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Tab") return setOpen(false);
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const key = e.key.toLowerCase();
      const next = [...all.slice(at + 1), ...all.slice(0, at + 1)].find((b) => b.dataset.label?.toLowerCase().startsWith(key));
      if (!next) return;
      next.focus();
    } else return;
    // Handled here, so a list the menu sits in (the Work tree's rows) does not move its own focus too.
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div
      ref={root}
      className="relative inline-block"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        // Not the dialog the menu sits in: Esc closes the menu only.
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }}
    >
      <Button
        ref={trigger}
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(open ? false : "first")}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setOpen(e.key === "ArrowUp" ? "last" : "first");
        }}
        className={cn(open && "bg-surface-2")}
      >
        {icon ?? <span aria-hidden>⋯</span>}
      </Button>
      {open && (
        <ul
          ref={list}
          id={id}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          data-side={fromStart ? "start" : "end"}
          data-up={up || undefined}
          onKeyDown={onListKey}
          onMouseLeave={() => list.current?.focus({ preventScroll: true })}
          className={cn(MENU_PANEL, "outline-none data-[side=end]:right-0 data-[side=start]:left-0", up ? "bottom-full mb-1" : "top-full mt-1")}
        >
          {items.map((entry, i) => {
            if ("separator" in entry) return <li key={`sep-${i}`} role="separator" className="mx-2 my-1 h-px bg-border" />;
            if (!isItem(entry))
              return (
                <li key={`group-${entry.group}`} role="presentation" className="px-2 pt-1.5 pb-0.5 text-xs font-semibold text-text-2">
                  {entry.group}
                </li>
              );
            const Icon = entry.icon;
            return (
              <li key={entry.label} role="none">
                <button
                  type="button"
                  role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
                  aria-checked={entry.checked}
                  tabIndex={-1}
                  data-label={entry.label}
                  title={entry.label.length > 40 ? entry.label : undefined}
                  {...(entry.action ? { "data-action": entry.action } : {})}
                  {...(entry.item ? { "data-item": entry.item } : {})}
                  {...(entry.shortcut ? { "aria-keyshortcuts": entry.shortcut } : {})}
                  disabled={entry.disabled}
                  onMouseMove={(e) => document.activeElement !== e.currentTarget && e.currentTarget.focus({ preventScroll: true })}
                  onClick={() => {
                    // The button takes the focus back first, so a dialog the item opens returns it there.
                    close(true);
                    entry.onSelect();
                  }}
                  className={cn(
                    MENU_ITEM,
                    entry.danger ? "text-pill-bad-fg focus:bg-pill-bad-bg" : "text-text-1 focus:bg-surface-2",
                    FOCUS,
                    "focus-visible:-outline-offset-2",
                    DISABLED,
                  )}
                >
                  {withChecks && <Check aria-hidden className={cn("size-4 shrink-0", !entry.checked && "invisible")} />}
                  {withIcons && (Icon ? <Icon aria-hidden className={cn("size-4 shrink-0", !entry.danger && "text-text-2")} /> : <span aria-hidden className="size-4 shrink-0" />)}
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  {entry.shortcut && <span className="ml-4 shrink-0"><Kbd hint={entry.shortcut} /></span>}
                </button>
              </li>
            );
          })}
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
 * below, or beside the trigger from its top edge; `shortcut` adds the trigger's key in a Kbd. It stays open while the pointer or focus is inside it, so a link in `text` can be clicked or tabbed to.
 */
export function Tooltip({ text, shortcut, placement = "top", align = "center", className, children }: {
  text: ReactNode;
  /** The key that does what the trigger does, shown in a Kbd after the text. */
  shortcut?: string;
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
          <span className="block w-max max-w-56 rounded-control bg-text-1 px-2 py-1 text-xs text-surface">
            {text}
            {shortcut && <span className="ml-1.5"><Kbd>{shortcut}</Kbd></span>}
          </span>
        </span>
      )}
    </span>
  );
}
