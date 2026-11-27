import { X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";
import { Button } from "./button.js";
import { ButtonRow } from "./button-row.js";
import { CARD_TITLE } from "./card.js";

// A native <dialog> opened with showModal (design §9: no UI library). Mount it to open it, unmount it to close it.
// It renders into document.body, so a table row that opens one keeps its own children. Esc and a click on the
// backdrop (the dialog element itself; the content sits in an inner box) cancel without confirming; Enter in a
// single-line field submits the form, which is the confirm button. Focus moves into the dialog when it opens and
// goes back to `returnFocusTo` (else the element focused when it opened) when it closes. It is built from the
// components/ui set: radius card, padding space-6, a text-base font-semibold title, a body, and a right-aligned ButtonRow footer
// with Cancel (secondary, outline; `cancelLabel` names it Close where each change is saved at once) before the confirm (primary, filled accent; or danger filled with the failed colour).
// The title is one line, truncated, with the full text in its tooltip. The backdrop dims in both themes. When the
// content is taller than the viewport only the body scrolls: the title and the footer stay in view.
// ModalPanel is the same modal without a confirm (the shortcut list, the search): a header with a close icon button
// and a body that scrolls by itself.

export interface DialogProps {
  /** The title: the action and the item it acts on. */
  title: string;
  /** What confirming does, one line. */
  consequence?: ReactNode;
  confirmLabel: string;
  confirmDisabled?: boolean;
  /** The secondary button's label; Cancel by default. */
  cancelLabel?: string;
  /** The confirm uses the failed colour (reject). */
  danger?: boolean;
  /** Shown in the dialog when the send failed, so the dialog stays open and says why. */
  error?: string | null | undefined;
  onConfirm: () => void;
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  children?: ReactNode;
}

/** The native modal the dialogs share: opened on mount, closed on unmount, rendered into `document.body`. */
interface ModalProps {
  labelledBy: string;
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null> | undefined;
  /** Runs before the shared Escape handling; may call `preventDefault` to keep the key for itself. */
  onKeyDown?: ((e: KeyboardEvent<HTMLDialogElement>) => void) | undefined;
  /** Where focus goes on open; the first field, else the first enabled button, by default. */
  focusFirst?: string;
  className: string;
  children: ReactNode;
}

const FIRST_FIELD = "input:not([disabled]), textarea:not([disabled]), select:not([disabled])";

/**
 * The mechanics of every modal: showModal (the page behind is inert, so Tab stays in the dialog), Esc and a click on
 * the backdrop close it, focus goes in on open and back to `returnFocusTo` (else the element focused when it opened)
 * on close, without scrolling the page. A press that starts inside the panel and ends on the backdrop (selecting text)
 * does not close it.
 */
function Modal({ labelledBy, onClose, returnFocusTo, onKeyDown, focusFirst, className, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const close = useRef(onClose);
  close.current = onClose;
  const pressedInside = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const back = returnFocusTo?.current ?? opener.current;
    if (!el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    }
    el.querySelector<HTMLElement>(focusFirst ?? `${FIRST_FIELD}, button:not([disabled])`)?.focus({ preventScroll: true });
    return () => {
      if (el.open && typeof el.close === "function") el.close();
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
    // Opens once per mount; the focus target is read at that time.
  }, []);

  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      data-dialog
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (!e.defaultPrevented && e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close.current();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
      onPointerDown={(e) => {
        pressedInside.current = e.target !== ref.current;
      }}
      onClick={(e) => {
        const inside = pressedInside.current;
        pressedInside.current = false;
        if (e.target === ref.current && !inside) close.current();
      }}
      className={cn(
        "w-[calc(100%-2rem)] p-0",
        "border border-border-strong bg-surface text-text-1",
        "backdrop:bg-text-1/60 dark:backdrop:bg-bg/80",
        className,
      )}
    >
      {children}
    </dialog>,
    document.body,
  );
}

export function Dialog({ title, consequence, confirmLabel, confirmDisabled = false, cancelLabel = t("common.cancel"), danger = false, error, onConfirm, onClose, returnFocusTo, children }: DialogProps) {
  const titleId = useId();
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!confirmDisabled) onConfirm();
  };

  return (
    <Modal
      labelledBy={titleId}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
          // Enter in a single-line field confirms once: the browser's own implicit submit is cancelled.
          e.preventDefault();
          submit();
        }
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] max-w-xl flex-col overflow-hidden rounded-card open:flex"
    >
      {/* The title and the footer stay put; only the body between them scrolls, so Cancel and the confirm are always in view.
          The form and the body keep their content height and only shrink (min-h-0) to the dialog's max height: none of
          them grows from a zero basis (flex-1), which WebKit sizes as zero, collapsing the dialog to its border. */}
      <form onSubmit={submit} className="flex min-h-0 flex-col">
        <h2 id={titleId} title={title} className={cn(CARD_TITLE, "shrink-0 truncate px-6 pt-6")}>
          {title}
        </h2>
        <div data-dialog-body className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-6 py-3">
          {children}
          {consequence && (
            <p data-dialog-consequence className="text-sm text-pretty break-words">
              {consequence}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-pretty break-words text-pill-bad-fg">
              {error}
            </p>
          )}
        </div>
        <ButtonRow data-dialog-footer className="shrink-0 justify-end px-6 pb-6">
          <Button variant="secondary" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} solid={danger} disabled={confirmDisabled}>
            {confirmLabel}
          </Button>
        </ButtonRow>
      </form>
    </Modal>
  );
}

