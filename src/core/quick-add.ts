import type { DueDay, Recurrence, TaskFields, TaskPriority } from "./tasks.js";

/**
 * The quick-add parser (design 02-tasks, issue #606): `factory task add <words>` picks these tokens out of the
 * words, in any order, and the words left are the title:
 * - `today`, `tomorrow`, `YYYY-MM-DD`: the due day (today and tomorrow are resolved later, by the store's Clock);
 * - `HH:MM`: the due time, 24-hour (alone: due today);
 * - `!1` to `!3`: the priority, 1 the highest;
 * - `#label`: the list;
 * - `every day`, `every week`, `every month`: the recurrence, which needs a due day.
 * Each field at most once. Pure: no clock, no I/O.
 */

export type QuickAddResult = { ok: true; task: TaskFields } | { ok: false; reason: string };

const RECURRENCES: readonly Recurrence[] = ["day", "week", "month"];

/** A real calendar date, `YYYY-MM-DD`. */
function validDate(s: string): boolean {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function parseQuickAdd(words: string): QuickAddResult {
  const tokens = words.trim().split(/\s+/).filter((w) => w !== "");
  const title: string[] = [];
  let due: DueDay | null = null;
  let due_time: string | null = null;
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
    } else if (/^\d{1,2}:\d{2}$/.test(w)) {
      const [h, m] = w.split(":").map(Number) as [number, number];
      if (h > 23 || m > 59) return { ok: false, reason: `not a time: ${w}` };
      refused = once("due time");
      due_time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
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
  if (title.length === 0) return { ok: false, reason: "the title is empty: give some words besides the quick-add tokens" };
  if (due === null && due_time !== null) due = { days_from_today: 0 };
  if (recurrence !== null && due === null) return { ok: false, reason: `every ${recurrence} needs a due date (today, tomorrow or YYYY-MM-DD)` };
  return { ok: true, task: { title: title.join(" "), list, priority, due, due_time, recurrence } };
}
