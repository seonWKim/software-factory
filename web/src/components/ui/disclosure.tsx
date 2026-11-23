import { ChevronRight } from "lucide-react";
import { useState, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { FOCUS } from "./control.js";

interface DisclosureProps extends Omit<HTMLAttributes<HTMLDetailsElement>, "children" | "onToggle"> {
  /** The label that stays visible; a string or inline nodes. */
  summary: ReactNode;
  children: ReactNode;
  /** Whether it starts open. It is only the start: the reader's clicks decide after that. */
  defaultOpen?: boolean;
  /** Mount `children` only while open, for a body that reads something on demand. */
  lazy?: boolean;
  /** Called with the new state each time the reader opens or closes it. */
  onToggle?: (open: boolean) => void;
  /** The summary's text colour; default `text-text-2`. A panel on a pill fill passes its own `text-pill-*-fg`. */
  summaryTone?: string | undefined;
}

/**
 * The one disclosure chevron (design-system/components.md, Disclosure): lucide's ChevronRight at 14px, `text-3` at rest
 * and `text-2` when its trigger is hovered (a `group` on the trigger), turned down when `open` with a 150ms ease-out
 * rotate. The Disclosure summary and the Work tree's expand button both draw it, so every show/hide control has one mark.
 */
export function DisclosureChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRight
      aria-hidden
      data-chevron
      strokeWidth={2.25}
      className={cn(
        "size-3.5 shrink-0 text-text-3 group-hover:text-text-2 motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out",
        open && "rotate-90",
        className,
      )}
    />
  );
}

/**
 * The one show/hide section (docs/design/09-dashboard-components.md, design-system/components.md): a native `<details>` with a
 * `<summary>` at least 28px tall (`min-h-7`) that has one chevron marker (`DisclosureChevron`, turned down when open)
 * and one label style (`text-xs` medium, `text-text-2` unless `summaryTone` sets another). The summary is a quiet
 * hover target: a `rounded-control` box pulled 6px left (`-ml-1.5 px-1.5`) so the chevron lines up with the text
 * above it, `surface-2` and `text-1` on hover. An open body starts 4px below the summary and ends 4px above whatever
 * follows. Use it only
 * for long content (decision rule 2 in design-system/patterns.md). The open state is kept in React so `aria-expanded`
 * on the summary and the `open` attribute always agree; Enter and Space toggle it from the keyboard. Extra props
 * (`data-*`, `className` for a margin) go to the `<details>`.
 */
export function Disclosure({ summary, children, defaultOpen = false, lazy = false, onToggle, summaryTone = "text-text-2", className, ...rest }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = () => {
    setOpen(!open);
    onToggle?.(!open);
  };
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    toggle();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    toggle();
  };
  // Space clicks a summary on key-up in some browsers; the key-down already toggled it.
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === " ") e.preventDefault();
  };
  return (
    <details {...rest} open={open} className={cn("min-w-0", className)}>
      <summary
        aria-expanded={open}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        className={cn(
          "group -ml-1.5 flex min-h-7 w-fit cursor-pointer list-none items-center gap-1.5 rounded-control px-1.5 text-xs font-medium text-pretty select-none [&::-webkit-details-marker]:hidden",
          "motion-safe:transition-colors hover:bg-surface-2 hover:text-text-1",
          FOCUS,
          summaryTone,
        )}
      >
        <DisclosureChevron open={open} />
        <span className="min-w-0">{summary}</span>
      </summary>
      {(open || !lazy) && <div className="min-w-0 pt-1 pb-1">{children}</div>}
    </details>
  );
}
