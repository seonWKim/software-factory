import { useEffect, useId, useState } from "react";
import { API, type AutoStop, type SettingRow, type SettingsView, useApi } from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { Field } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { LINK_CLASS } from "../../components/ui/link-style.js";
import { Switch } from "../../components/ui/switch.js";
import type { MessageKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";
import { SETTINGS_INTRO } from "./rows.js";
import { Link } from "../../nav.js";
import { BASE } from "../../pages.js";
import { Outcome, useWrite } from "../settings-file-keys.js";
import { Editor } from "./editor.js";
import { ModeDialog } from "./mode-dialog.js";
import { stringItems, stringOf } from "./values.js";
import { Card } from "../../components/ui/card.js";
import { AppearanceSection } from "./appearance.js";

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
    <Field label={t("settings.noticeWhen")} className="max-w-md">
      <div className="flex flex-col gap-2 text-sm">
        {NOTICE_KINDS.map(([kind, label]) => (
          <label key={kind} className="flex items-center gap-2">
            <Switch aria-label={t("settings.noticeKind", { kind })} checked={on.includes(kind)} disabled={busy} onCheckedChange={(next) => set(kind, next)} />
            <span className="text-pretty">{label}</span>
          </label>
        ))}
      </div>
      <Outcome error={error} done={done} />
    </Field>
  );
}

/** The quiet-hours window as plain text (`HH:MM-HH:MM`, empty for off), sent as a JSON string; the server checks it. */
function QuietHours({ row, token }: { row: SettingRow; token: string }) {
  const { busy, error, done, write } = useWrite(token);
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? stringOf(row.value);
  const save = async () => {
    if (await write({ action: "set", key: row.key, value: JSON.stringify(shown.trim()) })) setDraft(null);
  };
  return (
    <Field label={t("settings.quietHours")} htmlFor={id} help={t("settings.quietHint")} className="max-w-md">
      <form className="flex items-center gap-2" onSubmit={(e) => (e.preventDefault(), void save())}>
        <Input id={id} placeholder="22:00-07:00" className="w-32 tabular-nums" value={shown} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={t("settings.saveLabel", { label: t("settings.quietHours") })}>
          {t("settings.save")}
        </Button>
      </form>
      <Outcome error={error} done={done} />
    </Field>
  );
}

/** Owner notices (design 09-notifications): which waits raise one, and the quiet hours that hold them. */
function NoticesSection({ view }: { view: SettingsView }) {
  const kinds = view.keys.find((k) => k.key === "notice_kinds");
  const quiet = view.keys.find((k) => k.key === "quiet_hours");
  if (!kinds && !quiet) return null;
  return (
    <Card title={t("settings.notices")}>
      <p className={SETTINGS_INTRO}>
        {t("settings.noticesIntro")}
      </p>
      <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
        {kinds && <NoticeKinds row={kinds} token={view.csrf_token} />}
        {quiet && <QuietHours row={quiet} token={view.csrf_token} />}
      </div>
    </Card>
  );
}

/** The configured project's mode (design 03-risk): its own value when it has one, else the global one. */
export function currentMode(v: SettingsView): { row: SettingRow; value: string; project?: string } | null {
  const row = v.keys.find((k) => k.key === "mode");
  if (!row) return null;
  const own = v.project === null ? undefined : row.projects.find((p) => p.project === v.project);
  return own ? { row, value: own.value, project: v.repo } : { row, value: row.value };
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
export const autoStopText = (stop: AutoStop) => {
  const cause = STOP_CAUSE[stop.cause];
  return t("settings.autoStopped", { time: clockTime(stop.at), reason: cause ? t(cause) : stop.cause });
};

/**
 * The auto-mode stop still in force (design 03-risk), beside the Mode toggle: when and why, a link to its alarm, and
 * "Turn auto back on", which opens ModeDialog; its Confirm writes mode auto once through POST /api/v1/settings like the
 * toggle. With no settings view yet (its read is loading) there is no button.
 */
export function AutoStopNote({ stop, view }: { stop: AutoStop; view: SettingsView | undefined }) {
  const { busy, error, write } = useWrite(view?.csrf_token ?? "");
  const [confirming, setConfirming] = useState(false);
  const mode = view ? currentMode(view) : null;
  const target = mode?.project === undefined ? {} : { project: mode.project };
  const turnOn = async () => {
    if (await write({ action: "set", key: "mode", value: JSON.stringify("auto"), ...target })) setConfirming(false);
  };
  return (
    <div data-auto-stop className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 text-pretty break-words">{autoStopText(stop)}</span>
        <Link href={`${BASE}#${alarmAnchor(stop.alert_id)}`} className={LINK_CLASS}>{t("settings.autoStopAlarm")}</Link>
        {mode && (
          <Button size="sm" disabled={busy} onClick={() => setConfirming(true)}>
            {t("settings.autoStopTurnOn")}
          </Button>
        )}
      </span>
      {confirming && <ModeDialog to="auto" busy={busy} error={error} onConfirm={() => void turnOn()} onClose={() => setConfirming(false)} />}
      <Outcome error={error} done={null} />
    </div>
  );
}

/** The mode's own control. */
function ModeControl({ view }: { view: SettingsView }) {
  const mode = currentMode(view);
  if (!mode) return null;
  return <Editor row={mode.row} label={t("settings.autoMode")} value={mode.value} token={view.csrf_token} {...(mode.project === undefined ? {} : { project: mode.project })} />;
}

/** The Mode section's anchor: the top bar's mode chip links to `settings#mode`. */
export const MODE_ANCHOR = "mode";

/** The mode and, next to it, the auto-merge risk level (design 09): what decides whether the factory merges on its own. */
function ModeSection({ view }: { view: SettingsView }) {
  const tier = view.keys.find((k) => k.key === "auto_merge_max_tier");
  // Opened from the mode chip (`#mode`): the section scrolls into view once drawn.
  useEffect(() => {
    if (window.location.hash === `#${MODE_ANCHOR}`) document.getElementById(MODE_ANCHOR)?.scrollIntoView?.();
  }, []);
  return (
    <Card id={MODE_ANCHOR} title={t("settings.mode")}>
      <ul className={`${SETTINGS_INTRO} space-y-1`}>
        {(["settings.modeLineManual", "settings.modeLineAuto", "settings.modeLineBack"] as const).map((line) => (
          <li key={line}>{t(line)}</li>
        ))}
      </ul>
      {/* Each label sits above its control, so a refusal under one never squeezes the other's label. */}
      <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
        <Field label={t("settings.mode")} className="max-w-md">
          <ModeControl view={view} />
          {view.auto_stop && currentMode(view)?.value === '"manual"' && <AutoStopNote stop={view.auto_stop} view={view} />}
        </Field>
        {tier && (
          <Field
            label={t("settings.tierLabel")}
            className="max-w-md"
            help={
              <ul data-tier-levels className="space-y-0.5">
                {(["settings.tierLevel0", "settings.tierLevel1", "settings.tierLevel2", "settings.tierLevel3", "settings.tierAbove"] as const).map((line) => (
                  <li key={line}>{t(line)}</li>
                ))}
              </ul>
            }
          >
            <Editor row={tier} label={t("settings.tierLabel")} value={tier.value} token={view.csrf_token} />
          </Field>
        )}
      </div>
    </Card>
  );
}

/** The General tab: Mode and the auto-merge risk level, then Notices, then Appearance (the theme). */
export function GeneralTab({ view }: { view: SettingsView }) {
  return (
    <div>
      <ModeSection view={view} />
      <NoticesSection view={view} />
      <AppearanceSection />
    </div>
  );
}
