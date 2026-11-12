import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

/** Buttons side by side with an 8px gap, wrapping at a narrow width; the primary action goes last (macOS order). */
export function ButtonRow({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("flex flex-wrap items-center gap-2", className)} />;
}
