import { type FormEvent, type ReactNode, type RefObject, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";
import { Button } from "./button.js";

// A native <dialog> opened with showModal (design §9: no UI library). Mount it to open it, unmount it to close it.
// It renders into document.body, so a table row that opens one keeps its own children. Esc and a click on the
// backdrop (the dialog element itself; the content sits in an inner box) cancel without confirming; Enter in a
// single-line field submits the form, which is the confirm button. Focus moves into the dialog when it opens and
// goes back to `returnFocusTo` (else the element focused when it opened) when it closes. Colours are token classes, and the failed
// colour variable for a destructive confirm.

const BUTTON = "h-8 w-auto px-2";
/** The destructive confirm: the theme's failed (red) colour variable. */
const DANGER = "border-transparent bg-(--color-red-700) text-(--color-white) hover:bg-(--color-red-800)";

export interface DialogProps {
  /** The title: the action and the item it acts on. */
  title: string;
  /** What confirming does, one line. */
  consequence?: ReactNode;
  confirmLabel: string;
  confirmDisabled?: boolean;
  /** The confirm uses the failed colour (reject). */
  danger?: boolean;
  /** Shown in the dialog when the send failed, so the dialog stays open and says why. */
  error?: string | null | undefined;
  onConfirm: () => void;
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  children?: ReactNode;
}

export function Dialog({ title, consequence, confirmLabel, confirmDisabled = false, danger = false, error, onConfirm, onClose, returnFocusTo, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const opener = useRef<Element | null>(document.activeElement);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const back = returnFocusTo?.current ?? opener.current;
    if (!el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    }
    el.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])")?.focus();
    return () => {
      if (el.open && typeof el.close === "function") el.close();
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
    // Opens once per mount; the focus target is read at that time.
  }, []);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!confirmDisabled) onConfirm();
  };

  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-dialog
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
          // Enter in a single-line field confirms once: the browser's own implicit submit is cancelled.
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          close.current();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close.current();
      }}
      className={cn(
        "m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-control p-0",
        "border border-border-strong bg-surface text-text-1",
        "backdrop:bg-text-1/50",
      )}
    >
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <h2 id={titleId} className="text-base font-semibold text-pretty break-words">
          {title}
        </h2>
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
        <div className="flex justify-end gap-2">
          <Button variant="outline" className={BUTTON} onClick={() => close.current()}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="outline" className={cn(BUTTON, danger && DANGER)} disabled={confirmDisabled}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>,
    document.body,
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
