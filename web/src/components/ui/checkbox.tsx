import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { DISABLED, FOCUS } from "./control.js";

interface CheckboxProps extends Omit<ComponentProps<"input">, "type" | "children"> {
  /** The visible label; the checkbox's accessible name. Without it, pass `aria-label`. */
  children?: ReactNode;
}

/**
 * A checkbox (design §9): a 16px box drawn from the tokens (text-2 border on surface; checked, an accent border and an
 * accent check mark) inside a 32px hit area, with the same focus ring as every control. The role and the checked state
 * come from the native input; `aria-checked` mirrors `checked` for the tests and tools that read the attribute. A click
 * and Space toggle it (native), and so does Enter; a disabled one does nothing.
 */
export function Checkbox({ className, children, checked, onKeyDown, ...props }: CheckboxProps) {
  return (
    <label className={cn("inline-flex min-h-8 min-w-8 items-center gap-2 text-sm break-words", children === undefined && "justify-center", className)}>
      <span className="relative inline-grid size-4 shrink-0 place-items-center">
        <input
          type="checkbox"
          checked={checked}
          aria-checked={checked}
          onKeyDown={(e) => {
            onKeyDown?.(e);
            if (e.key !== "Enter" || e.defaultPrevented) return;
            // Enter toggles as Space does; a disabled input ignores the click.
            e.preventDefault();
            e.currentTarget.click();
          }}
          className={cn(
            "peer size-4 appearance-none rounded-control border border-text-2 bg-surface checked:border-accent",
            FOCUS,
            DISABLED,
          )}
          {...props}
        />
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="pointer-events-none absolute size-4 fill-none stroke-accent stroke-2 opacity-0 peer-checked:opacity-100 peer-disabled:opacity-50"
        >
          <path d="M4 8.5l2.5 2.5L12 5.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {children}
    </label>
  );
}
