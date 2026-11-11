import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn.js";

// shadcn/ui's Switch as a plain file (design §9): a button with role=switch and aria-checked, no Radix and no
// new dependency. The thumb moves with a class, never an inline style (the app's CSP has no unsafe-inline).

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role"> {
  checked: boolean;
  onCheckedChange(next: boolean): void;
}

export function Switch({ checked, onCheckedChange, className, disabled, ...props }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex h-5 w-9 shrink-0 items-center rounded-pill border border-transparent motion-safe:transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50",
        checked ? "bg-text-1" : "bg-border-strong",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          "block size-4 rounded-pill bg-surface shadow motion-safe:transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}
