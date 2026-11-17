import { type MessageKey, en } from "../i18n/en.js";
import { t } from "../i18n/index.js";

// A config key's human label and description (en.ts `key.<name>.label` and `key.<name>.help`). The Settings page shows
// these as a row's primary text; the raw key name sits behind the row's Details. A key with no entry reads as itself.

const has = (id: string): id is MessageKey => id in en;

/** The key's human label; the key itself when the catalog has none. */
export function keyLabel(key: string): string {
  const id = `key.${key}.label`;
  return has(id) ? t(id) : key;
}

/** The key's one-sentence description, or `fallback` (the API's text) when the catalog has none. */
export function keyHelp(key: string, fallback: string): string {
  const id = `key.${key}.help`;
  return has(id) ? t(id) : fallback;
}
