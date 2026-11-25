import { type RefObject, useId, useState } from "react";
import {
  ACTION_KINDS, API, CADENCE_KINDS, type ActionKind, type CadenceKind, type ScheduleFields, type ScheduleImprovement, type ScheduleRow, type Session,
  actionText, isWritableKind, postScheduleDraft, postScheduleImprove, useApi,
} from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { ButtonRow } from "../../components/ui/button-row.js";
import { Dialog, announceStatus } from "../../components/ui/dialog.js";
import { Field } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { KeyValue } from "../../components/ui/key-value.js";
import { Notice } from "../../components/ui/notice.js";
import { Select } from "../../components/ui/select.js";
import { Switch } from "../../components/ui/switch.js";
import { Textarea } from "../../components/ui/textarea.js";
import { t } from "../../i18n/index.js";
import { ACTION_TEXT, CADENCE_CHOICE, MISSED_RULES, MISSED_TEXT, type MissedRule, SPEC_HELP, missedOf } from "./labels.js";

// The form New schedule and Edit share (design 09-dashboard-schedules): the CLI's fields in one Dialog, so a row's
// input never changes the row's height. Edit sends only the fields the owner changed, as `schedule edit` takes flags.

interface Values {
  title: string;
  cadence: CadenceKind;
  spec: string;
  zone: string;
  action: ActionKind;
  body: string;
  missed: MissedRule;
  cap: string;
}

const zoneName = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const valuesOf = (s: ScheduleRow | null): Values =>
  s === null
    ? { title: "", cadence: "daily", spec: "09:00", zone: zoneName(), action: "build", body: "", missed: "catch_up", cap: "" }
    : { title: s.title, cadence: s.cadence.kind, spec: s.cadence.spec, zone: s.zone, action: s.action?.kind ?? "build", body: actionText(s), missed: missedOf(s.skip_when_busy), cap: s.token_cap === null ? "" : String(s.token_cap) };

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
  // A changed kind sends its text too: the server builds the action from both. A kind the form can't write (improve,
  // added by setup) is never sent, so saving keeps it.
  if (isWritableKind(v.action) && (changed("action") || changed("body"))) {
    f.action = v.action;
    f.body = v.body;
  }
  if (changed("missed")) f.skip_when_busy = v.missed === "skip";
  if (v.cap.trim() !== "" && changed("cap")) f.token_cap = Number(v.cap);
  return f;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Whether a daily or weekly cadence's time today has already passed on the browser's clock (for weekly, today is one
 * of its days): then its first run is tomorrow or later, so New schedule offers Run now too.
 */
function passedToday(cadence: CadenceKind, spec: string, now: Date): boolean {
  const m = cadence === "daily" ? /^()(\d{2}):(\d{2})$/.exec(spec.trim()) : cadence === "weekly" ? /^([a-z,]+)\s+(\d{2}):(\d{2})$/i.exec(spec.trim()) : null;
  if (m === null) return false;
  if (cadence === "weekly" && !m[1]!.toLowerCase().split(",").includes(WEEKDAYS[now.getDay()]!)) return false;
  return now.getHours() * 60 + now.getMinutes() > Number(m[2]) * 60 + Number(m[3]);
}

