import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";
import { FIELD } from "./control.js";

/**
 * Spread on an Input for a masked field (a secret the page asks for and never shows again): Input's typed variants are
 * text, search, number, date and time only, and it hands `type` to the native field as given. Adding `password` to Input's
 * variants (components.md) is a follow-up.
 */
export const PASSWORD = { type: "password" } as unknown as { type: "text" };

/** A one-line field 32px high with padding-x 12px (design §9). Not for radios: see radio.tsx. */
export function Input({ className, ...props }: Omit<ComponentProps<"input">, "type"> & { type?: "text" | "search" | "number" | "date" | "time" }) {
  return <input {...props} className={cn(FIELD, "h-8 min-w-0 px-3", className)} />;
}
