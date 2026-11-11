import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn.js";

// shadcn/ui's Button as a plain file (design §9: components are copied, not a dependency), trimmed to the
// variants the shell uses and without class-variance-authority.
const VARIANTS = {
  ghost: "hover:bg-surface-2",
  outline: "border border-border-strong hover:bg-surface-2",
  /** The view's one primary action: filled with the text colour, so it inverts with the theme. */
  primary: "border border-text-1 bg-text-1 text-bg hover:opacity-85",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
}

export function Button({ className, variant = "ghost", type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-control text-sm font-medium motion-safe:transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
