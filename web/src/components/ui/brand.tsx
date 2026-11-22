import { t } from "../../i18n/index.js";

// The Gongbang mark and wordmark at the top of the sidebar (docs/design/09-brand-and-tokens.md). The mark is
// design-system/icon.svg's square and glyph, an open loop round a plain file, not a 공 (tests/design-system.test.ts
// keeps them equal), coloured from the tokens so it holds no colour value of its own: a dark square with a light
// loop and file in both themes, and the ember dot at the loop's end, whose radius follows the master's rule at the
// mark's 24 px (icon.svg's data-small-r).

/** icon.svg's square: x, y, size and corner radius on its 1024 grid. */
export const MARK_SQUARE = { x: 100, y: 100, size: 824, rx: 185 };

/** icon.svg's glyph: the open loop and the file inside it, as two separate outlines. */
export const MARK_GLYPH =
  "M788.5 406.3C838.4 536.8 790.2 684.4 673 760.4C555.8 836.4 401.5 820.1 302.7 721.3C203.9 622.5 187.6 468.2 263.6 351C339.6 233.8 487.2 185.6 617.7 235.5L587.7 314C494.2 278.3 388.5 312.7 334.1 396.7C279.7 480.6 291.4 591.2 362.1 661.9C432.8 732.6 543.4 744.3 627.3 689.9C711.3 635.5 745.7 529.8 710 436.3ZM424 396H540L600 456V628H424Z";

/** The mark's size in the sidebar, in px (`size-6`), and the ember dot: icon.svg's centre and radius, enlarged to 2 px. */
const MARK_PX = 24;
export const MARK_EMBER = { cx: 691.6, cy: 332.4, r: Math.max(72, (2 * 1024) / MARK_PX) };

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
