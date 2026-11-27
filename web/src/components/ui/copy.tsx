import { Copy } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";
import { Button } from "./button.js";
import { Tooltip } from "./menu.js";

// Raw IDs (design 09-dashboard-app, readable names): a page shows a name ("worker 3", "you", the item's title) and
// keeps the full ID one step away, in a tooltip on its name or a copy element, never in running text.

/** 28px tall, as every button on a page (scripts/responsive/rules.mjs `button-height`). */
const SMALL = "inline-flex min-h-7 items-center rounded-control border border-border-strong px-2 text-xs font-sans text-text-2 hover:bg-surface-2";

/** Writes `value` to the clipboard; false with no clipboard (an insecure origin, a test), where the text stays selectable. */
export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** Copies `value` to the clipboard; `done` is true for 1.5 s after. With no clipboard it does nothing. */
function useCopy(value: string) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(timer);
  }, [done]);
  const copy = async () => {
    if (await copyToClipboard(value)) setDone(true);
  };
  return { done, copy: () => void copy() };
}

/** A Copy button: writes `value` to the clipboard and says so for a moment. `what` names it ("Copy item ID"). */
export function CopyButton({ value, what }: { value: string; what: string }) {
  const { done, copy } = useCopy(value);
  return (
    <button type="button" aria-label={t("copy.label", { what })} title={t("copy.label", { what })} className={cn("ml-1 inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center", SMALL)} onClick={copy}>
      {done ? t("copy.done") : t("copy.button")}
    </button>
  );
}

/**
 * A ghost icon Button that copies `value` (a reply, your message, a code block); `what` names it ("Copy reply"). "Copied"
 * shows beside it for 1.5 s in a polite live region that is always in the page, so a screen reader hears it. With no clipboard nothing shows.
 */
export function CopyIcon({ value, what }: { value: string; what: string }) {
  const { done, copy } = useCopy(value);
  return (
    <span className="inline-flex items-center gap-1">
      <Button type="button" variant="ghost" size="icon" aria-label={t("copy.label", { what })} title={t("copy.label", { what })} onClick={copy}>
        <Copy aria-hidden className="size-4" />
      </Button>
      <span aria-live="polite" className="text-xs text-text-2">{done ? t("copy.done") : ""}</span>
    </span>
  );
}

/** A copy element: the shown text (`children`, else `value`) and a Copy button that copies `value`. */
export function CopyText({ value, what, children }: { value: string; what: string; children?: ReactNode }) {
  return (
    <span data-copy className="inline-flex max-w-full min-w-0 flex-wrap items-center">
      <code className="min-w-0 font-mono text-xs break-words">{children ?? value}</code>
      <CopyButton value={value} what={what} />
    </span>
  );
}

/** A readable name: the full ID shows in a tooltip on hover and focus, and a click copies it ("Copied" in place of the name for a moment). `nowrap` keeps a short name (a worker, a person) on one line, so a narrow table cell does not make its button taller than 28px. */
export function IdDetails({ label, id, nowrap }: { label: string; id: string; what: string; nowrap?: boolean }) {
  const { done, copy } = useCopy(id);
  return (
    <Tooltip text={id}>
      <button type="button" data-id className={cn("inline-flex min-h-7 min-w-6 cursor-pointer items-center text-left font-sans", nowrap && "whitespace-nowrap")} onClick={copy}>
        {done ? t("copy.done") : label}
      </button>
    </Tooltip>
  );
}