/** The accent ring and `data-changed` on a control Draft or Use this just filled, until the owner edits it. */
const changedProps = (marked: ReadonlySet<keyof Values>, k: keyof Values) => (marked.has(k) ? { "data-changed": true, className: "ring-2 ring-accent" } : {});
/** The same mark on a Select's wrapper: Select takes no data attribute, so a block around it carries them. */
const markedBox = (marked: ReadonlySet<keyof Values>, k: keyof Values) => (marked.has(k) ? { "data-changed": true, className: "rounded-control ring-2 ring-accent" } : {});

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
  // The stored kind the form can't write (improve) stays listed, disabled, after another kind is picked.
  const stored = valuesOf(schedule).action;
  const token = useApi<Session>(API.session, false).data?.csrf_token ?? null;
  // The fields a draft or Use this changed, marked until the owner edits them.
  const [marked, setMarked] = useState<ReadonlySet<keyof Values>>(new Set());
  const [words, setWords] = useState("");
  const [pending, setPending] = useState<"draft" | "improve" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [improvement, setImprovement] = useState<ScheduleImprovement | null>(null);
  const [runNow, setRunNow] = useState(false);
  // Run now too: New schedule only, while today's time has passed; a hidden switch sends nothing.
  const offerRunNow = schedule === null && passedToday(v.cadence, v.spec, new Date());
  const set = <K extends keyof Values>(k: K, x: Values[K]) => {
    setV((old) => ({ ...old, [k]: x }));
    setMarked((m) => (m.has(k) ? new Set([...m].filter((j) => j !== k)) : m));
  };
  const draft = async () => {
    if (token === null || words.trim() === "") return;
    setPending("draft");
    setProblem(null);
    const r = await postScheduleDraft(token, words);
    setPending(null);
    if (!r.ok) return setProblem(t("schedules.form.draftFailed", { reason: r.error }));
    const f = r.proposal.fields;
    const next: Partial<Values> = { title: f.title, cadence: f.cadence as CadenceKind, spec: f.spec, zone: f.zone, action: f.action as ActionKind, body: f.body };
    setMarked(new Set((Object.keys(next) as (keyof Values)[]).filter((k) => next[k] !== v[k])));
    setV((old) => ({ ...old, ...next }));
  };
  const improve = async () => {
    if (token === null || schedule === null) return;
    setPending("improve");
    setProblem(null);
    const r = await postScheduleImprove(token, schedule.id);
    setPending(null);
    if (!r.ok) return setProblem(t("schedules.form.improveFailed", { reason: r.error }));
    setImprovement(r.proposal);
  };
  const useRevised = () => {
    if (improvement === null) return;
    if (improvement.new !== v.body) setMarked((m) => new Set(m).add("body"));
    setV((old) => ({ ...old, body: improvement.new }));
    setImprovement(null);
  };
  const base = useId();
  const id = (name: string) => `${base}-${name}`;
  const save = async () => {
    const fields = fieldsOf(v, schedule);
    if (offerRunNow && runNow) fields.run_now = true;
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
      {schedule === null && (
        <Field label={t("schedules.form.describe")} htmlFor={id("describe")} help={t("schedules.form.describeHelp")}>
          <Textarea id={id("describe")} rows={3} value={words} onChange={(e) => setWords(e.target.value)} />
          <ButtonRow>
            <Button variant="secondary" disabled={pending !== null || token === null || words.trim() === ""} onClick={() => void draft()}>
              {t(pending === "draft" ? "schedules.form.drafting" : "schedules.form.draft")}
            </Button>
          </ButtonRow>
        </Field>
      )}
      {schedule !== null && (
        <Field label={t("schedules.form.improveLabel")} help={t("schedules.form.improveHelp")}>
          <ButtonRow>
            <Button variant="secondary" disabled={pending !== null || token === null} onClick={() => void improve()}>
              {t(pending === "improve" ? "schedules.form.improving" : "schedules.form.improve")}
            </Button>
          </ButtonRow>
        </Field>
      )}
      {problem !== null && <Notice tone="bad">{problem}</Notice>}
      {improvement !== null && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <KeyValue stacked items={[{ key: "old", term: t("schedules.form.improveOld"), value: <span className="whitespace-pre-wrap">{improvement.old}</span> }]} />
            <KeyValue stacked items={[{ key: "new", term: t("schedules.form.improveNew"), value: <span className="whitespace-pre-wrap">{improvement.new}</span> }]} />
          </div>
          <ButtonRow>
            <Button variant="ghost" onClick={() => setImprovement(null)}>{t("schedules.form.keepMine")}</Button>
            <Button variant="secondary" onClick={useRevised}>{t("schedules.form.useThis")}</Button>
          </ButtonRow>
        </>
      )}
      <Field label={t("schedules.form.title")} htmlFor={id("title")}>
        <Input id={id("title")} {...changedProps(marked, "title")} value={v.title} onChange={(e) => set("title", e.target.value)} />
      </Field>
      <Field label={t("schedules.form.cadence")} htmlFor={id("cadence")}>
        <div {...markedBox(marked, "cadence")}><Select id={id("cadence")} value={v.cadence} onChange={(e) => set("cadence", e.target.value as CadenceKind)}>
          {CADENCE_KINDS.map((k) => <option key={k} value={k}>{t(CADENCE_CHOICE[k])}</option>)}
        </Select></div>
      </Field>
      <Field label={t("schedules.form.spec")} htmlFor={id("spec")} help={t(SPEC_HELP[v.cadence])}>
        <Input id={id("spec")} {...changedProps(marked, "spec")} value={v.spec} onChange={(e) => set("spec", e.target.value)} />
      </Field>
      <Field label={t("schedules.form.zone")} htmlFor={id("zone")} help={t("schedules.form.zoneHelp")}>
        <Input id={id("zone")} {...changedProps(marked, "zone")} value={v.zone} onChange={(e) => set("zone", e.target.value)} />
      </Field>
      <Field label={t("schedules.form.action")} htmlFor={id("action")}>
        <div {...markedBox(marked, "action")}><Select id={id("action")} value={v.action} onChange={(e) => set("action", e.target.value as ActionKind)}>
          {ACTION_KINDS.map((k) => <option key={k} value={k}>{t(ACTION_TEXT[k])}</option>)}
          {!isWritableKind(stored) && <option value={stored} disabled>{t(ACTION_TEXT[stored])}</option>}
        </Select></div>
      </Field>
      <Field label={t("schedules.form.body")} htmlFor={id("body")} help={t(!isWritableKind(v.action) ? "schedules.form.bodyNone" : v.action === "build" ? "schedules.form.bodyBuild" : "schedules.form.bodyPrompt")}>
        <Textarea id={id("body")} {...changedProps(marked, "body")} rows={5} value={v.body} disabled={!isWritableKind(v.action)} onChange={(e) => set("body", e.target.value)} />
      </Field>
      <Field label={t("schedules.missed")} htmlFor={id("missed")}>
        <Select id={id("missed")} value={v.missed} onChange={(e) => set("missed", e.target.value as MissedRule)}>
          {MISSED_RULES.map((r) => <option key={r} value={r}>{t(MISSED_TEXT[r])}</option>)}
        </Select>
      </Field>
      {offerRunNow && (
        <Field label={t("schedules.form.runNow")} htmlFor={id("runNow")}>
          <Switch id={id("runNow")} checked={runNow} onCheckedChange={setRunNow} />
        </Field>
      )}
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
