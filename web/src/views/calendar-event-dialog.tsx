import { useRef, useState } from "react";
import { API, type CalendarEvent, type CalendarEvents, type CopyResult, type CopyTarget, LOCAL_REPEATS, type LocalEventInput, type LocalRepeat, type Session, postLocalEventAdd, postLocalEventEdit, useApi } from "../api.js";
import { Dialog } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Select } from "../components/ui/select.js";
import { Switch } from "../components/ui/switch.js";
import { t } from "../i18n/index.js";

// The New event and Edit event dialog of the Calendar page (design 09-dashboard-tasks-calendar, New event): the shared
// Dialog with title, date, start and end time (or an all-day Switch and an end date), time zone and repeat. The date
// and times are entered in the chosen zone and sent as ISO instants; the zone only converts and is not stored. A
// refusal (empty title, end not after start) shows in the dialog's error line before anything is posted; so does the
// server's. Editing a repeating event locks its date, time and all-day: only the title and the repeat save, for the
// whole series (owner answer 1).
//
// A copy in a connected calendar (design 02-tasks-calendar, copy to a connected calendar): a new event's dialog ends
// with the Switch "Also add to <calendar>", the calendar the read's `copy` names; on with write access, off and
// read-only with the note to reconnect with write access otherwise; none with no such calendar. The dialog reads
// `copy` once from the one-day read of its date, so the Calendar page passes nothing new. An edit or a delete of a
// copied event changes its copy too (the server's). A copy that did not happen keeps the dialog open on its reason,
// the event already saved; an edited event shows its copy's last error.

const pad = (n: number) => String(n).padStart(2, "0");
const DAY_MS = 86_400_000;
const DEFAULT_START = "09:00";
const DEFAULT_END = "10:00";

