import { type ReactNode, useEffect, useState } from "react";
import { Disclosure } from "../components/ui/disclosure.js";
import { type MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { localDateTime, relativeTime } from "../lib/format.js";

/** Date.now(), ticking each second, for "Ns ago" texts. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * A relative time in the one compact form (`relativeTime`), with the exact local time in the element's title. `label`
 * is a catalog text with `{time}` (and the `vars`) for a time inside a sentence ("started {time}"); "–" when there is no time.
 */
export function When({ at, now, label, vars }: { at: string | null | undefined; now: number; label?: MessageKey; vars?: Record<string, string | number> }) {
  if (!at) return <>{t("format.none")}</>;
  const time = relativeTime(at, now);
  return <time dateTime={at} title={localDateTime(at)}>{label ? t(label, { ...vars, time }) : time}</time>;
}

/** The raw fields of a row or card, behind one "Details" toggle: the only place a page shows a stored field name or code as it is stored (`data-raw`, skipped by tests/web-plain-words.test.tsx). */
export function RawDetails({ children, className }: { children: ReactNode; className?: string }) {
  return <Disclosure data-raw className={className} summary={t("details.raw")}>{children}</Disclosure>;
}

/** A snake_case name or an item ID, as `npm run check:responsive`'s raw-name rule finds them (scripts/responsive/rules.mjs). */
const RAW_NAME = /\b(?:wi_[0-9a-z]+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;

/** A sentence that may quote names as written (a check's message): each snake_case name or item ID in it sits in `data-raw`, the words around it stay plain. */
export function RawNames({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(RAW_NAME)) {
    parts.push(text.slice(last, m.index), <span key={m.index} data-raw>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}
