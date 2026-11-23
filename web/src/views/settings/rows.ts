// The rows of a Settings list card (an integration, a calendar): one divider between rows, 12px above and below each,
// none outside the first and last, so every list card on Settings has the same inner rhythm (design 09-dashboard-settings).

/** The list: a 1px divider between rows. */
export const SETTINGS_ROWS = "divide-y divide-border text-sm";
/** One row: 12px of padding above and below, none before the first or after the last. */
export const SETTINGS_ROW = "py-3 first:pt-0 last:pb-0";
/** A card's intro line: secondary text, a readable measure, 16px above the list. */
export const SETTINGS_INTRO = "mb-4 max-w-[75ch] text-sm text-pretty text-text-2";
