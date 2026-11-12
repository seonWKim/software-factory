import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { DISABLED, FOCUS } from "./control.js";

interface RadioProps extends Omit<ComponentProps<"input">, "type" | "children"> {
  /** The visible label; the radio's accessible name. */
  children: ReactNode;
}

/**
 * A radio with its label (design §9): a 16px circle drawn from the tokens (text-2 ring on surface; checked, an accent
 * ring around a surface dot), with the same focus ring as every control.
 */
export function Radio({ className, children, ...props }: RadioProps) {
  return (
    <label className={cn("flex items-center gap-2 text-sm break-words", className)}>
      <input
        type="radio"
        className={cn(
          "size-4 shrink-0 appearance-none rounded-pill border border-text-2 bg-surface checked:border-[5px] checked:border-accent",
          FOCUS,
          DISABLED,
        )}
        {...props}
      />
      {children}
    </label>
  );
}
