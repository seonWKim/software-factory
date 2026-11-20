import { type MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { FOCUS } from "../components/ui/control.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { BASE, type PageDef } from "../pages.js";

/** A page's name in the active locale: its menu name and its heading. */
export const pageLabel = (p: PageDef) => t(`page.${p.key}` as MessageKey);

const LINK_ROW = `flex items-center gap-2 px-2 py-1.5 text-sm ${FOCUS}`;

/** One sidebar group of page links, with no visible title; `label` is its accessible name. */
export function SideLinks({ label, pages, current, badges = {} }: { label: string; pages: readonly PageDef[]; current: PageDef; badges?: Readonly<Record<string, number | undefined>> }) {
  return (
    <nav aria-label={label}>
      <ul className="space-y-1">
        {pages.map((p) => (
          <li key={p.path}>
            <Link
              href={BASE + p.path}
              aria-current={p === current ? "page" : undefined}
              title={pageLabel(p)}
              aria-label={pageLabel(p)}
              className={cn(LINK_ROW, "relative rounded-control hover:bg-surface-2", p === current && "bg-surface-2 font-medium before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-nav-active")}
            >
              <p.icon aria-hidden className="size-4 shrink-0" />
              <span className="max-sm:sr-only">{pageLabel(p)}</span>
              {!!badges[p.path] && <span className="ml-auto rounded-pill bg-pill-bad-bg px-1.5 text-xs font-medium text-pill-bad-fg tabular-nums max-sm:sr-only">{badges[p.path]}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
