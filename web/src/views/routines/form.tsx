import { type RefObject, useId, useState } from "react";
import { ROUTINE_CADENCE_KINDS, type RoutineFields, type RoutineRow } from "../../api.js";
import { Dialog, announceStatus } from "../../components/ui/dialog.js";
import { Field } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Textarea } from "../../components/ui/textarea.js";
import { t } from "../../i18n/index.js";
import { newScheduleId } from "../schedules/form.js";
import { REPEAT_CHOICE, type RepeatKind, SPEC_HELP } from "./labels.js";

// The form New routine and Edit share (design 09-dashboard-routines), and the Delete confirmation: one Dialog each,
// so a row's input never changes the row's height. Edit sends only the fields the owner changed.

interface Values {
  name: string;
  instruction: string;
  url: string;
  repeats: RepeatKind;
  spec: string;
  zone: string;
  runCap: string;
  dailyCap: string;
}

const zoneName = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const valuesOf = (r: RoutineRow | null): Values =>
  r === null
    ? { name: "", instruction: "", url: "", repeats: "daily", spec: "09:00", zone: zoneName(), runCap: "", dailyCap: "" }
    : {
        name: r.name, instruction: r.instruction, url: r.url ?? "", repeats: r.schedule?.kind ?? "merge", spec: r.schedule?.spec ?? "09:00", zone: r.zone,
        runCap: r.run_cap_usd === null ? "" : String(r.run_cap_usd), dailyCap: r.daily_cap_usd === null ? "" : String(r.daily_cap_usd),
      };

const capOf = (s: string): number | null => (s.trim() === "" ? null : Number(s));

/** The fields to send: every one for a new routine, only the changed ones for an edit (a blank cap or page is none). */
export function fieldsOf(v: Values, was: RoutineRow | null): RoutineFields {
  const before = valuesOf(was);
  const f: RoutineFields = {};
  const changed = (k: keyof Values) => was === null || v[k] !== before[k];
  if (changed("name")) f.name = v.name;
  if (changed("instruction")) f.instruction = v.instruction;
  if (changed("url")) f.url = v.url.trim() === "" ? null : v.url.trim();
  // The schedule and the trigger are one choice: a change to either sends both, the unused one null.
  if (changed("repeats") || (v.repeats !== "merge" && changed("spec"))) {
    f.schedule = v.repeats === "merge" ? null : { kind: v.repeats, spec: v.spec };
    f.trigger = v.repeats === "merge" ? "merge" : null;
  }
  if (changed("zone")) f.zone = v.zone;
  if (changed("runCap")) f.run_cap_usd = capOf(v.runCap);
  if (changed("dailyCap")) f.daily_cap_usd = capOf(v.dailyCap);
  return f;
}

/** An ID for a new routine from its name, unused among `taken`: the page never shows it. */
export const newRoutineId = (name: string, taken: readonly string[]): string => newScheduleId(name, taken);

export function RoutineDialog({ routine, busy, error, returnFocusTo, onSave, onClose }: {
  routine: RoutineRow | null;
  busy: boolean;
  error: string | null;
  returnFocusTo: RefObject<HTMLElement | null>;
  /** Sends the fields; true when stored. */
  onSave: (fields: RoutineFields) => Promise<boolean>;
  onClose: () => void;
}) {
  const [v, setV] = useState<Values>(() => valuesOf(routine));
  const set = <K extends keyof Values>(k: K, x: Values[K]) => setV((old) => ({ ...old, [k]: x }));
  const base = useId();
  const id = (name: string) => `${base}-${name}`;
  const save = async () => {
    const fields = fieldsOf(v, routine);
    if (routine !== null && Object.keys(fields).length === 0) return onClose();
    if (await onSave(fields)) {
      announceStatus(t("routines.saved"));
      onClose();
    }
  };
  return (
    <Dialog
      title={routine === null ? t("routines.form.addTitle") : t("routines.form.editTitle", { name: routine.name })}
      confirmLabel={t(routine === null ? "routines.form.add" : "routines.form.save")}
      confirmDisabled={busy}
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => void save()}
      onClose={onClose}
    >
      <Field label={t("routines.form.name")} htmlFor={id("name")}>
        <Input id={id("name")} value={v.name} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field label={t("routines.form.instruction")} htmlFor={id("instruction")} help={t("routines.form.instructionHelp")}>
        <Textarea id={id("instruction")} rows={5} value={v.instruction} onChange={(e) => set("instruction", e.target.value)} />
      </Field>
      <Field label={t("routines.form.url")} htmlFor={id("url")} help={t("routines.form.urlHelp")}>
        <Input id={id("url")} value={v.url} onChange={(e) => set("url", e.target.value)} />
      </Field>
      {/* Paired fields share a row from `sm` up, so at a laptop height the form fits with Save in view. */}
      <div data-field-pair className="grid items-start gap-3 sm:grid-cols-2">
        <Field label={t("routines.form.repeats")} htmlFor={id("repeats")}>
          <Select id={id("repeats")} value={v.repeats} onChange={(e) => set("repeats", e.target.value as RepeatKind)}>
            {[...ROUTINE_CADENCE_KINDS, "merge" as const].map((k) => <option key={k} value={k}>{t(REPEAT_CHOICE[k])}</option>)}
          </Select>
        </Field>
        {v.repeats !== "merge" && (
          <Field label={t("routines.form.spec")} htmlFor={id("spec")} help={t(SPEC_HELP[v.repeats])}>
            <Input id={id("spec")} value={v.spec} onChange={(e) => set("spec", e.target.value)} />
          </Field>
        )}
      </div>
      <Field label={t("routines.form.zone")} htmlFor={id("zone")} help={t("routines.form.zoneHelp")}>
        <Input id={id("zone")} value={v.zone} onChange={(e) => set("zone", e.target.value)} />
      </Field>
      <div data-field-pair className="grid items-start gap-3 sm:grid-cols-2">
        <Field label={t("routines.form.runCap")} htmlFor={id("runCap")} help={t("routines.form.runCapHelp")}>
          <Input id={id("runCap")} type="number" min={0} step="any" value={v.runCap} onChange={(e) => set("runCap", e.target.value)} />
        </Field>
        <Field label={t("routines.form.dailyCap")} htmlFor={id("dailyCap")} help={t("routines.form.dailyCapHelp")}>
          <Input id={id("dailyCap")} type="number" min={0} step="any" value={v.dailyCap} onChange={(e) => set("dailyCap", e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

export function DeleteRoutineDialog({ routine, busy, error, returnFocusTo, onConfirm, onClose }: {
  routine: RoutineRow;
  busy: boolean;
  error: string | null;
  returnFocusTo: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={t("routines.delete.title", { name: routine.name })}
      consequence={t("routines.delete.consequence")}
      confirmLabel={t("routines.delete.confirm")}
      confirmDisabled={busy}
      danger
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
