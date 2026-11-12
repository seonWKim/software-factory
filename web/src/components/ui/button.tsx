import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";
import { DISABLED, FOCUS } from "./control.js";

// The dashboard's one button (docs/design/09-brand-and-tokens.md): shadcn/ui's Button as a plain file, without
// class-variance-authority. Every class is a token class. Hover is only for an enabled button, so a disabled one
// keeps its border and text colours under its opacity. A pressed toggle (aria-pressed, or aria-checked in a radio
// group) shows the surface-2 background.
const VARIANTS = {
  /** The one main action of a view: accent background, on-solid text. */
  primary: "bg-accent text-on-solid enabled:hover:opacity-90",
  secondary: "border border-border-strong bg-surface text-text-1 enabled:hover:bg-surface-2 aria-pressed:border-text-1",
  ghost: "enabled:hover:bg-surface-2",
  /** Failed-colour text; filled with the failed colour only as a confirm dialog's destructive confirm (`solid`). */
  danger: "text-failed enabled:hover:bg-surface-2",
} as const;

/** md and sm set the least height, so a long label wraps at a narrow width instead of spilling out. */
const SIZES = {
  md: "min-h-8 px-3 text-sm",
  sm: "min-h-7 px-2 text-xs",
  icon: "size-8 shrink-0 justify-center",
} as const;

const SOLID_DANGER = "bg-failed text-on-solid enabled:hover:opacity-90";

type ButtonVariant = keyof typeof VARIANTS;
type ButtonSize = keyof typeof SIZES;

interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** The danger variant filled with the failed colour: only for a confirm dialog's destructive confirm. */
  solid?: boolean;
}

export function Button({ className, variant = "secondary", size = "md", solid = false, type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-control font-medium motion-safe:transition-colors",
        "aria-pressed:bg-surface-2 aria-checked:bg-surface-2",
        FOCUS,
        DISABLED,
        variant === "danger" && solid ? SOLID_DANGER : VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
