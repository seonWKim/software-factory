import { API, type AutoStop, type SettingsView, type SystemAction, useApi } from "../api.js";
import { FOCUS } from "../components/ui/control.js";
import { BANNER_LINK_CLASS, LINK_CLASS } from "../components/ui/link-style.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { BASE } from "../pages.js";
import { AutoStopNote, alarmAnchor } from "./settings.js";

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

/**
 * One compact Needs-you row (a work item's or a system action's): the content grows from a 16rem basis, so the actions
 * wrap below it before it truncates.
 */
export const NEED_ROW = "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3";

const FAILURES = `${BASE}failures`;

/**
 * One system action as a Needs-you row in the Check group (design 09-status-page): an open alarm (AlarmRow), else
 * its sentence and the command that clears it.
 */
export function CheckRow({ action }: { action: SystemAction }) {
  if (action.code === "alarm") return <AlarmRow action={action} />;
  return (
    <li data-check={action.code} className={NEED_ROW}>
      <span className="min-w-0 grow basis-64 text-sm text-pretty wrap-anywhere text-text-1">{action.text}</span>
      <code className="min-w-0 font-mono text-xs wrap-anywhere text-text-2">{action.command}</code>
    </li>
  );
}

/**
 * An open alarm's row: its text on one line, the full text (with the detail) behind a toggle, and one primary action,
 * "Open on Failures". The auto-mode stop's alarm (design 03-risk) is the target of the Settings link to it and has
 * "Turn auto back on" as its primary action, with Failures as a link. No dismiss: an alarm closes by itself.
 */
function AlarmRow({ action }: { action: SystemAction }) {
  const stop = action.auto_stop;
  return (
    <li data-check="alarm" {...(stop ? { id: alarmAnchor(stop.alert_id) } : {})} className={NEED_ROW}>
      <div className="min-w-0 grow basis-64 space-y-1">
        <p data-alarm-summary title={action.text} className="truncate text-sm font-medium text-text-1">{action.text}</p>
        <details data-alarm-full className="min-w-0 text-xs text-text-2">
          <summary className="cursor-pointer">{t("needs.alarmFull")}</summary>
          <p className="mt-1 text-pretty wrap-anywhere">{action.text}</p>
        </details>
        {stop && <AutoStopLine stop={stop} />}
      </div>
      {stop ? (
        <Link href={FAILURES} className={LINK_CLASS}>{t("needs.alarmFailures")}</Link>
      ) : (
        <Link href={FAILURES} data-command="failures" className={cn("inline-flex min-h-8 items-center rounded-control border border-border-strong bg-surface px-3 text-sm font-medium text-text-1 hover:bg-surface-2", FOCUS)}>
          {t("needs.alarmOpen")}
        </Link>
      )}
    </li>
  );
}

/** The auto-mode stop's when and why with "Turn auto back on"; it reads the settings view for the button's write. */
function AutoStopLine({ stop }: { stop: AutoStop }) {
  const settings = useApi<SettingsView>(API.settings);
  return <AutoStopNote stop={stop} view={settings.data} />;
}
