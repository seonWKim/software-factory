import { cn } from "../../lib/cn.js";
import { FOCUS } from "./control.js";

interface SegmentedControlProps<T extends string> {
  /** The group's accessible name, e.g. "Task view". */
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}

/**
 * One choice of a few views (docs/design/09-brand-and-tokens.md): a 32px box with a 1px border-strong edge holding
 * 28px segments in one row that never wraps. The selected segment is marked with aria-pressed and filled with the
 * accent, on-solid text, so it reads in light and dark alike; the others are text-2 on the surface.
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
          onClick={() => onChange(o.id)}
          className={cn(
            "inline-flex min-h-7 items-center rounded-control px-3 text-sm font-medium whitespace-nowrap motion-safe:transition-colors",
            "text-text-2 enabled:hover:bg-surface-2 enabled:hover:text-text-1",
            "aria-pressed:bg-accent aria-pressed:text-on-solid enabled:aria-pressed:hover:bg-accent enabled:aria-pressed:hover:text-on-solid",
            FOCUS,
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
