import { Children, Fragment, type ReactNode, createContext, isValidElement, useContext, useEffect, useState } from "react";
import type { MessageKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";
import { Button } from "./button.js";

// Small shared pieces for the pages: a data table and the loading and error states. Plain Tailwind; no component
// library. Blocks are Card (card.tsx), badges Badge (badge.tsx), empty lists EmptyState (notice.tsx).

/** Tailwind's `sm` breakpoint: below it every Table is a list of cards. */
export const SM_PX = 640;

/** True at `sm` and up; follows the window's width as it changes. */
export function useWide(): boolean {
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

/** The selected row (`current`): a `surface-2` fill and a 2px `nav-active` bar at its start, as the sidebar marks the current page. */
// Written out whole so Tailwind finds each class: on a <tr> the bar is drawn by its first cell.
const CURRENT_TR = "bg-surface-2 [&>td:first-child]:shadow-[inset_2px_0_0_var(--color-nav-active)]";
const CURRENT_LI = "bg-surface-2 shadow-[inset_2px_0_0_var(--color-nav-active)]";

/**
 * One row of a Table: a `<tr>`, or a card below `sm`. Data attributes go on either. `current` marks the row the page
 * shows details of (`aria-current="true"`, the selected-row fill and bar); its height does not change.
 */
export function Tr({ children, current = false, ...attrs }: { children: ReactNode; current?: boolean } & { [data: `data-${string}`]: string | undefined }) {
  const { head, cards } = useContext(TableMode);
  const mark = current ? { "aria-current": "true" as const } : {};
  if (!cards) return <tr {...attrs} {...mark} className={current ? CURRENT_TR : undefined}>{children}</tr>;
  // Cells left out with `cond && <Td>` are dropped here, as they are from `head`.
  const [title, ...cells] = Children.toArray(children);
  const [under, ...rest] = cells;
  return (
    <li {...attrs} {...mark} className={cn("min-w-0 px-3 py-2 text-sm", current && CURRENT_LI)}>
      <div className="min-w-0 font-medium wrap-anywhere">{title}</div>
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

/**
 * A card cell (design 09-dashboard-components, 2026-11-24): it may shrink below its content (`min-w-0`), prose wraps
 * anywhere so a long word cannot widen it (`wrap-anywhere`; `break-words` leaves an inline-block link as wide as its
 * longest word), no link is wider than the cell, and an identifier link (`a[data-id]`, its full value in its text and
 * `title`) stays on one line cut with an ellipsis.
 */
export const CARD_CELL = "min-w-0 wrap-anywhere [&_a]:max-w-full [&_a[data-id]]:truncate [&_a[data-id]]:align-bottom";

export function Td({ children, className, ...attrs }: { children?: ReactNode; className?: string } & { [data: `data-${string}`]: string | undefined }) {
  const { cards } = useContext(TableMode);
  // In a card the cell wraps: the table's column widths, no-wrap and break-words (CARD_CELL's wrap-anywhere wins) are dropped.
  if (cards) return <div {...attrs} className={cn(CARD_CELL, className?.split(/\s+/).filter((c) => !/^((min-|max-)?w-|whitespace-nowrap$|break-words$)/.test(c)).join(" "))}>{children}</div>;
  return <td {...attrs} className={cn("px-3 py-2 align-top", className)}>{children}</td>;
}

/** After this long the placeholder shows what it waits for and for how long (design 09-dashboard-shell, 2026-11-19). */
export const LOADING_BARS_MS = 1_000;
/** After this long the placeholder gives up: the error with Retry. */
export const LOADING_TIMEOUT_MS = 30_000;

/**
 * The one placeholder while a read is in flight: row-shaped bars for about 1 s, then "<label>: Still loading… (n s)"
 * under them, then after 30 s the ErrorNote with Retry. Retry calls `onRetry` and starts the steps again. `label` names
 * what it waits for (an i18n key, e.g. "loading.plugins": "Plugin list").
 */
export function Loading({ rows = 3, label, onRetry }: { rows?: number; label: MessageKey; onRetry: () => void }) {
  const [started, setStarted] = useState(() => Date.now());
  const [now, setNow] = useState(started);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [started]);
  const elapsed = now - started;
  if (elapsed >= LOADING_TIMEOUT_MS) {
    const retry = () => {
      const at = Date.now();
      setStarted(at);
      setNow(at);
      onRetry();
    };
    return <ErrorNote error={new Error(t("loading.timedOut", { label: t(label) }))} onRetry={retry} />;
  }
  return (
    <div aria-busy="true" aria-label={t(label)} className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-8 rounded-control bg-surface-2" />
      ))}
      {elapsed >= LOADING_BARS_MS && (
        <p role="status" className="text-sm text-text-2">
          {t(label)}: {t("loading.still", { n: Math.floor(elapsed / 1_000) })}
        </p>
      )}
    </div>
  );
}

/** A read's error; with `onRetry`, a Retry button beside it. Without, the note alone as it always was. */
export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const text = t("common.couldNotLoad", { message: error instanceof Error ? error.message : String(error) });
  const tone = "rounded-control bg-pill-bad-bg px-3 py-2 text-sm text-pill-bad-fg";
  if (!onRetry) return <p role="alert" className={tone}>{text}</p>;
  return (
    <div role="alert" className={cn("flex flex-wrap items-center gap-2", tone)}>
      <p className="min-w-0 flex-1 break-words">{text}</p>
      <Button size="sm" onClick={onRetry}>{t("loading.retry")}</Button>
    </div>
  );
}

/** The flags of a route that answers from the server's stored result (GET /api/v1/health, /api/v1/plugins). */
export interface StoredFlags {
  /** No result yet: keep the placeholder. */
  pending?: boolean;
  /** No good result: the last refresh failed. */
  failed?: boolean;
  /** A newer result is on its way. */
  refreshing?: boolean;
}

/** While `on` (a stored result still pending or refreshing on the server), reads again every second. */
export function useRefetchWhile(on: boolean, refetch: () => unknown): void {
  useEffect(() => {
    if (!on) return;
    const tick = setInterval(() => void refetch(), LOADING_BARS_MS);
    return () => clearInterval(tick);
  }, [on, refetch]);
}
