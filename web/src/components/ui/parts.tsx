import { Children, Fragment, type ReactNode, createContext, useContext, useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";

// Small shared pieces for the pages: a section with a heading, a data table, a level badge and the loading
// and error states. Plain Tailwind; no component library.

export function Section({ title, count, children, action }: { title: string; count?: number | undefined; children: ReactNode; action?: ReactNode }) {
  return (
    <section aria-label={title} className="mt-6 first:mt-0">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-balance text-sm font-semibold">{title}</h2>
        {count !== undefined && <span className="text-sm text-text-3 tabular-nums">{count}</span>}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

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
 * card's title, the next two sit under it, the rest are listed with their column names. Rows are `Tr`, cells `Td`.
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
  const under = cells.slice(0, 2);
  const rest = cells.slice(2);
  return (
    <li {...attrs} className="min-w-0 px-3 py-2 text-sm">
      <div className="min-w-0 font-medium break-words">{title}</div>
      {under.length > 0 && <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">{under}</div>}
      {rest.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {rest.map((cell, i) => (
            <Fragment key={i}>
              <dt className="text-text-2">{head[i + 3] ?? ""}</dt>
              <dd className="min-w-0">{cell}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </li>
  );
}

export function Td({ children, className }: { children: ReactNode; className?: string }) {
  const { cards } = useContext(TableMode);
  // In a card the cell wraps: the table's column widths and no-wrap are dropped.
  if (cards) return <div className={cn("min-w-0 break-words", className?.split(/\s+/).filter((c) => !/^((min-|max-)?w-|whitespace-nowrap$)/.test(c)).join(" "))}>{children}</div>;
  return <td className={cn("px-3 py-2 align-top", className)}>{children}</td>;
}

/** The one status colour map: a level name to its token classes. Badge and StatusBadge both read it. */
export const LEVEL_TONE: Record<string, string> = {
  ready_to_merge: "bg-pill-ok-bg text-pill-ok-fg",
  needs_approval: "bg-pill-warn-bg text-pill-warn-fg",
  needs_you: "bg-pill-bad-bg text-pill-bad-fg",
  needs_triage: "bg-pill-warn-bg text-pill-warn-fg",
  stuck: "bg-pill-bad-bg text-pill-bad-fg",
  running: "bg-pill-info-bg text-pill-info-fg",
  blocked_by_task: "bg-surface-2 text-text-1",
};

/** The token classes for a level; a level with no tone is neutral. */
export function toneOf(level: string | undefined): string {
  return (level && LEVEL_TONE[level]) ?? "bg-surface-2 text-text-1";
}

export function Badge({ level, children }: { level?: string | undefined; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-block rounded-control px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        toneOf(level),
      )}
    >
      {children}
    </span>
  );
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

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-control border border-dashed border-border-strong px-3 py-4 text-sm text-pretty text-text-2">{children}</p>;
}