export interface ModalPanelProps {
  /** The panel's name: its visible title, or only its accessible name when `header` replaces the title. */
  title: string;
  /** Shown in the header in place of the title (the search field); the title stays as the hidden heading. */
  header?: ReactNode;
  /** `md` (32rem, a search) or `lg` (42rem, a reference list). */
  size?: "md" | "lg";
  /** `center` (default) or `top`: held near the top, so a list that filters as you type does not move the panel. */
  placement?: "center" | "top";
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  /** Keys the panel's content handles before Esc closes it (a list's arrows). */
  onKeyDown?: (e: KeyboardEvent<HTMLDialogElement>) => void;
  children: ReactNode;
  /** A line pinned under the scrolling body (a link out): it stays in view however long the body is. */
  footer?: ReactNode;
}

const PANEL_SIZE = { md: "max-w-lg", lg: "max-w-2xl" } as const;

/**
 * A modal panel with no confirm: a reference list or a search. The header holds the title (or `header`) and a close
 * icon Button at its right; the body scrolls by itself. Same mechanics as Dialog: Esc, a click outside and the close
 * button close it; focus goes to its first field, else to the body, and back to the opener on close.
 */
export function ModalPanel({ title, header, size = "lg", placement = "center", onClose, returnFocusTo, onKeyDown, children, footer }: ModalPanelProps) {
  const titleId = useId();
  return (
    <Modal
      labelledBy={titleId}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      onKeyDown={onKeyDown}
      focusFirst={`${FIRST_FIELD}, [data-panel-body]`}
      className={cn(
        "flex-col overflow-hidden rounded-card shadow-lg open:flex",
        PANEL_SIZE[size],
        placement === "top" ? "mx-auto mt-[10dvh] max-h-[80dvh]" : "m-auto max-h-[calc(100dvh-2rem)]",
      )}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-border py-3 pr-3 pl-5">
        <h2 id={titleId} className={cn(CARD_TITLE, "min-w-0 flex-1 truncate", header !== undefined && "sr-only")}>
          {title}
        </h2>
        {header !== undefined && <div className="min-w-0 flex-1">{header}</div>}
        <Button variant="ghost" size="icon" aria-label={t("common.close")} onClick={onClose} className="text-text-2">
          <X aria-hidden className="size-4" />
        </Button>
      </header>
      <div data-panel-body tabIndex={-1} className="min-h-0 overflow-y-auto overscroll-contain px-5 py-4 text-sm outline-none">
        {children}
      </div>
      {footer !== undefined && <footer data-panel-footer className="shrink-0 border-t border-border px-5 py-3 text-sm">{footer}</footer>}
    </Modal>
  );
}

/** How long a send confirmation stays on screen. */
export const STATUS_MS = 4000;
const STATUS_CLASS =
  "fixed bottom-4 left-1/2 z-50 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-text-1";
let statusRegion: HTMLElement | null = null;
let statusTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Shows `text` in one short status line (a live region, `role="status"`) on `document.body`, outside every React
 * tree, for STATUS_MS. It outlives the component that sent the command: a Needs-you row leaves the list as soon as
 * its command moves the item on, and its confirmation must still show. A newer message replaces the shown one.
 */
export function announceStatus(text: string): void {
  if (!statusRegion?.isConnected) {
    statusRegion = document.createElement("div");
    statusRegion.setAttribute("role", "status");
    statusRegion.dataset.toast = "";
    statusRegion.className = STATUS_CLASS;
    document.body.append(statusRegion);
  }
  statusRegion.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusRegion?.remove();
    statusRegion = null;
  }, STATUS_MS);
}
