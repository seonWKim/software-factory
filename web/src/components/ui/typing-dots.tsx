import { cn } from "../../lib/cn.js";

/**
 * Each dot rises and brightens a little after the one before it, so the three read as a wave. The delay is inside the
 * animation shorthand: a separate `animation-delay` class is reset by the shorthand, and all three would move as one.
 */
const DOTS = [
  "motion-safe:animate-[typing_1.2s_ease-in-out_0ms_infinite]",
  "motion-safe:animate-[typing_1.2s_ease-in-out_150ms_infinite]",
  "motion-safe:animate-[typing_1.2s_ease-in-out_300ms_infinite]",
] as const;

/**
 * Three dots that bounce in turn while an answer is on its way (the `typing` keyframes of index.css, 1.2 s a loop),
 * in `text-2`. With reduced motion they stand still (motion-safe only). A live `role=status` that screen readers hear
 * as `label`.
 */
export function TypingDots({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" data-typing className="flex h-6 items-center gap-1.5">
      <span className="sr-only">{label}</span>
      {DOTS.map((motion) => (
        <span key={motion} aria-hidden data-dot className={cn("size-2 rounded-pill bg-text-2", motion)} />
      ))}
    </div>
  );
}
