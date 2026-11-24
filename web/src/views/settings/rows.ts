import { CARD_INTRO } from "../../components/ui/card.js";

// The rows of a Settings list card (an integration, a calendar): one divider between rows, 12px above and below each,
// none outside the first and last, so every list card on Settings has the same inner rhythm (design 09-dashboard-settings).

/** The list: a 1px divider between rows. */
export const SETTINGS_ROWS = "divide-y divide-border text-sm";
/** One row: 12px of padding above and below, none before the first or after the last. */
export const SETTINGS_ROW = "py-3 first:pt-0 last:pb-0";
/** A card's intro line: every card's intro (CARD_INTRO), so Settings' cards read like every other page's. */
export const SETTINGS_INTRO = CARD_INTRO;
