import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";
import { FIELD } from "./control.js";

interface SelectProps extends ComponentProps<"select"> {
  /** Classes of the box around the select and its chevron (its width, its margin). */
  wrapperClassName?: string;
}

/** A select 32px high with padding-x 12px; it draws its own chevron instead of the browser's (design §9). */
export function Select({ className, wrapperClassName, ...props }: SelectProps) {
  return (
    <span className={cn("relative inline-flex", wrapperClassName)}>
      <select {...props} className={cn(FIELD, "h-8 w-full min-w-0 appearance-none pr-8 pl-3", className)} />
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-text-2" />
    </span>
  );
}
