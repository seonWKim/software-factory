import { cn } from "../../lib/cn.js";
import { FOCUS } from "./control.js";

interface SegmentedControlProps<T extends string> {
  /** The group's accessible name, e.g. "Task view". */
  label: string;
  /** `data`: the segment's data attributes, such as the `data-action` of the command it sends (a decision's buttons carry one each). */
  options: readonly { id: T; label: string; data?: Readonly<Record<`data-${string}`, string>> }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}

/**
 * One choice of a few views (docs/design/09-brand-and-tokens.md): a 32px box with a 1px border-strong edge holding
 * 28px segments in one row that never wraps. The selected segment is marked with aria-pressed and neutral (surface
 * fill, a border-strong ring drawn inside it, text-1), so it reads in light and dark alike; the others are text-2 on the
 * surface. Its corner is the box's radius less the 2px of border and padding, and the inset ring keeps a 1px gap from
 * the box's edge, so the two outlines never touch (owner feedback 2026-11-20).
 */
export function SegmentedControl<T extends string>({ label, options, value, onChange, className }: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex max-w-full flex-nowrap gap-0.5 rounded-control border border-border-strong bg-surface p-px", className)}
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          {...o.data}
          onClick={() => onChange(o.id)}
          className={cn(
            // Nested in the box's 1px padding and 1px border: the corner is 2px tighter than the box's, so the curves match.
            "inline-flex min-h-7 items-center rounded-[calc(var(--radius-control)-2px)] px-3 text-sm font-medium whitespace-nowrap motion-safe:transition-colors",
            "text-text-2 enabled:hover:bg-surface-2 enabled:hover:text-text-1",
            "aria-pressed:bg-surface aria-pressed:text-text-1 aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-border-strong enabled:aria-pressed:hover:bg-surface enabled:aria-pressed:hover:text-text-1",
            FOCUS,
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