/** `date` ("YYYY-MM-DD") moved by `n` days. */
function addDaysTo(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The wall-clock parts of the instant `ms` in `zone`, as a UTC timestamp of those parts. */
function wallMs(ms: number, zone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}

/** The instant (ISO) at which the clock in `zone` reads `date` `time`. */
function instantIn(date: string, time: string, zone: string): string {
  const want = Date.parse(`${date}T${time}:00Z`);
  let ms = want;
  // The zone's offset at the answer may differ from the guess's (a daylight saving change): two passes settle it.
  for (let i = 0; i < 2; i++) ms = want - (wallMs(ms, zone) - ms);
  return new Date(ms).toISOString();
}

/** The date and time the clock in `zone` reads at the instant `iso`. */
function partsIn(iso: string, zone: string): { date: string; time: string } {
  const d = new Date(wallMs(Date.parse(iso), zone));
  return { date: d.toISOString().slice(0, 10), time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}

/** The zones the picker offers: `first`, then every zone the browser knows. */
function zones(first: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [first, ...all.filter((z) => z !== first)];
}

const REPEAT_LABEL: Record<LocalRepeat, string> = {
  none: t("calendarEvent.repeatNone"),
  daily: t("calendarEvent.repeatDaily"),
  weekly: t("calendarEvent.repeatWeekly"),
  monthly: t("calendarEvent.repeatMonthly"),
};

/** A new client-made event id: `le_` and 32 hex digits, so a retried save stores one event. */
const newId = () => `le_${crypto.randomUUID().replaceAll("-", "")}`;

export type EventDialogTarget = { kind: "new"; date: string } | { kind: "edit"; event: CalendarEvent };

interface Props {
  target: EventDialogTarget;
  /** The read's time zone: the zone the date and times are entered in until the owner picks another. */
  zone: string;
  onClose: () => void;
  /** Runs after a save, before the dialog closes: the page re-reads so the event shows at once. */
  onSaved: () => Promise<unknown> | void;
}

/** The note above the dialog's button: a repeating event's series note, and an edited event's last copy error. */
function consequence(locked: boolean, event: CalendarEvent | null, copy: CopyTarget | null): string | undefined {
  const notes = [
    ...(locked ? [t("calendarEvent.seriesNote")] : []),
    ...(event?.sync_error ? [t("calendarCopy.error", { calendar: copy?.label ?? event.copied_to ?? "", error: event.sync_error })] : []),
  ];
  return notes.length > 0 ? notes.join(" ") : undefined;
}

/** The dialog's start values: a new event's day at 09:00 to 10:00, else the edited event's own date and times in `zone`. */
function initial(target: EventDialogTarget, zone: string) {
  if (target.kind === "new") return { title: "", date: target.date, start: DEFAULT_START, end: DEFAULT_END, span: 0, endDate: target.date, allDay: false, repeats: "none" as LocalRepeat };
  const e = target.event;
  const a = partsIn(e.starts_at, zone);
  const b = partsIn(e.ends_at, zone);
  const lastDay = e.all_day ? addDaysTo(b.date, b.time === "00:00" ? -1 : 0) : b.date;
  const span = Math.round((Date.parse(`${b.date}T00:00:00Z`) - Date.parse(`${a.date}T00:00:00Z`)) / DAY_MS);
  return { title: e.title, date: a.date, start: a.time, end: b.time, span, endDate: lastDay < a.date ? a.date : lastDay, allDay: e.all_day, repeats: e.repeats ?? "none" };
}

/** Why a new event's copy did not happen, for the dialog's error line; null when it did, or was not asked. */
function copyProblem(r: CopyResult, copy: CopyTarget | null): string | null {
  const calendar = copy?.label ?? "";
  if (r.state === "unavailable") return t("calendarCopy.unavailable", { reason: r.reason });
  if (r.state === "failed") return t("calendarCopy.failed", { calendar, error: r.error });
  return null;
}

export function EventDialog({ target, zone, onClose, onSaved }: Props) {
  const token = useApi<Session>(API.session, false).data?.csrf_token;
  const start = useRef(initial(target, zone)).current;
  const day = target.kind === "new" ? target.date : start.date;
  const copy = useApi<CalendarEvents>(API.calendarEvents(day, day), false).data?.copy ?? null;
  // On with write access, off with read-only; the owner's own choice once they flip it.
  const [syncChoice, setSync] = useState<boolean | null>(null);
  const sync = copy?.writable === true && (syncChoice ?? true);
  const id = useRef(target.kind === "edit" ? target.event.id : newId()).current;
  const [title, setTitle] = useState(start.title);
  const [date, setDate] = useState(start.date);
  const [startTime, setStartTime] = useState(start.start);
  const [endTime, setEndTime] = useState(start.end);
  const [endDate, setEndDate] = useState(start.endDate);
  const [allDay, setAllDay] = useState(start.allDay);
  const [zoneName, setZoneName] = useState(zone);
  const [repeats, setRepeats] = useState<LocalRepeat>(start.repeats);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const sending = useRef(false);
  const editing = target.kind === "edit";
  // A repeating event's date, time and all-day are fixed: only its title and repeat change, for the whole series.
  const locked = editing && target.event.repeats !== undefined && target.event.repeats !== "none";

  /** The fields to post, or the reason they are refused. */
  const fields = (): LocalEventInput | string => {
    if (title.trim() === "") return t("calendarEvent.errorTitle");
    if (allDay) {
      if (endDate < date) return t("calendarEvent.errorEndDate");
      return { title: title.trim(), starts_at: instantIn(date, "00:00", zoneName), ends_at: instantIn(addDaysTo(endDate, 1), "00:00", zoneName), all_day: true, repeats };
    }
    if (startTime === "" || endTime === "" || date === "") return t("calendarEvent.errorTime");
    const starts_at = instantIn(date, startTime, zoneName);
    const ends_at = instantIn(addDaysTo(date, start.span), endTime, zoneName);
    if (Date.parse(ends_at) <= Date.parse(starts_at)) return t("calendarEvent.errorEnd");
    return { title: title.trim(), starts_at, ends_at, all_day: false, repeats };
  };

  const save = async () => {
    if (saved) return onClose();
    if (sending.current || !token) return;
    const f = locked ? { title: title.trim(), repeats } : fields();
    if (typeof f === "string") return setError(f);
    if (locked && title.trim() === "") return setError(t("calendarEvent.errorTitle"));
    sending.current = true;
    setSaving(true);
    setError(null);
    try {
      const r = editing ? await postLocalEventEdit(token, id, f) : await postLocalEventAdd(token, id, f as LocalEventInput, sync);
      if (!r.ok) return setError(r.error);
      await onSaved();
      // Saved here; a copy that did not happen keeps the dialog open on why, and its button then closes it.
      const problem = copyProblem(r.sync, copy);
      if (problem === null) return onClose();
      setSaved(true);
      setError(problem);
    } finally {
      sending.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={t(editing ? "calendarEvent.editTitle" : "calendarEvent.newTitle")}
      confirmLabel={t(editing ? "calendarEvent.save" : "calendarEvent.add")}
      confirmDisabled={saving || !token}
      error={error}
      onConfirm={() => void save()}
      onClose={onClose}
      consequence={consequence(locked, editing ? target.event : null, copy)}
    >
      <Field label={t("calendarEvent.title")} htmlFor="event-title">
        <Input id="event-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label={t("calendarEvent.date")} htmlFor="event-date">
        <Input id="event-date" type="date" value={date} disabled={locked} onChange={(e) => { setDate(e.target.value); if (endDate < e.target.value) setEndDate(e.target.value); }} />
      </Field>
      <Field label={t("calendarEvent.allDay")}>
        <Switch aria-label={t("calendarEvent.allDay")} checked={allDay} disabled={locked} onCheckedChange={setAllDay} />
      </Field>
      {allDay ? (
        <Field label={t("calendarEvent.endDate")} htmlFor="event-end-date">
          <Input id="event-end-date" type="date" value={endDate} disabled={locked} onChange={(e) => setEndDate(e.target.value)} />
        </Field>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("calendarEvent.start")} htmlFor="event-start">
            <Input id="event-start" type="time" value={startTime} disabled={locked} onChange={(e) => setStartTime(e.target.value)} />
          </Field>
          <Field label={t("calendarEvent.end")} htmlFor="event-end">
            <Input id="event-end" type="time" value={endTime} disabled={locked} onChange={(e) => setEndTime(e.target.value)} />
          </Field>
        </div>
      )}
      <Field label={t("calendarEvent.zone")} htmlFor="event-zone" help={t("calendarEvent.zoneHelp")}>
        <Select id="event-zone" value={zoneName} disabled={locked} wrapperClassName="w-full" onChange={(e) => setZoneName(e.target.value)}>
          {zones(zone).map((z) => <option key={z} value={z}>{z}</option>)}
        </Select>
      </Field>
      <Field label={t("calendarEvent.repeat")} htmlFor="event-repeat">
        <Select id="event-repeat" value={repeats} wrapperClassName="w-full" onChange={(e) => setRepeats(e.target.value as LocalRepeat)}>
          {LOCAL_REPEATS.map((r) => <option key={r} value={r}>{REPEAT_LABEL[r]}</option>)}
        </Select>
      </Field>
      {!editing && copy !== null && (
        <Field label={t("calendarCopy.switch", { calendar: copy.label })} help={copy.writable ? undefined : t("calendarCopy.readOnly", { calendar: copy.label })}>
          <Switch aria-label={t("calendarCopy.switch", { calendar: copy.label })} checked={sync} readOnly={!copy.writable} disabled={saved} onCheckedChange={setSync} />
        </Field>
      )}
    </Dialog>
  );
}
