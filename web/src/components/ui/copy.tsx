import { type ReactNode, useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";

// Raw IDs (design 09-dashboard-app, readable names): a page shows a name ("worker 3", "you", the item's title) and
// keeps the full ID one step away, in a details element or a copy element, never in running text.

const SMALL = "rounded-control border border-border-strong px-1 text-xs font-sans text-text-2 hover:bg-surface-2";

/** A Copy button: writes `value` to the clipboard and says so for a moment. `what` names it ("Copy item ID"). */
export function CopyButton({ value, what }: { value: string; what: string }) {
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
  return (
    <button type="button" aria-label={t("copy.label", { what })} title={t("copy.label", { what })} className={cn("ml-1 shrink-0", SMALL)} onClick={() => void copy()}>
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

/** A readable name that opens to the full ID and a Copy button. The ID is the element's own text, so it reads as one. */
export function IdDetails({ label, id, what }: { label: string; id: string; what: string }) {
  return (
    <details data-id className="inline-block max-w-full align-baseline font-mono text-xs break-words">
      <summary className="cursor-pointer font-sans text-sm">{label}</summary>
      {id}
      <CopyButton value={id} what={what} />
    </details>
  );
}
