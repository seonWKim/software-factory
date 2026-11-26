import { Fragment, useId, useState } from "react";
import type { SettingRow } from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { ButtonRow } from "../../components/ui/button-row.js";
import { Input } from "../../components/ui/input.js";
import { SegmentedControl } from "../../components/ui/segmented-control.js";
import { Select } from "../../components/ui/select.js";
import { Switch } from "../../components/ui/switch.js";
import { Textarea } from "../../components/ui/textarea.js";
import type { MessageKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";
import { Outcome, StringListControl, useWrite } from "../settings-file-keys.js";
import { HOLD_CHOICE, HOLD_CHOICES, HOLD_MODES, SHORT_OBJECT, type HoldChoice, type HoldDraft, asObject, entries, holdOf, pretty, stringItems, stringOf, summaryOf } from "./values.js";
import { Disclosure } from "../../components/ui/disclosure.js";
import { ModeDialog, type ModeTarget } from "./mode-dialog.js";
import type { PermissionMode } from "../../../../src/controller/settings/permission-mode.setting.js";

const TIERS = ["cheap", "standard", "strong"] as const;
/** permission_mode's values, tightest first (design 08-permissions), with their segment labels; the type keeps them in step with the server's. */
const PERMISSION_SEGMENTS = [
  { id: "ask_all", label: "settings.permissionMode.ask_all" },
  { id: "ask_irreversible", label: "settings.permissionMode.ask_irreversible" },
  { id: "full", label: "settings.permissionMode.full" },
] as const satisfies readonly { id: PermissionMode; label: MessageKey }[];
/** message_style (design 04-agents): what it does in one line, and an example. */
const STYLE_HINT = t("settings.styleHint");
const STYLE_EXAMPLE = t("settings.styleExample");

/**
 * The edit control for one value: a number field, a switch, a text field per tier, or JSON. No min or max on
 * the field: the server's checks decide, and their message shows next to the field.
 */
export function Editor({ row, label, value, token, project }: { row: SettingRow; label: string; value: string; token: string; project?: string }) {
  const { busy, error, done, write } = useWrite(token);
  // The mode the Mode switch asks to change to, while its confirmation is open.
  const [pendingMode, setPendingMode] = useState<ModeTarget | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [tiers, setTiers] = useState<Record<string, string> | null>(null);
  const [hold, setHold] = useState<HoldDraft | null>(null);
  const [items, setItems] = useState<string[] | null>(null);
  const uid = useId();
  const target = project === undefined ? {} : { project };
  const save = async (text: string): Promise<boolean> => {
    const ok = await write({ action: "set", key: row.key, value: text, ...target });
    if (ok) {
      setDraft(null);
      setTiers(null);
      setHold(null);
      setItems(null);
    }
    return ok;
  };

  let control;
  if (row.key === "mode") {
    // The mode (design 03-risk): on is auto, off is manual. JSON text, as `factory settings set mode` takes it. A change
    // asks first in ModeDialog; only Confirm writes (design 09-dashboard-settings, 2026-11-22).
    control = (
      <span className="flex items-center gap-2 text-sm">
        <Switch aria-label={label} checked={value === '"auto"'} disabled={busy} onCheckedChange={(next) => setPendingMode(next ? "auto" : "manual")} />
        {value === '"auto"' ? t("settings.modeAuto") : t("settings.modeManual")}
        {pendingMode && (
          <ModeDialog
            to={pendingMode}
            busy={busy}
            error={error}
            onConfirm={() => void save(JSON.stringify(pendingMode)).then((ok) => ok && setPendingMode(null))}
            onClose={() => setPendingMode(null)}
          />
        )}
      </span>
    );
  } else if (row.key === "permission_mode") {
    // One segment per mode (design 09-dashboard-settings): a press saves it; a move toward Full the server checks for approve_merge.
    control = (
      <SegmentedControl
        label={label}
        options={PERMISSION_SEGMENTS.map((m) => ({ id: m.id, label: t(m.label) }))}
        value={stringOf(value) as PermissionMode}
        onChange={(m) => void (!busy && m !== stringOf(value) && save(JSON.stringify(m)))}
      />
    );
  } else if (row.kind === "boolean") {
    control = <Switch aria-label={label} checked={value === "true"} disabled={busy} onCheckedChange={(next) => void save(String(next))} />;
  } else if (row.kind === "models") {
    const current = asObject(value) ?? {};
    const shown = tiers ?? Object.fromEntries(TIERS.map((t) => [t, typeof current[t] === "string" ? (current[t] as string) : ""]));
    control = (
      // Two columns, tier | 7rem field, so the three fields start at one x; Save in its own row 12px below.
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), void save(JSON.stringify(shown)))}>
        <div data-tiers className="grid grid-cols-[max-content_7rem] items-center gap-x-2 gap-y-3">
          {TIERS.map((t) => (
            <Fragment key={t}>
              <label htmlFor={`${uid}-${t}`} className="text-xs text-text-2">
                {t}
              </label>
              <Input id={`${uid}-${t}`} aria-label={`${label} ${t}`} className="w-full tabular-nums" value={shown[t]} onChange={(e) => setTiers({ ...shown, [t]: e.target.value })} />
            </Fragment>
          ))}
        </div>
        <ButtonRow>
          <Button type="submit" variant="secondary" disabled={busy || tiers === null} aria-label={t("settings.saveLabel", { label })}>
            {t("settings.save")}
          </Button>
        </ButtonRow>
      </form>
    );
  } else if (row.key === "hold_policy") {
    const cur = holdOf(value);
    const mode = hold?.mode ?? cur.mode;
    const minutes = hold?.minutes ?? cur.minutes;
    const holdSave = () => void save(JSON.stringify(mode === "hold" ? { mode: "hold" } : mode === "run" ? { mode: "run" } : { mode: "run_after_minutes", minutes: Number(minutes) }));
    control = (
      <form className="flex flex-col items-start gap-2" onSubmit={(e) => (e.preventDefault(), holdSave())}>
        <Select aria-label={label} value={HOLD_CHOICE[mode]} onChange={(e) => setHold({ mode: HOLD_MODES[e.target.value as HoldChoice], minutes })}>
          {HOLD_CHOICES.map((c) => (
            <option key={c} value={c}>
              {t(`settings.hold.${c}`)}
            </option>
          ))}
        </Select>
        {mode === "run_after_minutes" && (
          <label className="flex items-center gap-2 text-xs text-text-2">
            {t("settings.holdMinutes")}
            <Input aria-label={t("settings.holdMinutesLabel", { label })} type="number" className="w-24 tabular-nums" value={minutes} onChange={(e) => setHold({ mode, minutes: e.target.value })} />
          </label>
        )}
        <Button type="submit" variant="secondary" disabled={busy || hold === null} aria-label={t("settings.saveLabel", { label })}>
          {t("settings.save")}
        </Button>
      </form>
    );
  } else if (row.kind === "list") {
    // A list of strings: one control per item, sent as a JSON array.
    const shown = items ?? stringItems(value);
    control = (
      <form className="flex flex-col items-start gap-3" onSubmit={(e) => (e.preventDefault(), void save(JSON.stringify(shown)))}>
        <StringListControl draft={shown} label={label} onChange={setItems} />
        <Button type="submit" variant="secondary" disabled={busy || items === null} aria-label={t("settings.saveLabel", { label })}>
          {t("settings.save")}
        </Button>
      </form>
    );
  } else if (row.kind === "text" && row.key === "message_style") {
    // Free text: shown and edited as plain text, sent as a JSON string, as `factory settings set` takes it.
    const shown = draft ?? stringOf(value);
    control = (
      <form className="flex flex-col items-start gap-3" onSubmit={(e) => (e.preventDefault(), void save(JSON.stringify(shown)))}>
        <p className="max-w-md text-xs text-pretty text-text-2">{STYLE_HINT}</p>
        <Textarea aria-label={label} rows={3} className="w-full min-w-48" value={shown} onChange={(e) => setDraft(e.target.value)} />
        <p className="max-w-md text-xs text-pretty text-text-2">{STYLE_EXAMPLE}</p>
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={t("settings.saveLabel", { label })}>
          {t("settings.save")}
        </Button>
      </form>
    );
  } else if (row.kind === "json") {
    // Pretty-printed, one entry per line; a long value sits behind a summary of its keys so its row stays short.
    const shown = draft ?? pretty(value);
    const lines = shown.split("\n").length;
    const obj = asObject(value);
    const form = (
      <form className="flex flex-col items-start gap-3" onSubmit={(e) => (e.preventDefault(), void save(shown))}>
        <Textarea aria-label={label} rows={Math.min(lines, 16)} spellCheck={false} wrap="off" className="w-full min-w-64 font-mono" value={shown} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={t("settings.saveLabel", { label })}>
          {t("settings.save")}
        </Button>
      </form>
    );
    control =
      obj !== null && entries(obj).length > SHORT_OBJECT ? (
        <Disclosure summary={summaryOf(obj, "settings.keysSummaryEdit")}>
          <div className="mt-2">{form}</div>
        </Disclosure>
      ) : (
        form
      );
  } else if (row.kind === "number") {
    // A key with no value (`null`: a spend budget left unset) shows an empty field.
    const shown = draft ?? (value === "null" ? "" : value);
    control = (
      <form className="flex items-center gap-2" onSubmit={(e) => (e.preventDefault(), void save(shown))}>
        {/* step any: a fraction such as 12.50 (a dollar budget) is a valid value; whole-number keys are the server's to check. */}
        <Input
          aria-label={label}
          type="number"
          step="any"
          className="w-32 tabular-nums"
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={t("settings.saveLabel", { label })}>
          {t("settings.save")}
        </Button>
      </form>
    );
  } else {
    // Text, and the fallback for a kind this page does not know: never a number box.
    const shown = draft ?? stringOf(value);
    control = (
      <form className="flex items-center gap-2" onSubmit={(e) => (e.preventDefault(), void save(JSON.stringify(shown)))}>
        <Input aria-label={label} className="w-48" value={shown} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={t("settings.saveLabel", { label })}>
          {t("settings.save")}
        </Button>
      </form>
    );
  }
  return (
    <div>
      {control}
      <Outcome error={error} done={done} />
    </div>
  );
}
