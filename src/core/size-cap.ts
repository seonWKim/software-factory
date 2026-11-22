import type { SplitLimits } from "./split.js";

// An item's size caps (design 04-split-specs): the one place a size reader of one item gets `max_diff_lines` and
// `max_diff_files`. An item may carry a one-time cap that replaces the project settings for it alone; without one,
// the project settings apply. Pure: the caller passes the settings it already read.

/** What a size reader needs of an item: its project (whose settings the caller read) and its one-time cap, absent or null for none. */
export interface SizeCapped {
  project: string;
  size_cap?: SplitLimits | null;
}

/** The item's size caps: its one-time cap when it has one, else the project settings' caps. */
export function sizeCaps(item: SizeCapped, settings: SplitLimits): SplitLimits {
  const caps = item.size_cap ?? settings;
  return { max_diff_lines: caps.max_diff_lines, max_diff_files: caps.max_diff_files };
}
