import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn.js";

// shadcn/ui's Button as a plain file (design §9: components are copied, not a dependency), trimmed to the
// variants the shell uses and without class-variance-authority.
const VARIANTS = {
  ghost: "hover:bg-zinc-100 dark:hover:bg-zinc-800",
  outline: "border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800",
  /** The view's one primary action: filled, from the same zinc scale. */
  primary: "border border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
}

export function Button({ className, variant = "ghost", type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-md text-sm font-medium motion-safe:transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
