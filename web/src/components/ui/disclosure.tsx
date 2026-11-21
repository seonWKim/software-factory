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
}

/**
 * The one show/hide section (docs/design/09-dashboard-components.md, design-system/components.md): a native `<details>` with a
 * `<summary>` that has one chevron marker (turned down when open) and one label style (`text-xs text-text-2`). Use it only
 * for long content (decision rule 2 in design-system/patterns.md). The open state is kept in React so `aria-expanded`
 * on the summary and the `open` attribute always agree; Enter and Space toggle it from the keyboard. Extra props
 * (`data-*`, `className` for a margin) go to the `<details>`.
 */
export function Disclosure({ summary, children, defaultOpen = false, lazy = false, onToggle, className, ...rest }: DisclosureProps) {
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
        className={cn("flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-pretty text-text-2 [&::-webkit-details-marker]:hidden", FOCUS)}
      >
        <ChevronRight aria-hidden className={cn("size-4 shrink-0 motion-safe:transition-transform", open && "rotate-90")} />
        {summary}
      </summary>
      {(open || !lazy) && children}
    </details>
  );
}
