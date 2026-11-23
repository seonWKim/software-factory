import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { Button } from "./button.js";

// Toast: a short notice that shows at the top right for a few seconds and goes by itself. design-system/components.md "Toast".

/** How long a Toast stays when nobody points at it or focuses inside it. */
export const TOAST_MS = 6000;
/** The fade out before it closes. */
const FADE_MS = 200;

/**
 * A transient notice (a live region, `role="status"`): `children` beside a Dismiss button, at the top right under the
 * top bar (full width less 16px each side below `sm`). It fades in, and after `duration` fades out and calls `onClose`;
 * the timer waits while the pointer is over it or focus is inside it (a Changes list being read), and starts again
 * when they leave. Dismiss closes it at once.
 */
export function Toast({ children, dismissLabel, onClose, duration = TOAST_MS }: { children: ReactNode; dismissLabel: string; onClose: () => void; duration?: number }) {
  const [held, setHeld] = useState({ hover: false, focus: false });
  const [leaving, setLeaving] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;
  const paused = held.hover || held.focus;
  useEffect(() => {
    if (paused || leaving) return;
    const id = setTimeout(() => setLeaving(true), duration);
    return () => clearTimeout(id);
  }, [paused, leaving, duration]);
  useEffect(() => {
    if (!leaving) return;
    const id = setTimeout(() => close.current(), FADE_MS);
    return () => clearTimeout(id);
  }, [leaving]);
  return (
    <div
      role="status"
      data-toast-card
      onMouseEnter={() => setHeld((h) => ({ ...h, hover: true }))}
      onMouseLeave={() => setHeld((h) => ({ ...h, hover: false }))}
      onFocus={() => setHeld((h) => ({ ...h, focus: true }))}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHeld((h) => ({ ...h, focus: false }))}
      className={cn(
        "fixed top-14 right-4 z-40 flex w-88 max-w-[calc(100vw-2rem)] items-start gap-3 rounded-box border border-border bg-surface p-3 text-sm text-text-1 shadow-lg",
        "transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none max-sm:left-4 max-sm:w-auto",
        leaving && "opacity-0",
      )}
    >
      <div className="min-w-0 grow">{children}</div>
      <Button variant="ghost" size="sm" className="shrink-0" onClick={() => onClose()}>{dismissLabel}</Button>
    </div>
  );
}
