import { type DueDay, type Recurrence, type TaskEdit, type TaskFields, type TaskPriority, durationError } from "./tasks.js";

/**
 * The quick-add parser (design 02-tasks, issue #606): `factory task add <words>` picks these tokens out of the
 * words, in any order, and the words left are the title:
 * - `today`, `tomorrow`, `YYYY-MM-DD`: the due day (today and tomorrow are resolved later, by the store's Clock);
 * - `HH:MM`, or `3pm`, `3:30pm`, `12am`: the due time (alone: due today); `at` right before a time is read with it,
 *   and anywhere else is a title word;
 * - `45m`, `1h`, `1h30m`: the duration (1 minute to a day; none given: DEFAULT_DURATION_MINUTES when planned);
 * - `!1` to `!3`: the priority, 1 the highest;
 * - `#label`: the list;
 * - `every day`, `every week`, `every month`: the recurrence, which needs a due day.
 * Each field at most once. Pure: no clock, no I/O. `task edit` reads the same words (`parseQuickEdit`), naming only
 * the fields they give.
 */

export type QuickAddResult = { ok: true; task: TaskFields } | { ok: false; reason: string };
export type QuickEditResult = { ok: true; edit: TaskEdit } | { ok: false; reason: string };

const RECURRENCES: readonly Recurrence[] = ["day", "week", "month"];

/** A real calendar date, `YYYY-MM-DD`. */
export function validDate(s: string): boolean {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const pad = (n: number) => String(n).padStart(2, "0");
const TIME_24 = /^\d{1,2}:\d{2}$/;
const TIME_12 = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/i;
const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?$/i;

/** A time token as `HH:MM`, a reason when it looks like a time but is none (13pm, 12:61pm, 25:00), or null when it is no time token. */
function readTime(w: string): string | { refused: string } | null {
  if (TIME_24.test(w)) {
    const [h, m] = w.split(":").map(Number) as [number, number];
    return h > 23 || m > 59 ? { refused: `not a time: ${w}` } : `${pad(h)}:${pad(m)}`;
  }
  const t = TIME_12.exec(w);
  if (t === null) return null;
  const h = Number(t[1]);
  const m = t[2] === undefined ? 0 : Number(t[2]);
  if (h < 1 || h > 12 || m > 59) return { refused: `not a time: ${w} (use 1 to 12 with am or pm, e.g. 3pm or 3:30pm)` };
  return `${pad((h % 12) + (t[3]!.toLowerCase() === "pm" ? 12 : 0))}:${pad(m)}`;
}

/** A duration token in minutes, a reason when it is out of range (0m, 25h), or null when it is no duration token. */
function readDuration(w: string): number | { refused: string } | null {
  const d = w === "" ? null : DURATION.exec(w);
  if (d === null || (d[1] === undefined && d[2] === undefined)) return null;
  const minutes = Number(d[1] ?? 0) * 60 + Number(d[2] ?? 0);
  const error = durationError(minutes);
  return error === null ? minutes : { refused: `${error}, not ${w}` };
}

/** The fields the words give (the title: the words left, "" when none), or the reason they are refused. */
function scan(words: string): { ok: true; edit: TaskEdit; title: string } | { ok: false; reason: string } {
  const tokens = words.trim().split(/\s+/).filter((w) => w !== "");
  const title: string[] = [];
  let due: DueDay | null = null;
  let due_time: string | null = null;
  let duration_minutes: number | null = null;
  let priority: TaskPriority | null = null;
  let list: string | null = null;
  let recurrence: Recurrence | null = null;
  const seen = new Set<string>();
  const once = (field: string): string | null => {
    if (seen.has(field)) return `repeated field: ${field} given twice`;
    seen.add(field);
    return null;
  };
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i]!;
    const lower = w.toLowerCase();
    let refused: string | null = null;
    if (lower === "today" || lower === "tomorrow") {
      refused = once("due date");
      due = { days_from_today: lower === "today" ? 0 : 1 };
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(w)) {
      if (!validDate(w)) return { ok: false, reason: `not a date: ${w}` };
      refused = once("due date");
      due = { date: w };
    } else if (readTime(w) !== null || (lower === "at" && readTime(tokens[i + 1] ?? "") !== null)) {
      // `at` is read only with the time after it.
      const time = readTime(lower === "at" && readTime(w) === null ? tokens[++i]! : w)!;
      if (typeof time !== "string") return { ok: false, reason: time.refused };
      refused = once("due time");
      due_time = time;
    } else if (readDuration(w) !== null) {
      const minutes = readDuration(w)!;
      if (typeof minutes !== "number") return { ok: false, reason: minutes.refused };
      refused = once("duration");
      duration_minutes = minutes;
    } else if (/^!\d+$/.test(w)) {
      const p = Number(w.slice(1));
      if (p < 1 || p > 3) return { ok: false, reason: `priority must be !1, !2 or !3, not ${w}` };
      refused = once("priority");
      priority = p as TaskPriority;
    } else if (/^#[\w-]+$/.test(w)) {
      refused = once("list");
      list = w.slice(1);
    } else if (lower === "every") {
      const next = tokens[i + 1]?.toLowerCase();
      if (next === undefined || !(RECURRENCES as readonly string[]).includes(next)) {
        return { ok: false, reason: `unknown recurrence: every ${next ?? ""}`.trim() + " (use every day, every week or every month)" };
      }
      refused = once("recurrence");
      recurrence = next as Recurrence;
      i++;
    } else title.push(w);
    if (refused !== null) return { ok: false, reason: refused };
  }
  const edit: TaskEdit = {};
  if (title.length > 0) edit.title = title.join(" ");
  if (due !== null) edit.due = due;
  if (due_time !== null) edit.due_time = due_time;
  if (duration_minutes !== null) edit.duration_minutes = duration_minutes;
  if (priority !== null) edit.priority = priority;
  if (list !== null) edit.list = list;
  if (recurrence !== null) edit.recurrence = recurrence;
  return { ok: true, edit, title: title.join(" ") };
}

/** Why a recurrence with no due date is refused, by quick-add and by an edit. */
export const needsDueDate = (every: Recurrence) => `every ${every} needs a due date (today, tomorrow or YYYY-MM-DD)`;

export function parseQuickAdd(words: string): QuickAddResult {
  const s = scan(words);
  if (!s.ok) return s;
  if (s.title === "") return { ok: false, reason: "the title is empty: give some words besides the quick-add tokens" };
  const { due = null, due_time = null, duration_minutes = null, priority = null, list = null, recurrence = null } = s.edit;
  const day: DueDay | null = due === null && due_time !== null ? { days_from_today: 0 } : due;
  if (recurrence !== null && day === null) return { ok: false, reason: needsDueDate(recurrence) };
  return { ok: true, task: { title: s.title, list, priority, due: day, due_time, duration_minutes, recurrence } };
}

/** The fields an edit's words name, and only those: words with no title leave the title out. No words: refused. */
export function parseQuickEdit(words: string): QuickEditResult {
  const s = scan(words);
  if (!s.ok) return s;
  if (Object.keys(s.edit).length === 0) return { ok: false, reason: "nothing to change: give quick-add words or a new title" };
  return { ok: true, edit: s.edit };
}
