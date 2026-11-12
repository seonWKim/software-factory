import { t } from "../../i18n/index.js";

// The Gongbang mark and wordmark at the top of the sidebar (docs/design/09-brand-and-tokens.md). The mark is
// design-system/icon.svg's square and 공 (tests/design-system.test.ts keeps them equal), coloured from the tokens
// so it holds no colour value of its own: a dark square with a light 공 in both themes, and the ember dot, whose
// radius follows the master's rule at the mark's 24 px (icon.svg's data-small-r).

/** icon.svg's square: x, y, size and corner radius on its 1024 grid. */
export const MARK_SQUARE = { x: 100, y: 100, size: 824, rx: 185 };

/** icon.svg's 공, as outlines (fill-rule evenodd). */
export const MARK_GLYPH =
  "M316 212H708V412H630V286H316ZM474 428H550V496H766V570H258V496H474ZM512 598C581.6 598 638 654.4 638 724C638 793.6 581.6 850 512 850C442.4 850 386 793.6 386 724C386 654.4 442.4 598 512 598ZM512 666C544 666 570 692 570 724C570 756 544 782 512 782C480 782 454 756 454 724C454 692 480 666 512 666Z";

/** The mark's size in the sidebar, in px (`size-6`), and the ember dot: icon.svg's centre and radius, enlarged to 2.5 px. */
const MARK_PX = 24;
export const MARK_EMBER = { cx: 800, cy: 224, r: Math.max(44, (2.5 * 1024) / MARK_PX) };

/** The mark alone; decorative, since the wordmark beside it names the product. */
export function BrandMark({ className }: { className?: string }) {
  const { x, y, size, rx } = MARK_SQUARE;
  return (
    <svg viewBox={`${x} ${y} ${size} ${size}`} aria-hidden="true" focusable="false" className={className} data-testid="brand-mark">
      <rect x={x} y={y} width={size} height={size} rx={rx} className="fill-text-1 dark:fill-surface-2" />
      <path d={MARK_GLYPH} fillRule="evenodd" className="fill-surface dark:fill-text-1" />
      <circle cx={MARK_EMBER.cx} cy={MARK_EMBER.cy} r={MARK_EMBER.r} className="fill-ember" />
    </svg>
  );
}

/** The mark and the wordmark; below sm (the narrow sidebar) only the mark shows. */
export function Brand() {
  return (
    <p className="mb-4 flex items-center gap-2 px-2 text-sm font-semibold max-sm:justify-center max-sm:px-0">
      <BrandMark className="size-6 shrink-0" />
      <span className="max-sm:sr-only">{t("app.name")}</span>
    </p>
  );
}
