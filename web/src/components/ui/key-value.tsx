import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

// A label → value list (dl) and a scrollable code block. Colours come from the text and surface tokens.

export type KeyValueItem = {
  key: string;
  term: ReactNode;
  value: ReactNode;
  /** The term is a code identifier (a settings key): shown in monospace. */
  code?: boolean;
  /** Extra attributes for the dd, such as `data-old-value`. */
  valueProps?: Record<`data-${string}`, boolean | string>;
};

/** A dl of dt/dd pairs in two columns (`stacked`: term above value). Values are plain text unless the caller makes them code. */
export function KeyValue({ items, stacked = false, className, ...rest }: { items: KeyValueItem[]; stacked?: boolean; className?: string } & Record<`data-${string}`, boolean | string>) {
  return (
    <dl {...rest} className={cn("text-xs", stacked ? "flex flex-col gap-1" : "grid grid-cols-[auto_minmax(10ch,1fr)] gap-x-3 gap-y-1", className)}>
      {items.map((item, i) => (
        <KeyValueRow key={item.key} item={item} first={i === 0} stacked={stacked} />
      ))}
    </dl>
  );
}

function KeyValueRow({ item, first, stacked }: { item: KeyValueItem; first: boolean; stacked: boolean }) {
  return (
    <>
      <dt className={cn("text-text-2", item.code && "font-mono", stacked && !first && "mt-2")}>{item.term}</dt>
      <dd {...item.valueProps} className="min-w-0 wrap-anywhere">
        {item.value}
      </dd>
    </>
  );
}

/** A code value (pretty JSON, a command): monospace, wraps, scrolls past a fixed height. */
export function ValueBlock({ children }: { children: ReactNode }) {
  return <pre className="max-h-48 overflow-auto rounded-control bg-surface-2 p-2 font-mono text-xs break-all whitespace-pre-wrap">{children}</pre>;
}
