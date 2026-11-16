import { Check, ChevronDown } from "lucide-react";
import { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { DISABLED, FIELD, FOCUS } from "./control.js";

// Select draws its own list (design §9): the browser's popup covered the field and the label above the next one.
// Plain React, no positioning library: the list sits by CSS below the field, or above it when a measured check finds
// no room below in the viewport.

/** What onChange gets: the picked value at `target.value`, as a native select's change event has it. */
export interface SelectChangeEvent {
  target: { value: string };
}

interface SelectProps {
  id?: string | undefined;
  "aria-label"?: string | undefined;
  value?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  /** Classes of the box around the field and its chevron (its width, its margin). */
  wrapperClassName?: string | undefined;
  onChange?(e: SelectChangeEvent): void;
  /** `<option>` elements: `value` (else its text), its text, `disabled`. */
  children?: ReactNode;
}

interface Choice {
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
}

interface OptionProps {
  value?: string | number;
  disabled?: boolean;
  children?: ReactNode;
}

/** The text of a node, for type-to-find and an option without a `value`. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? textOf(node.props.children) : "";
}

/** The `<option>` children, also inside fragments, as choices. */
function choicesOf(children: ReactNode): Choice[] {
  return Children.toArray(children).flatMap((c): Choice[] => {
    if (!isValidElement<OptionProps>(c)) return [];
    if (c.type === Fragment) return choicesOf(c.props.children);
    if (c.type !== "option") return [];
    const text = textOf(c.props.children);
    return [{ value: c.props.value === undefined ? text : String(c.props.value), label: c.props.children, text, disabled: c.props.disabled === true }];
  });
}

/** Typed letters within this many ms of the last one extend the search; a later one starts a new one. */
const TYPE_AHEAD_MS = 500;
/** The gap between the field and its list (mt-1 / mb-1). */
const GAP_PX = 4;

/**
 * A field 32px high with padding-x 12px and its own chevron that opens a list of its `<option>` children below it
 * (above it near the bottom of the viewport). Keys: Enter, Space or an arrow opens; arrows move the highlight; Enter
 * picks; Esc closes; letters move the highlight to the first option starting with them. A click outside closes it.
 */
export function Select({ id, "aria-label": ariaLabel, value, disabled, className, wrapperClassName, onChange, children }: SelectProps) {
  const choices = choicesOf(children);
  const [own, setOwn] = useState<string>();
  const current = value ?? own ?? choices[0]?.value ?? "";
  const selected = Math.max(0, choices.findIndex((c) => c.value === current));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [up, setUp] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // The letters typed so far for type-to-find, and when the last one came.
  const typed = useRef({ text: "", at: -Infinity });
  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;

  useLayoutEffect(() => {
    if (!open || !trigger.current || !list.current) return;
    const field = trigger.current.getBoundingClientRect();
    const below = innerHeight - field.bottom;
    setUp(below < list.current.getBoundingClientRect().height + GAP_PX && field.top > below);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector(`[id="${optionId(active)}"]`)?.scrollIntoView?.({ block: "nearest" });
  });

  const enabled = (i: number) => choices[i] !== undefined && !choices[i].disabled;
  const show = (at = enabled(selected) ? selected : choices.findIndex((c) => !c.disabled)) => {
    setActive(Math.max(0, at));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const pick = (i: number) => {
    const choice = choices[i];
    if (!choice || choice.disabled) return;
    close();
    if (choice.value === current) return;
    setOwn(choice.value);
    onChange?.({ target: { value: choice.value } });
  };
  const step = (by: 1 | -1) => {
    for (let i = active + by; i >= 0 && i < choices.length; i += by) if (enabled(i)) return setActive(i);
  };
  const typing = (e: KeyboardEvent) => e.timeStamp - typed.current.at < TYPE_AHEAD_MS;
  const find = (e: KeyboardEvent) => {
    const t = typed.current;
    t.text = (typing(e) ? t.text : "") + e.key.toLowerCase();
    t.at = e.timeStamp;
    const i = choices.findIndex((c) => !c.disabled && c.text.toLowerCase().startsWith(t.text));
    if (i < 0) return;
    if (open) setActive(i);
    else show(i);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === "Escape") {
      if (!open) return;
      // Keep the Esc from closing a dialog the Select sits in.
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (open) step(e.key === "ArrowDown" ? 1 : -1);
      else show();
    } else if (e.key === "Enter" || (e.key === " " && !typing(e))) {
      e.preventDefault();
      if (open) pick(active);
      else show();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      find(e);
    }
  };

  const chosen = choices[selected];
  return (
    <span className={cn("relative inline-flex", wrapperClassName)}>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        id={id}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(active) : undefined}
        value={current}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKeyDown}
        // Space activates a button on key up; the key down has already opened or picked.
        onKeyUp={(e) => e.key === " " && e.preventDefault()}
        onBlur={() => setOpen(false)}
        className={cn(FIELD, "h-8 w-full min-w-0 pr-8 pl-3 text-left", className)}
      >
        <span className={cn("block truncate", chosen?.disabled && "text-text-3")}>{chosen?.label}</span>
      </button>
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-text-2" />
      {open && (
        // The field keeps the focus while the pointer is on the list, so a click picks and a click outside closes.
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          onMouseDown={(e) => e.preventDefault()}
          className={cn(
            "absolute left-0 z-10 max-h-60 w-max max-w-80 min-w-full overflow-y-auto rounded-control border border-border bg-surface py-1 shadow",
            up ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {choices.map((c, i) => (
            <li key={`${i}:${c.value}`} role="none">
              <button
                type="button"
                role="option"
                id={optionId(i)}
                value={c.value}
                tabIndex={-1}
                aria-selected={i === selected}
                disabled={c.disabled}
                onClick={() => pick(i)}
                onMouseEnter={() => c.disabled || setActive(i)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm enabled:hover:bg-surface-2",
                  i === active && "bg-surface-2",
                  FOCUS,
                  "focus-visible:-outline-offset-2",
                  DISABLED,
                )}
              >
                <Check aria-hidden className={cn("size-4 shrink-0 text-accent", i !== selected && "invisible")} />
                <span>{c.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
