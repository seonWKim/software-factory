import { API, type AutoStop, type SettingsView, type SystemAction, useApi } from "../api.js";
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
 * What the factory needs from the operator besides a work item, under the Needs-you list (design 09-status-page):
 * each system action but the alarms on one line with the command that clears it; the open alarms as one line that
 * links to Failures, however many, except the auto-mode stop still in force, which has its own line with its time, cause
 * and "Turn auto back on" (design 03-risk); the items started past a deadlock as one line that links to Work items (their
 * runs go on, so they are no rows and no count). Nothing while there is none of these.
 */
export function FloorNotes({ actions, deadlocks }: { actions: readonly SystemAction[]; deadlocks: number }) {
  const stop = actions.find((a) => a.auto_stop)?.auto_stop;
  const alarms = actions.filter((a) => a.code === "alarm" && !a.auto_stop).length;
  const others = actions.filter((a) => a.code !== "alarm");
  if (others.length === 0 && alarms === 0 && deadlocks === 0 && !stop) return null;
  const line = "flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-control px-3 py-1.5 text-sm";
  const red = "bg-pill-bad-bg text-pill-bad-fg";
  return (
    <ul aria-label={t("banner.systemActions")} className="mt-3 space-y-1">
      {others.map((a, i) => (
        <li key={`${a.code}:${i}`} data-action={a.code} className={cn(line, red)}>
          <span className="min-w-0 text-pretty break-words">{a.text}</span>
          <code className="font-mono text-xs break-words">{a.command}</code>
        </li>
      ))}
      {stop && <AutoStopLine stop={stop} className={cn(line, red)} />}
      {alarms > 0 && (
        <li data-action="alarm" className={cn(line, red)}>
          <span>{t("floor.alarms", { count: alarms })}</span>
          <Link href={`${BASE}failures`} className={BANNER_LINK_CLASS}>{t("floor.alarmsLink")}</Link>
        </li>
      )}
      {deadlocks > 0 && (
        <li data-deadlocks className={cn(line, "bg-surface-2 text-text-1")}>
          <span className="min-w-0 text-pretty">{t("floor.deadlocks", { count: deadlocks })}</span>
          <Link href={`${BASE}items`} className={LINK_CLASS}>{t("floor.deadlocksLink")}</Link>
        </li>
      )}
    </ul>
  );
}

/** The auto-mode stop's line, the target of its alarm link; it reads the settings view for the button's write. */
function AutoStopLine({ stop, className }: { stop: AutoStop; className: string }) {
  const settings = useApi<SettingsView>(API.settings);
  return (
    <li id={alarmAnchor(stop.alert_id)} data-action="auto_stop" className={className}>
      <AutoStopNote stop={stop} view={settings.data} banner />
    </li>
  );
}
