import { type MessageKey, en } from "./en.js";

// Text lookup for the app shell (design §9). The language comes from the browser, nothing is stored. To add a
// locale: write web/src/i18n/<tag>.ts with the same keys as en.ts, then add one line to CATALOGS below.

export type Catalog = Readonly<Record<MessageKey, string>>;

/** Every shipped catalog, by language tag. */
export const CATALOGS: Readonly<Record<string, Partial<Catalog>>> = { en };

const FALLBACK = "en";

/** The first of `languages` (a tag like "fr-FR" matches "fr") that has a catalog; English when none does. */
export function pickLocale(languages: readonly string[]): string {
  for (const tag of languages) {
    const base = tag.toLowerCase().split("-")[0]!;
    if (base in CATALOGS) return base;
  }
  return FALLBACK;
}

/** The active locale: the browser's first language that has a catalog. */
export function locale(): string {
  return pickLocale(typeof navigator === "undefined" ? [] : (navigator.languages ?? []));
}

/** The text for `key` in the active locale, English when that locale lacks it; `{name}` is replaced from `vars`. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const text = CATALOGS[locale()]?.[key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** A whole number in the active locale, with no digit grouping ("1500"). */
export function formatInteger(n: number): string {
  return new Intl.NumberFormat(locale(), { useGrouping: false, maximumFractionDigits: 0 }).format(n);
}

/** A number with one decimal in the active locale ("38.5"). */
export function formatDecimal(n: number): string {
  return new Intl.NumberFormat(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
}

/** The unit keys of the catalog: time units and the compact thousand and million suffixes. */
export type UnitKey = "d" | "h" | "m" | "s" | "ms" | "million" | "thousand";

/** `n` with its unit suffix in the active locale: (12, "s") → "12s"; `decimal` shows one decimal: (2, "thousand", true) → "2.0k". */
export function withUnit(n: number, unit: UnitKey, decimal = false): string {
  return t(`unit.${unit}`, { n: decimal ? formatDecimal(n) : formatInteger(n) });
}
