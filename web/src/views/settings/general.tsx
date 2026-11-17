import { useState } from "react";
import { API, type AutoStop, type SettingRow, type SettingsView, useApi } from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { LINK_CLASS } from "../../components/ui/link-style.js";
import { Section } from "../../components/ui/parts.js";
import { Switch } from "../../components/ui/switch.js";
import type { MessageKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";
import { Link } from "../../nav.js";
import { BASE } from "../../pages.js";
import { Outcome, useWrite } from "../settings-file-keys.js";
import { Editor } from "./editor.js";
import { stringItems, stringOf } from "./values.js";

/** The kinds of wait on the owner that `notice_kinds` lists, in its order, each with its switch's label. */
const NOTICE_KINDS = [
  ["spec", t("settings.noticeSpec")],
  ["merge", t("settings.noticeMerge")],
  ["failure", t("settings.noticeFailure")],
  ["other", t("settings.noticeOther")],
] as const;

/** A switch per kind; each change writes the whole `notice_kinds` list, kinds in their fixed order. */
function NoticeKinds({ row, token }: { row: SettingRow; token: string }) {
  const { busy, error, done, write } = useWrite(token);
  const on = stringItems(row.value);
  const set = (kind: string, next: boolean) => {
    const kinds = NOTICE_KINDS.map(([k]) => k).filter((k) => (k === kind ? next : on.includes(k)));
    void write({ action: "set", key: row.key, value: JSON.stringify(kinds) });
  };
  return (
    <div className="flex max-w-md flex-col gap-2 text-sm">
      <span className="font-medium">{t("settings.noticeWhen")}</span>
      {NOTICE_KINDS.map(([kind, label]) => (
        <label key={kind} className="flex items-center gap-2">
          <Switch aria-label={t("settings.noticeKind", { kind })} checked={on.includes(kind)} disabled={busy} onCheckedChange={(next) => set(kind, next)} />
          <span className="text-pretty">{label}</span>
        </label>
      ))}
      <Outcome error={error} done={done} />
    </div>
  );
}

/** The quiet-hours window as plain text (`HH:MM-HH:MM`, empty for off), sent as a JSON string; the server checks it. */
function QuietHours({ row, token }: { row: SettingRow; token: string }) {
  const { busy, error, done, write } = useWrite(token);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? stringOf(row.value);
  const save = async () => {
    if (await write({ action: "set", key: row.key, value: JSON.stringify(shown.trim()) })) setDraft(null);
  };
  return (
    <div className="flex max-w-md flex-col gap-1 text-sm">
      <span className="font-medium">{t("settings.quietHours")}</span>
      <p className="text-xs text-pretty text-text-2">
        {t("settings.quietHint")}
      </p>
      <form className="flex items-center gap-2" onSubmit={(e) => (e.preventDefault(), void save())}>
        <Input aria-label={t("settings.quietHours")} placeholder="22:00-07:00" className="w-32 tabular-nums" value={shown} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={t("settings.saveLabel", { label: t("settings.quietHours") })}>
          {t("settings.save")}
        </Button>
      </form>
      <Outcome error={error} done={done} />
    </div>
  );
}

/** Owner notices (design 09-notifications): which waits raise one, and the quiet hours that hold them. */
function NoticesSection({ view }: { view: SettingsView }) {
  const kinds = view.keys.find((k) => k.key === "notice_kinds");
  const quiet = view.keys.find((k) => k.key === "quiet_hours");
  if (!kinds && !quiet) return null;
  return (
    <Section title={t("settings.notices")}>
      <p className="mb-2 text-sm text-pretty text-text-2">
        {t("settings.noticesIntro")}
      </p>
      <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
        {kinds && <NoticeKinds row={kinds} token={view.csrf_token} />}
        {quiet && <QuietHours row={quiet} token={view.csrf_token} />}
      </div>
    </Section>
  );
}

/** The configured project's mode (design 03-risk): its own value when it has one, else the global one. */
function currentMode(v: SettingsView): { row: SettingRow; value: string; project?: string } | null {
  const row = v.keys.find((k) => k.key === "mode");
  if (!row) return null;
  const own = v.project === null ? undefined : row.projects.find((p) => p.project === v.project);
  return own ? { row, value: own.value, project: v.repo } : { row, value: row.value };
}

/**
 * The mode switch of the top bar and the Settings page (design 09): manual or auto for the configured project, written
 * through POST /api/v1/settings like any key, so it needs approve_merge and writes one audit row; a refusal shows beside it.
 */
export function ModeSwitch({ floating = false }: { floating?: boolean }) {
  const settings = useApi<SettingsView>(API.settings);
  const v = settings.data;
  const mode = v ? currentMode(v) : null;
  if (!v || !mode) return <span className="text-sm text-text-2">{t("settings.modeLoading")}</span>;
  return (
    <div data-testid="mode" className="flex items-center gap-2 text-sm whitespace-nowrap" title={v.auto_stop ? autoStopText(v.auto_stop) : undefined}>
      <span>{t("settings.mode")}</span>
      <ModeControl view={v} floating={floating} />
    </div>
  );
}

/** Each auto-mode stop's cause (its alarm's error code, design 03-risk), as the Mode toggle and its alarm row name it. */
const STOP_CAUSE: Readonly<Record<string, MessageKey>> = {
  red_main: "settings.autoStopRedMain",
  budget_checkpoint: "settings.autoStopBudget",
  failure_alert: "settings.autoStopFailure",
};

/** A time of day in the browser's time zone, hours and minutes (11:52). */
const clockTime = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** The auto-mode stop's alarm row in the Needs you section's Check group (system-banner.tsx), by the alert's id. */
export const alarmAnchor = (alertId: string) => `alarm-${alertId}`;

/** "Back to manual at 11:52: <why>": the stop's time and cause. */
const autoStopText = (stop: AutoStop) => {
  const cause = STOP_CAUSE[stop.cause];
  return t("settings.autoStopped", { time: clockTime(stop.at), reason: cause ? t(cause) : stop.cause });
};

/**
 * The auto-mode stop still in force (design 03-risk), beside the Mode toggle and on its alarm row in Needs you: when
 * and why, a link to its alarm, and "Turn auto back on", which writes mode auto at once (no confirmation) through
 * POST /api/v1/settings like the toggle. With no settings view yet (its read is loading) there is no button.
 */
export function AutoStopNote({ stop, view }: { stop: AutoStop; view: SettingsView | undefined }) {
  const { busy, error, write } = useWrite(view?.csrf_token ?? "");
  const mode = view ? currentMode(view) : null;
  const target = mode?.project === undefined ? {} : { project: mode.project };
  return (
    <div data-auto-stop className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 text-pretty break-words">{autoStopText(stop)}</span>
        <Link href={`${BASE}#${alarmAnchor(stop.alert_id)}`} className={LINK_CLASS}>{t("settings.autoStopAlarm")}</Link>
        {mode && (
          <Button size="sm" disabled={busy} onClick={() => void write({ action: "set", key: "mode", value: JSON.stringify("auto"), ...target })}>
            {t("settings.autoStopTurnOn")}
          </Button>
        )}
      </span>
      <Outcome error={error} done={null} />
    </div>
  );
}

/** The mode's own control, without the top bar's "Mode" label. */
function ModeControl({ view, floating = false }: { view: SettingsView; floating?: boolean }) {
  const mode = currentMode(view);
  if (!mode) return null;
  return <Editor row={mode.row} label={t("settings.autoMode")} value={mode.value} token={view.csrf_token} floating={floating} {...(mode.project === undefined ? {} : { project: mode.project })} />;
}

/** The mode and, next to it, the auto-merge tier (design 09): what decides whether the factory merges on its own. */
function ModeSection({ view }: { view: SettingsView }) {
  const tier = view.keys.find((k) => k.key === "auto_merge_max_tier");
  return (
    <Section title={t("settings.mode")}>
      <p className="mb-2 text-sm text-pretty text-text-2">
        {t("settings.modeIntro")}
      </p>
      {/* Each label sits above its control, so a refusal under one never squeezes the other's label. */}
      <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
        <div className="flex max-w-md flex-col gap-1 text-sm">
          <span className="font-medium">{t("settings.mode")}</span>
          <ModeControl view={view} />
          {view.auto_stop && currentMode(view)?.value === '"manual"' && <AutoStopNote stop={view.auto_stop} view={view} />}
        </div>
        {tier && (
          <div className="flex max-w-md flex-col gap-1 text-sm">
            <span className="font-medium whitespace-nowrap">{t("settings.tierLabel")}</span>
            <Editor row={tier} label={t("settings.tier")} value={tier.value} token={view.csrf_token} />
          </div>
        )}
      </div>
    </Section>
  );
}

/** The General tab: Mode and the auto-merge tier, then Notices. */
export function GeneralTab({ view }: { view: SettingsView }) {
  return (
    <div>
      <ModeSection view={view} />
      <NoticesSection view={view} />
    </div>
  );
}
