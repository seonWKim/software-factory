import { type RefObject, useId, useState } from "react";
import { ACTION_KINDS, CADENCE_KINDS, type ActionKind, type CadenceKind, type ScheduleFields, type ScheduleRow, actionText } from "../../api.js";
import { Dialog, announceStatus } from "../../components/ui/dialog.js";
import { Field } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Switch } from "../../components/ui/switch.js";
import { Textarea } from "../../components/ui/textarea.js";
import { t } from "../../i18n/index.js";
import { ACTION_TEXT, CADENCE_CHOICE, SPEC_HELP } from "./labels.js";

// The form New schedule and Edit share (design 09-dashboard-schedules): the CLI's fields in one Dialog, so a row's
// input never changes the row's height. Edit sends only the fields the owner changed, as `schedule edit` takes flags.

interface Values {
  title: string;
  cadence: CadenceKind;
  spec: string;
  zone: string;
  action: ActionKind;
  body: string;
  skip: boolean;
  cap: string;
}

const zoneName = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const valuesOf = (s: ScheduleRow | null): Values =>
  s === null
    ? { title: "", cadence: "daily", spec: "09:00", zone: zoneName(), action: "build", body: "", skip: false, cap: "" }
    : { title: s.title, cadence: s.cadence.kind, spec: s.cadence.spec, zone: s.zone, action: s.action?.kind ?? "build", body: actionText(s), skip: s.skip_when_busy, cap: s.token_cap === null ? "" : String(s.token_cap) };

/** The fields to send: every one for a new schedule, only the changed ones for an edit (a blank token limit is left out). */
function fieldsOf(v: Values, was: ScheduleRow | null): ScheduleFields {
  const before = valuesOf(was);
  const f: ScheduleFields = {};
  const changed = (k: keyof Values) => was === null || v[k] !== before[k];
  if (changed("title")) f.title = v.title;
  if (changed("cadence") || changed("spec")) {
    f.cadence = v.cadence;
    f.spec = v.spec;
  }
  if (changed("zone")) f.zone = v.zone;
  // A changed kind sends its text too: the server builds the action from both.
  if (changed("action") || changed("body")) {
    f.action = v.action;
    f.body = v.body;
  }
  if (changed("skip")) f.skip_when_busy = v.skip;
  if (v.cap.trim() !== "" && changed("cap")) f.token_cap = Number(v.cap);
  return f;
}

/** An ID for a new schedule from its title, unused among `taken`: the page never shows it. */
export function newScheduleId(title: string, taken: readonly string[]): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "schedule";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

export function ScheduleDialog({ schedule, busy, error, returnFocusTo, onSave, onClose }: {
  schedule: ScheduleRow | null;
  busy: boolean;
  error: string | null;
  returnFocusTo: RefObject<HTMLElement | null>;
  /** Sends the fields; true when stored. */
  onSave: (fields: ScheduleFields) => Promise<boolean>;
  onClose: () => void;
}) {
  const [v, setV] = useState<Values>(() => valuesOf(schedule));
  const set = <K extends keyof Values>(k: K, x: Values[K]) => setV((old) => ({ ...old, [k]: x }));
  const base = useId();
  const id = (name: string) => `${base}-${name}`;
  const save = async () => {
    const fields = fieldsOf(v, schedule);
    if (schedule !== null && Object.keys(fields).length === 0) return onClose();
    if (await onSave(fields)) {
      announceStatus(t("schedules.saved"));
      onClose();
    }
  };
  return (
    <Dialog
      title={schedule === null ? t("schedules.form.addTitle") : t("schedules.form.editTitle", { title: schedule.title })}
      confirmLabel={t(schedule === null ? "schedules.form.add" : "schedules.form.save")}
      confirmDisabled={busy}
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => void save()}
      onClose={onClose}
    >
      <Field label={t("schedules.form.title")} htmlFor={id("title")}>
        <Input id={id("title")} value={v.title} onChange={(e) => set("title", e.target.value)} />
      </Field>
      <Field label={t("schedules.form.cadence")} htmlFor={id("cadence")}>
        <Select id={id("cadence")} value={v.cadence} onChange={(e) => set("cadence", e.target.value as CadenceKind)}>
          {CADENCE_KINDS.map((k) => <option key={k} value={k}>{t(CADENCE_CHOICE[k])}</option>)}
        </Select>
      </Field>
      <Field label={t("schedules.form.spec")} htmlFor={id("spec")} help={t(SPEC_HELP[v.cadence])}>
        <Input id={id("spec")} value={v.spec} onChange={(e) => set("spec", e.target.value)} />
      </Field>
      <Field label={t("schedules.form.zone")} htmlFor={id("zone")} help={t("schedules.form.zoneHelp")}>
        <Input id={id("zone")} value={v.zone} onChange={(e) => set("zone", e.target.value)} />
      </Field>
      <Field label={t("schedules.form.action")} htmlFor={id("action")}>
        <Select id={id("action")} value={v.action} onChange={(e) => set("action", e.target.value as ActionKind)}>
          {ACTION_KINDS.map((k) => <option key={k} value={k}>{t(ACTION_TEXT[k])}</option>)}
        </Select>
      </Field>
      <Field label={t("schedules.form.body")} htmlFor={id("body")} help={t(v.action === "build" ? "schedules.form.bodyBuild" : "schedules.form.bodyPrompt")}>
        <Textarea id={id("body")} rows={5} value={v.body} onChange={(e) => set("body", e.target.value)} />
      </Field>
      <Field label={t("schedules.form.skipWhenBusy")} htmlFor={id("skip")} help={t("schedules.form.skipHelp")}>
        <Switch id={id("skip")} checked={v.skip} onCheckedChange={(on) => set("skip", on)} />
      </Field>
      <Field label={t("schedules.form.tokenCap")} htmlFor={id("cap")} help={t("schedules.form.tokenCapHelp")}>
        <Input id={id("cap")} type="number" min={1} step={1} value={v.cap} onChange={(e) => set("cap", e.target.value)} />
      </Field>
    </Dialog>
  );
}

/** Asks before a delete: the schedule stops running, and its past runs stay in Work. The confirm is the danger one. */
export function DeleteScheduleDialog({ schedule, busy, error, returnFocusTo, onConfirm, onClose }: {
  schedule: ScheduleRow;
  busy: boolean;
  error: string | null;
  returnFocusTo: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={t("schedules.delete.title", { title: schedule.title })}
      consequence={t("schedules.delete.consequence")}
      confirmLabel={t("schedules.delete.confirm")}
      confirmDisabled={busy}
      danger
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
