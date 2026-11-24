import { type ReactNode, useId } from "react";
import { cn } from "../../lib/cn.js";

/** The label's type: `text-sm` medium. */
const LABEL = "text-sm font-medium text-pretty break-words";
/** The hint's type, under the control: `text-xs` `text-2`. */
const HINT = "text-xs text-pretty text-text-2";

/**
 * A label (text-sm, font-medium) above its control with a 4px gap, and an optional hint (`help`: text-xs, text-2) in
 * the slot below it: a format, a range, what each value means. With `htmlFor` the label is a `<label>` for that one
 * control; without it the Field is a `role=group` named by its label, for a control that has no one id (a Switch with
 * its state word, a list of switches, a file picker). Either way the hint is never placed by hand beside a control.
 */
export function Field({ label, htmlFor, help, className, children }: { label: ReactNode; htmlFor?: string; help?: ReactNode; className?: string; children: ReactNode }) {
  const id = useId();
  const labelId = `${id}-label`;
  const group = htmlFor === undefined;
  return (
    <div role={group ? "group" : undefined} aria-labelledby={group ? labelId : undefined} className={cn("flex min-w-0 flex-col gap-1", className)}>
      {group ? (
        <span id={labelId} className={LABEL}>
          {label}
        </span>
      ) : (
        <label htmlFor={htmlFor} className={LABEL}>
          {label}
        </label>
      )}
      {children}
      {help && <div data-field-hint className={HINT}>{help}</div>}
    </div>
  );
}
