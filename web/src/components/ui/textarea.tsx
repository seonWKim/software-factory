import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";
import { FIELD } from "./control.js";

/** A text area with padding-x 12px and padding-y 8px (design §9). */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={cn(FIELD, "min-w-0 px-3 py-2", className)} />;
}
