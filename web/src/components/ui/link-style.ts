/**
 * The one style of every link in the dashboard views (the sidebar navigation in App.tsx keeps its own).
 * Contrast (WCAG): blue-700 on white 6.70:1; blue-400 on zinc-900 6.37:1.
 */
export const LINK_CLASS = "text-blue-700 hover:underline dark:text-blue-400";

/**
 * A link on a coloured banner (amber or red, see system-banner.tsx), where LINK_CLASS's blue fails 4.5:1 in dark mode.
 * Contrast (WCAG): blue-900 on amber-50 10.03:1, on red-50 9.52:1; blue-200 on amber-950 10.54:1, on red-950 11.35:1.
 */
export const BANNER_LINK_CLASS = "text-blue-900 underline hover:no-underline dark:text-blue-200";
