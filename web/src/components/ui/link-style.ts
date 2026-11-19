/**
 * The one style of every link in the dashboard views (the sidebar navigation in App.tsx keeps its own): text-1, underlined
 * on hover. Accent is for the primary Button and the selected-tab underline only (docs/design/09-brand-and-tokens.md).
 */
export const LINK_CLASS = "text-text-1 hover:underline";

/** An ID (an item or source ID, linked or not): text-3 in mono, underlined on hover when it is a link. */
export const ID_CLASS = "font-mono text-text-3 hover:underline";

/**
 * A link on a coloured banner (the pill-warn or pill-bad banners, see system-banner.tsx), where the accent fails 4.5:1
 * in dark mode. It takes the banner's own text token (pill-*-fg on pill-*-bg, readable in light and dark) and is told
 * apart from the text by its underline.
 */
export const BANNER_LINK_CLASS = "text-current underline hover:no-underline";
