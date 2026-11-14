import type { KeyboardEvent } from "react";
import { cn } from "../../lib/cn.js";
import { FOCUS } from "./control.js";

interface TabsProps<T extends string> {
  /** The tablist's accessible name, e.g. "Project". */
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}

/**
 * A row of tabs that filter one page (docs/design/09-brand-and-tokens.md, design-system/components.md): the look of
 * SegmentedControl (32px box, 28px segments, token colours) with tab semantics. `role=tablist`, each option a
 * `role=tab` with aria-selected, and only the selected tab in the tab order (roving tabindex). ArrowRight and
 * ArrowLeft move to the next and previous tab, wrapping at the ends; Home and End go to the first and last; the
 * tab a key moves to is selected at once. A long row scrolls sideways inside its own box.
 */
export function Tabs<T extends string>({ label, options, value, onChange, className }: TabsProps<T>) {
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
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("flex max-w-full flex-nowrap gap-0.5 overflow-x-auto rounded-control border border-border-strong bg-surface p-px", className)}
    >
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
              "inline-flex min-h-7 shrink-0 items-center rounded-control px-3 text-sm font-medium whitespace-nowrap motion-safe:transition-colors",
              "text-text-2 hover:bg-surface-2 hover:text-text-1",
              "aria-selected:bg-accent aria-selected:text-on-solid aria-selected:hover:bg-accent aria-selected:hover:text-on-solid",
              FOCUS,
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
