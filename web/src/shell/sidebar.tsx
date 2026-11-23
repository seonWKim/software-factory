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
              className={cn(LINK_ROW, "relative rounded-control hover:bg-surface-2", p === current && "bg-sidebar-active font-medium before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-nav-active")}
            >
              <p.icon aria-hidden className="size-4 shrink-0" />
              <span className="max-lg:sr-only">{pageLabel(p)}</span>
              {!!badges[p.path] && <span role="img" aria-label={t("nav.needYou", { count: badges[p.path]! })} className="ml-auto rounded-pill bg-pill-bad-bg px-1.5 text-xs font-medium text-pill-bad-fg tabular-nums max-lg:sr-only">{badges[p.path]}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The sidebar footer's quiet "? Shortcuts" link (design 09-dashboard-shell): opens the shortcut list (HelpDialog), as `?`
 * does. A narrow sidebar shows only the `?`.
 */
export function ShortcutsLink({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label={t("keys.footerLink")}
      aria-haspopup="dialog"
      aria-keyshortcuts="?"
      title={t("keys.footerLink")}
      onClick={onOpen}
      className={cn(LINK_ROW, "min-h-6 w-full rounded-control text-xs text-text-2 hover:bg-surface-2 hover:text-text-1")}
    >
      <span className="max-lg:hidden">{t("keys.footerLink")}</span>
      <span aria-hidden className="lg:hidden">?</span>
    </button>
  );
}
