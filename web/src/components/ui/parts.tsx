import { Children, Fragment, type ReactNode, createContext, isValidElement, useContext, useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";

// Small shared pieces for the pages: a data table and the loading and error states. Plain Tailwind; no component
// library. Blocks are Card (card.tsx), badges Badge (badge.tsx), empty lists EmptyState (notice.tsx).

/** Tailwind's `sm` breakpoint: below it every Table is a list of cards. */
export const SM_PX = 640;

/** True at `sm` and up; follows the window's width as it changes. */
function useWide(): boolean {
  const read = () => typeof window === "undefined" || window.innerWidth >= SM_PX;
  const [wide, setWide] = useState(read);
  useEffect(() => {
    const on = () => setWide(read());
    on();
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  return wide;
}

const TableMode = createContext<{ head: readonly string[]; cards: boolean }>({ head: [], cards: false });

/**
 * A data table at `sm` and up; below it, one card per row with no horizontal scroll: the first cell is the
 * card's title, the second sits under it, the rest are listed with their column names. Rows are `Tr`, cells `Td`.
 * `numeric[i]` right-aligns the i-th column's heading to sit over its numbers.
 */
export function Table({ head, children, label, numeric }: { head: readonly string[]; children: ReactNode; label: string; numeric?: readonly boolean[] }) {
  const wide = useWide();
  if (!wide) {
    return (
      <TableMode.Provider value={{ head, cards: true }}>
        <ul aria-label={label} data-cards className="divide-y divide-border rounded-control border border-border">
          {children}
        </ul>
      </TableMode.Provider>
    );
  }
  return (
    <div className="overflow-x-auto rounded-control border border-border">
      <table aria-label={label} className="w-full text-left text-sm">
        <thead className="bg-bg text-xs text-text-2">
          <tr>
            {head.map((h, i) => (
              <th key={h} scope="col" className={cn("px-3 py-2 font-medium whitespace-nowrap", numeric?.[i] && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

/** One row of a Table: a `<tr>`, or a card below `sm`. Data attributes go on either. */
export function Tr({ children, ...attrs }: { children: ReactNode } & { [data: `data-${string}`]: string | undefined }) {
  const { head, cards } = useContext(TableMode);
  if (!cards) return <tr {...attrs}>{children}</tr>;
  // Cells left out with `cond && <Td>` are dropped here, as they are from `head`.
  const [title, ...cells] = Children.toArray(children);
  const [under, ...rest] = cells;
  return (
    <li {...attrs} className="min-w-0 px-3 py-2 text-sm">
      <div className="min-w-0 font-medium break-words">{title}</div>
      {under !== undefined && <div className="mt-1 min-w-0">{under}</div>}
      {rest.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {rest.map((cell, i) => (
            // A cell with nothing in it (a reset that does not apply) is not listed, so no label stands alone.
            isValidElement<{ children?: ReactNode }>(cell) && (cell.props.children === undefined || typeof cell.props.children === "boolean" || cell.props.children === null) ? null : (
              <Fragment key={i}>
                <dt className="text-text-2">{head[i + 2] ?? ""}</dt>
                <dd className="min-w-0">{cell}</dd>
              </Fragment>
            )
          ))}
        </dl>
      )}
    </li>
  );
}

export function Td({ children, className, ...attrs }: { children?: ReactNode; className?: string } & { [data: `data-${string}`]: string | undefined }) {
  const { cards } = useContext(TableMode);
  // In a card the cell wraps: the table's column widths and no-wrap are dropped.
  if (cards) return <div {...attrs} className={cn("min-w-0 break-words", className?.split(/\s+/).filter((c) => !/^((min-|max-)?w-|whitespace-nowrap$)/.test(c)).join(" "))}>{children}</div>;
  return <td {...attrs} className={cn("px-3 py-2 align-top", className)}>{children}</td>;
}

/** A row-shaped placeholder while the first read is in flight. */
export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label={t("common.loading")} className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-8 rounded-control bg-surface-2" />
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <p role="alert" className="rounded-control bg-pill-bad-bg px-3 py-2 text-sm text-pill-bad-fg">
      {t("common.couldNotLoad", { message: error instanceof Error ? error.message : String(error) })}
    </p>
  );
}
