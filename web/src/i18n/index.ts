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
