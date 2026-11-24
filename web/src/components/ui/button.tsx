import { type ComponentProps, createContext, useContext } from "react";
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
  /**
   * Secondary's box (1px border-strong) with failed-colour text, so Reject sits beside Accept as a button, not a link;
   * filled with the failed colour only as a confirm dialog's destructive confirm (`solid`).
   */
  danger: "border border-border-strong bg-surface text-failed enabled:hover:bg-surface-2",
} as const;

/** md and sm set the least height, so a long label wraps at a narrow width instead of spilling out. */
const SIZES = {
  md: "min-h-8 px-3 text-sm",
  sm: "min-h-7 px-2 text-xs",
  icon: "size-8 shrink-0 justify-center",
} as const;

/**
 * `flush`: a negative start margin equal to the size's inline padding, so the label starts on the text edge of the block
 * above it: a ghost Button that opens a block ("Show 25 earlier messages", "Show result", Clamp's "Show more"). The
 * hover fill still reaches out around the label. An `icon` Button has no label edge, so it is never flush.
 */
const FLUSH = { md: "-ms-3", sm: "-ms-2", icon: "" } as const;

const SOLID_DANGER = "bg-failed text-on-solid enabled:hover:opacity-90";

type ButtonVariant = keyof typeof VARIANTS;
type ButtonSize = keyof typeof SIZES;

interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** The danger variant filled with the failed colour: only for a confirm dialog's destructive confirm. */
  solid?: boolean;
  /** Pull the button left by its padding, so its label lines up with the text above it (FLUSH). */
  flush?: boolean;
}

/**
 * The Button's classes, for a control that must be another library's button (react-aria's Tree chevron slot) yet look
 * like ours. Every other caller renders `Button`.
 */
export function buttonClass({ variant = "secondary", size = "md", solid = false, flush = false, className }: { variant?: ButtonVariant; size?: ButtonSize; solid?: boolean; flush?: boolean; className?: string | undefined } = {}): string {
  return cn(
    "inline-flex items-center gap-1.5 rounded-control font-medium motion-safe:transition-colors",
    "aria-pressed:bg-surface-2 aria-checked:bg-surface-2",
    FOCUS,
    DISABLED,
    variant === "danger" && solid ? SOLID_DANGER : VARIANTS[variant],
    SIZES[size],
    flush && FLUSH[size],
    className,
  );
}

/**
 * True inside a PageToolbar's row (notice.tsx): there every control shares the one toolbar height (CONTROL_HEIGHT.md,
 * the search Input's and the SegmentedControl's 32px), so a `sm` Button is drawn `md`.
 */
export const InToolbar = createContext(false);

export function Button({ className, variant = "secondary", size = "md", solid = false, flush = false, type = "button", ...props }: ButtonProps) {
  const toolbar = useContext(InToolbar);
  return <button type={type} className={buttonClass({ variant, size: toolbar && size === "sm" ? "md" : size, solid, flush, className })} {...props} />;
}
