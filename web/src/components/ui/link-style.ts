/**
 * The one style of every link in the dashboard views (the sidebar navigation in App.tsx keeps its own).
 * Contrast (WCAG): the accent token on the surface token, 4.5:1 or better in light and dark (tests/ui-link-style.test.tsx).
 */
export const LINK_CLASS = "text-accent hover:underline";

/**
 * A link on a coloured banner (the pill-warn or pill-bad banners, see system-banner.tsx), where the accent fails 4.5:1
 * in dark mode. It takes the banner's own text token (pill-*-fg on pill-*-bg, readable in light and dark) and is told
 * apart from the text by its underline.
 */
export const BANNER_LINK_CLASS = "text-current underline hover:no-underline";
