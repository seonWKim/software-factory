// Schedule cadences (design 08-schedules): when a schedule is next due, as wall-clock time in the schedule's own
// zone (an IANA name), so a daily 09:00 stays 09:00 across a daylight-saving change. Four kinds, as stored
// (`cadence_kind`, `cadence_spec`): `interval` (every N minutes from the schedule's creation), `daily` (`HH:MM`),
// `weekly` (`mon,fri HH:MM`) and `cron` (5 fields: minute hour day-of-month month day-of-week). Daily and weekly
// are written as cron rules, so one hand-written parser and one search serve all three; no package. Pure: time
// comes in as arguments.

export const CADENCE_KINDS = ["interval", "daily", "weekly", "cron"] as const;
export type CadenceKind = (typeof CADENCE_KINDS)[number];
export interface Cadence { kind: CadenceKind; spec: string }

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** How far a cron search looks: 28 years holds every weekday of every 29 February. */
const SEARCH_DAYS = 366 * 28;
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

interface CronField { values: number[]; star: boolean }
interface CronRule { minutes: number[]; hours: number[]; days: Set<number>; months: Set<number>; weekdays: Set<number>; anyDay: boolean; anyWeekday: boolean }

/** One field: `*`, `n`, `a-b`, each with an optional `/step`, comma-separated; `names` map words to their index + `base`. */
function field(text: string, min: number, max: number, names: readonly string[] = [], base = 0): CronField | string {
  const value = (s: string) => (/^\d+$/.test(s) ? Number(s) : names.indexOf(s.toLowerCase()) >= 0 ? names.indexOf(s.toLowerCase()) + base : NaN);
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i.exec(part);
    if (!m) return `"${part}" is not a cron field`;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    const [from, to] = m[1] === "*" ? [min, max] : m[1]!.includes("-") ? m[1]!.split("-").map(value) : [value(m[1]!), m[2] === undefined ? value(m[1]!) : max];
    if (!(from! >= min && to! <= max && from! <= to! && step >= 1)) return `"${part}" is outside ${min}-${max}`;
    for (let v = from!; v <= to!; v += step) out.add(v);
  }
  return { values: [...out].sort((a, b) => a - b), star: text.startsWith("*") };
}

function cronRule(expr: string): CronRule | string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return `a cron cadence has 5 fields, not ${parts.length}`;
  const [mi, h, dom, mon, dow] = [field(parts[0]!, 0, 59), field(parts[1]!, 0, 23), field(parts[2]!, 1, 31), field(parts[3]!, 1, 12, MONTH_NAMES, 1), field(parts[4]!, 0, 7, DAY_NAMES)];
  for (const f of [mi, h, dom, mon, dow]) if (typeof f === "string") return f;
  const [minutes, hours, days, months, weekdays] = [mi, h, dom, mon, dow] as CronField[];
  return {
    minutes: minutes!.values, hours: hours!.values, days: new Set(days!.values), months: new Set(months!.values),
    weekdays: new Set(weekdays!.values.map((d) => d % 7)), anyDay: days!.star, anyWeekday: weekdays!.star,
  };
}

/** `HH:MM` as cron's minute and hour fields. */
function clock(at: string): string | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  return m ? `${Number(m[2])} ${Number(m[1])}` : null;
}

/** The cron rule of a daily, weekly or cron cadence; a problem as text. */
function ruleOf(c: Cadence): CronRule | string {
  if (c.kind === "cron") return cronRule(c.spec);
  if (c.kind === "daily") {
    const at = clock(c.spec.trim());
    return at ? cronRule(`${at} * * *`) : `a daily cadence is HH:MM, not "${c.spec}"`;
  }
  const m = /^([a-z,]+)\s+(\S+)$/i.exec(c.spec.trim());
  const at = m ? clock(m[2]!) : null;
  if (!m || !at || !m[1]!.split(",").every((d) => DAY_NAMES.includes(d.toLowerCase()))) return `a weekly cadence is days and HH:MM (mon,fri 09:00), not "${c.spec}"`;
  return cronRule(`${at} * * ${m[1]}`);
}

const intervalMinutes = (spec: string) => (/^\d+$/.test(spec.trim()) && Number(spec) >= 1 ? Number(spec) : null);

const formats = new Map<string, Intl.DateTimeFormat>();
function format(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formats.set(zone, f);
  }
  return f;
}

/** The wall clock of instant `t` in `zone`, as the UTC instant with the same fields. */
function wall(t: number, zone: string): number {
  const p = Object.fromEntries(format(zone).formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}

const offset = (t: number, zone: string) => wall(t, zone) - Math.floor(t / 1000) * 1000;

/**
 * The instant of wall time `local` (as a UTC instant with the same fields) in `zone`. A time a fall-back change
 * shows twice is its first instant; a time a spring-forward change skips is shifted forward by the gap.
 */
function instant(local: number, zone: string): number {
  const before = local - offset(local - DAY_MS, zone);
  const after = local - offset(local + DAY_MS, zone);
  const exact = [before, after].filter((t) => wall(t, zone) === local);
  return exact.length > 0 ? Math.min(...exact) : before;
}

function nextCron(rule: CronRule, zone: string, after: number): number | null {
  const start = wall(after, zone);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = new Date(Math.floor(start / DAY_MS) * DAY_MS + i * DAY_MS);
    if (!rule.months.has(day.getUTCMonth() + 1)) continue;
    const dom = rule.days.has(day.getUTCDate()), dow = rule.weekdays.has(day.getUTCDay());
    if (!(rule.anyDay && rule.anyWeekday ? true : rule.anyDay ? dow : rule.anyWeekday ? dom : dom || dow)) continue;
    // A day with an offset change can reorder its instants, so it takes the earliest; any other day the first.
    const changes = offset(day.getTime() - DAY_MS, zone) !== offset(day.getTime() + 2 * DAY_MS, zone);
    let best: number | null = null;
    for (const h of rule.hours) for (const m of rule.minutes) {
      const t = instant(day.getTime() + h * 3_600_000 + m * MINUTE_MS, zone);
      if (t > after && (best === null || t < best)) {
        best = t;
        if (!changes) return best;
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/** What is wrong with a cadence and zone, or null when a schedule can use them. */
export function cadenceProblem(c: Cadence, zone: string): string | null {
  try {
    format(zone);
  } catch {
    return `"${zone}" is not a time zone`;
  }
  if (!(CADENCE_KINDS as readonly string[]).includes(c.kind)) return `"${c.kind}" is not a cadence (${CADENCE_KINDS.join(", ")})`;
  if (c.kind === "interval") return intervalMinutes(c.spec) === null ? `an interval cadence is whole minutes, not "${c.spec}"` : null;
  const rule = ruleOf(c);
  return typeof rule === "string" ? rule : null;
}

/**
 * The first due time strictly after `after`, in `zone`; null when the cadence never falls due again. An interval
 * counts from `anchor` (the schedule's creation), so its slots stay where they were whenever this is asked.
 * Throws on a cadence `cadenceProblem` refuses.
 */
export function nextDue(c: Cadence, zone: string, after: Date, anchor: Date): Date | null {
  const problem = cadenceProblem(c, zone);
  if (problem) throw new Error(problem);
  if (c.kind === "interval") {
    const every = intervalMinutes(c.spec)! * MINUTE_MS;
    return new Date(anchor.getTime() + (Math.floor((after.getTime() - anchor.getTime()) / every) + 1) * every);
  }
  const t = nextCron(ruleOf(c) as CronRule, zone, after.getTime());
  return t === null ? null : new Date(t);
}
