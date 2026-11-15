import { type ReactNode, useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";
import { Tooltip } from "./menu.js";

// Raw IDs (design 09-dashboard-app, readable names): a page shows a name ("worker 3", "you", the item's title) and
// keeps the full ID one step away, in a tooltip on its name or a copy element, never in running text.

const SMALL = "rounded-control border border-border-strong px-1 text-xs font-sans text-text-2 hover:bg-surface-2";

/** Copies `value` to the clipboard; `done` is true for 1.5 s after. With no clipboard it does nothing. */
function useCopy(value: string) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(timer);
  }, [done]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
    } catch {
      // No clipboard (an insecure origin, a test): the text stays selectable.
    }
  };
  return { done, copy: () => void copy() };
}

/** A Copy button: writes `value` to the clipboard and says so for a moment. `what` names it ("Copy item ID"). */
export function CopyButton({ value, what }: { value: string; what: string }) {
  const { done, copy } = useCopy(value);
  return (
    <button type="button" aria-label={t("copy.label", { what })} title={t("copy.label", { what })} className={cn("ml-1 shrink-0", SMALL)} onClick={copy}>
      {done ? t("copy.done") : t("copy.button")}
    </button>
  );
}

/** A copy element: the shown text (`children`, else `value`) and a Copy button that copies `value`. */
export function CopyText({ value, what, children }: { value: string; what: string; children?: ReactNode }) {
  return (
    <span data-copy className="inline-flex max-w-full min-w-0 flex-wrap items-baseline">
      <code className="min-w-0 font-mono text-xs break-words">{children ?? value}</code>
      <CopyButton value={value} what={what} />
    </span>
  );
}

/** A readable name: the full ID shows in a tooltip on hover and focus, and a click copies it ("Copied" in place of the name for a moment). */
export function IdDetails({ label, id }: { label: string; id: string; what: string }) {
  const { done, copy } = useCopy(id);
  return (
    <Tooltip text={id}>
      <button type="button" data-id className="cursor-pointer text-left font-sans text-sm" onClick={copy}>
        {done ? t("copy.done") : label}
      </button>
    </Tooltip>
  );
}
