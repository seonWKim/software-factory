import { Children, cloneElement, isValidElement, useId, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn.js";

// Form controls as plain native elements styled from the tokens: Input, Textarea, Select, Radio, the Field that
// labels them and the ButtonRow that holds a form's buttons. Sizes and states are listed in design-system/components.md.

export type ControlSize = "sm" | "md";

const CONTROL =
  "w-full rounded-control border bg-surface text-text-1 placeholder:text-text-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50";
const SIZES: Record<ControlSize, string> = { sm: "px-2 py-1 text-xs", md: "px-3 py-1.5 text-sm" };

function controlClass(size: ControlSize, invalid: boolean | undefined, className: string | undefined): string {
  return cn(CONTROL, SIZES[size], invalid ? "border-pill-bad-fg" : "border-border-strong", className);
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: ControlSize;
  invalid?: boolean;
}

export function Input({ size = "md", invalid, className, ...props }: InputProps) {
  return <input aria-invalid={invalid || undefined} className={controlClass(size, invalid, className)} {...props} />;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea({ invalid, className, rows = 4, ...props }: TextareaProps) {
  return <textarea rows={rows} aria-invalid={invalid || undefined} className={controlClass("md", invalid, className)} {...props} />;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: ControlSize;
  invalid?: boolean;
}

/** A native select: the browser draws the list, so it works with a keyboard and on a phone. Options are children. */
export function Select({ size = "md", invalid, className, children, ...props }: SelectProps) {
  return (
    <select aria-invalid={invalid || undefined} className={controlClass(size, invalid, className)} {...props}>
      {children}
    </select>
  );
}

/** One radio with its label; give the radios of a group the same `name`. */
export function Radio({ children, className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { children: ReactNode }) {
  return (
    <label className={cn("inline-flex items-center gap-2 text-sm has-[:disabled]:opacity-50", className)}>
      <input type="radio" className="size-4 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" {...props} />
      {children}
    </label>
  );
}

/**
 * A label, the control, a hint and an error. The one child (an Input, Textarea or Select) gets the id, the
 * `aria-describedby` for the hint and error, and `aria-invalid` while there is an error.
 */
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: ReactNode; children: ReactElement<Record<string, unknown>> }) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  const child = Children.only(children);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {isValidElement(child) && cloneElement(child, { id, "aria-describedby": describedBy, ...(error ? { invalid: true } : {}) })}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-text-2">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-pill-bad-fg">
          {error}
        </p>
      )}
    </div>
  );
}

/** A form's buttons in a row that wraps; `align` puts them at the end (default) or the start. */
export function ButtonRow({ align = "end", children }: { align?: "start" | "end"; children: ReactNode }) {
  return <div className={cn("flex flex-wrap items-center gap-2", align === "end" ? "justify-end" : "justify-start")}>{children}</div>;
}
