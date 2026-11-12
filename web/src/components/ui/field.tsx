import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

/** A label (text-sm, font-medium) above its control with a 4px gap, and optional help text (text-xs, text-2) below. */
export function Field({ label, htmlFor, help, className, children }: { label: ReactNode; htmlFor?: string; help?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-pretty break-words">
        {label}
      </label>
      {children}
      {help && <p className="text-xs text-pretty text-text-2">{help}</p>}
    </div>
  );
}
