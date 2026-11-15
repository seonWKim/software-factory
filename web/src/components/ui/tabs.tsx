import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { FOCUS } from "./control.js";

interface TabsProps<T extends string> {
  /** The tablist's accessible name, e.g. "Project". */
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  /** A quiet row action drawn at the end of the same bordered row, outside the tablist (not a tab, not in the tab order), e.g. an icon-only ghost "+" Button. */
  action?: ReactNode;
  className?: string;
}

/**
 * Underline tabs that filter one page (docs/design/09-brand-and-tokens.md, design-system/components.md), like Grafana's
 * page tabs: a 1px `border` line runs the full width of the row, tabs are plain text 16px apart, and the selected tab is
 * `text-1` with a 2px `accent` underline on that line. `role=tablist`, each option a `role=tab` with aria-selected, and
 * only the selected tab in the tab order (roving tabindex). ArrowRight and ArrowLeft move to the next and previous tab,
 * wrapping at the ends; Home and End go to the first and last; the tab a key moves to is selected at once. A long row
 * scrolls sideways inside its own box. The optional `action` sits after the tablist inside the same row.
 */
export function Tabs<T extends string>({ label, options, value, onChange, action, className }: TabsProps<T>) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || options.length === 0) return;
    const at = Math.max(0, options.findIndex((o) => o.id === value));
    const last = options.length - 1;
    const to = e.key === "ArrowRight" ? (at === last ? 0 : at + 1) : e.key === "ArrowLeft" ? (at === 0 ? last : at - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (to === null) return;
    e.preventDefault();
    onChange(options[to]!.id);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
  };
  return (
    <div className={cn("flex w-full max-w-full items-center gap-4 border-b border-border", className)}>
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex min-w-0 flex-nowrap gap-4 overflow-x-auto">
      {options.map((o) => {
        const selected = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.id)}
            className={cn(
              "inline-flex min-h-8 shrink-0 items-center border-b-2 border-transparent text-sm font-medium whitespace-nowrap motion-safe:transition-colors",
              "text-text-2 hover:text-text-1",
              "aria-selected:border-accent aria-selected:text-text-1",
              FOCUS,
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
    {action}
    </div>
  );
}
