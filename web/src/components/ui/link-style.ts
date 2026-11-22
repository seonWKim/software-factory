/**
 * The one style of every link in the dashboard views (the sidebar navigation in App.tsx keeps its own): text-1, underlined
 * on hover. Accent is for the primary Button and the selected-tab underline only (docs/design/09-brand-and-tokens.md).
 * Every link is at least 24px tall, also inside running text (`inline-block min-h-6`, the responsive check's
 * small-target rule). A Button's `inline-flex` still wins over `inline-block`; a link that must be a block (a one-line
 * title cut with an ellipsis) takes BLOCK_LINK_CLASS instead, since `inline-block` would win over its `block`.
 */
export const LINK_CLASS = "inline-block min-h-6 text-text-1 hover:underline";

/** LINK_CLASS for a link that is a block (a row or cell title, often `truncate`). */
export const BLOCK_LINK_CLASS = "block min-h-6 text-text-1 hover:underline";

/** An ID (an item or source ID, linked or not): text-3 in mono, underlined on hover when it is a link. */
export const ID_CLASS = "inline-block min-h-6 font-mono text-text-3 hover:underline";

/**
 * A link on a coloured banner (the pill-warn or pill-bad banners, see system-banner.tsx), where the accent fails 4.5:1
 * in dark mode. It takes the banner's own text token (pill-*-fg on pill-*-bg, readable in light and dark) and is told
 * apart from the text by its underline.
 */
export const BANNER_LINK_CLASS = "inline-block min-h-6 text-current underline hover:no-underline";
