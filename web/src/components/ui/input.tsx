import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";
import { FIELD } from "./control.js";

/** A one-line field 32px high with padding-x 12px (design §9). Not for radios: see radio.tsx. */
export function Input({ className, ...props }: Omit<ComponentProps<"input">, "type"> & { type?: "text" | "search" | "number" }) {
  return <input {...props} className={cn(FIELD, "h-8 min-w-0 px-3", className)} />;
}
