import { useRef, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn.js";
import { FOCUS } from "./control.js";

interface SegmentedControlProps<T extends string> {
  /** The group's accessible name, e.g. "Task view". */
  label: string;
  /** `data`: the segment's data attributes (a test or a link finds a segment by them). */
  options: readonly { id: T; label: string; data?: Readonly<Record<`data-${string}`, string>> }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}

/**
 * One choice of a few views (design-system/components.md, SegmentedControl), drawn like a macOS segmented control: one
 * 32px `surface-2` track with 2px of padding, holding
 * equal-width 28px segments in one row that never wraps. The selected segment sits on a raised thumb (`surface`,
 * `shadow-sm`, a 1px `border` ring; in dark `border-strong` with no ring, lighter than the track as in macOS dark mode) that slides to it (150ms, motion-safe); its text is `text-1`
 * medium, the others `text-2`, hover `text-1`. Neutral, never accent.
 *
 * A `radiogroup` of `radio` buttons with `aria-checked`. Roving tabindex: only the selected segment is in the tab order;
 * ArrowRight/ArrowDown and ArrowLeft/ArrowUp move to the next and previous segment (wrapping), Home and End to the first
 * and last, and the segment a key moves to is focused and selected at once.
 */
export function SegmentedControl<T extends string>({ label, options, value, onChange, className }: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = options.findIndex((o) => o.id === value);
  const move = (to: number) => {
    const n = options.length;
    const i = ((to % n) + n) % n;
    refs.current[i]?.focus();
    onChange(options[i]!.id);
  };
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    move(to);
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "relative inline-grid max-w-full shrink-0 auto-cols-fr grid-flow-col rounded-control bg-surface-2 p-0.5",
        className,
      )}
    >
      {index >= 0 && (
        <span
          aria-hidden
          data-thumb
          // One segment wide, moved by whole segments: the track's inner width (100% less its 2px padding each side) over the count.
          style={{ width: `calc((100% - 0.25rem) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
          className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-[calc(var(--radius-control)-2px)] bg-surface shadow-sm ring-1 ring-border motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out dark:bg-border-strong dark:ring-0"
        />
      )}
      {options.map((o, i) => {
        const checked = i === index;
        return (
          <button
            key={o.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            // Roving tabindex; with no segment selected the first one takes the tab stop.
            tabIndex={checked || (index < 0 && i === 0) ? 0 : -1}
            {...o.data}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "relative z-10 inline-flex min-h-7 items-center justify-center rounded-[calc(var(--radius-control)-2px)] px-3 text-sm font-medium whitespace-nowrap motion-safe:transition-colors",
              checked ? "text-text-1" : "text-text-2 hover:text-text-1",
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
