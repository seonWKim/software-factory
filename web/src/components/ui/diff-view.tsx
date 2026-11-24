import { cn } from "../../lib/cn.js";

/** One line of a unified diff: unchanged, taken out or put in. */
export interface DiffViewLine {
  op: "same" | "removed" | "added";
  text: string;
}

const MARK = { same: " ", removed: "−", added: "+" } as const;
const LINE_CLASS = { same: "text-text-2", removed: "bg-pill-bad-bg text-pill-bad-fg", added: "bg-pill-ok-bg text-pill-ok-fg" } as const;

/**
 * A unified diff in one column (design-system/components.md, DiffView): each line in monospace behind a − (removed) or
 * + (added) mark, a blank mark for an unchanged line, so colour is never the only cue (the mark is text, read as "minus" and "plus"). `label` names it; `empty` is the text for no lines. Removed and added lines carry
 * the bad and ok pill fills; the block scrolls sideways instead of wrapping.
 */
export function DiffView({ lines, label, empty }: { lines: readonly DiffViewLine[]; label: string; empty: string }) {
  return (
    <div role="group" aria-label={label} data-diff-view className="overflow-x-auto rounded-control border border-border font-mono text-xs">
      {lines.length === 0 ? (
        <p className="px-3 py-2 text-text-2">{empty}</p>
      ) : (
        <ol className="min-w-fit">
          {lines.map((l, i) => (
            <li key={i} data-op={l.op} className={cn("flex gap-2 px-3 py-0.5 whitespace-pre", LINE_CLASS[l.op])}>
              <span className="w-3 shrink-0 select-none">{MARK[l.op]}</span>
              <span>{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
