import type { SystemAction } from "../api.js";
import { t } from "../i18n/index.js";
import { BANNER_LINK_CLASS } from "../components/ui/link-style.js";

/**
 * Shown while the app was built from another revision than the server it talks to runs (design §9): the tab
 * holds old code, or the UI server does. Only "they differ", never which is newer. Hidden while either is unknown.
 */
export function RevisionBanner({ server, web }: { server: string | null | undefined; web: string | null }) {
  if (!server || !web || server === web) return null;
  return (
    <p role="alert" data-testid="revision-banner" className="border-b border-pill-warn-fg bg-pill-warn-bg px-4 py-2 text-sm text-pretty text-pill-warn-fg">
      {t("banner.outOfDate")}<a href="" className={BANNER_LINK_CLASS}>{t("banner.reload")}</a>{t("banner.restart")}<code className="font-mono">{"factory ui"}</code>
    </p>
  );
}

/** The system actions at the top of Needs you, each with the command that clears it. Nothing while there is none. */
export function SystemActions({ actions }: { actions: readonly SystemAction[] }) {
  if (actions.length === 0) return null;
  return (
    <ul aria-label={t("banner.systemActions")} className="mb-3 space-y-1">
      {actions.map((a, i) => (
        <li key={`${a.code}:${i}`} data-action={a.code} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-control bg-pill-bad-bg px-3 py-2 text-sm text-pill-bad-fg">
          <span className="min-w-0 text-pretty break-words">{a.text}</span>
          <code className="font-mono text-xs break-all">{a.command}</code>
        </li>
      ))}
    </ul>
  );
}
