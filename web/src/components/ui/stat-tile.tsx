import type { ReactNode } from "react";

// A figure in a tile (design-system/components.md "StatTile"): Work's Last 24 hours, Health's Spend totals and the
// Efficiency charts. One box, one label type, one value type, so tiles on different pages line up and read alike.

/** The tile: the box radius, a 1px `border` on `surface`, 12px of padding. */
export const STAT_TILE = "min-w-0 rounded-box border border-border bg-surface p-3";
/** The tile's label: meta type. */
export const STAT_LABEL = "text-xs text-text-2";
/** The tile's figure, 4px under the label: the large-figure step, semibold, tabular. */
export const STAT_VALUE = "mt-1 text-lg font-semibold tabular-nums";
/** A line under the figure (tokens, a budget): meta type, tabular. */
export const STAT_NOTE = "text-xs text-text-2 tabular-nums";

/**
 * One figure in a tile, inside a `<dl>` grid of tiles (12px apart): the label (`dt`), the figure (`dd`) and any
 * further `dd` lines as `children` (in STAT_NOTE). `data-*` props go on the tile.
 */
export function StatTile({ label, value, children, ...data }: { label: ReactNode; value: ReactNode; children?: ReactNode } & { [d: `data-${string}`]: string | undefined }) {
  return (
    <div {...data} className={STAT_TILE}>
      <dt className={STAT_LABEL}>{label}</dt>
      <dd className={STAT_VALUE}>{value}</dd>
      {children}
    </div>
  );
}
