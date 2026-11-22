// `factory calendar sync --from YYYY-MM-DD --to YYYY-MM-DD` (design 02-tasks-calendar, 2026-11-22): the dashboard's
// Sync from the terminal. It stores the same request POST /api/v1/calendar/sync stores, with the same range check
// (one pending request per range: a second one waits on the first), then waits on ticks for the controller's
// calendar unit to run it, up to WAIT_MS. It prints each source's event count or stored error; the exit code is 1
// when a source failed or the wait ended first. Time comes only from the TickGenerator it is handed. One file, so
// the command imports the calendar component once (the kinds ratchet, RFC 0023 R1).

import { type SyncRequest, calendarSql, rangeError, readSyncRequest, requestCalendarSync } from "../../../calendar/index.js";
import { TimeBasedTickGenerator } from "../../../shared/ticks/plugins/time-based/time-based-tick-generator.js";
import type { TickGenerator } from "../../../shared/ticks/tick-generator.js";
import type { SqlDriver } from "../../../state/index.js";
import { defineCommand } from "../../command.js";

export const CALENDAR_SYNC_USAGE = "usage: factory calendar sync --from YYYY-MM-DD --to YYYY-MM-DD";
/** How long the command waits for the controller to finish the request. */
export const WAIT_MS = 2 * 60_000;
/** How often it reads the request while it waits. */
export const WAIT_TICK_MS = 2_000;
/** The tick schedule the wait runs on. */
export const WAIT_SCHEDULE = "calendar-sync-wait";

/** `sync --from <date> --to <date>` (either order of the flags), or why not; the dates are checked by rangeError. */
export function parseCalendarArgs(args: readonly string[]): { from: string; to: string } | { error: string } {
  if (args[0] !== "sync") return { error: args[0] === undefined ? "factory calendar needs a subcommand" : `unknown subcommand "${args[0]}"` };
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const [flag, value] = [args[i]!, args[i + 1]];
    if (flag !== "--from" && flag !== "--to") return { error: `unknown argument "${flag}"` };
    if (value === undefined) return { error: `${flag} needs a date` };
    flags.set(flag, value);
  }
  const [from, to] = [flags.get("--from") ?? null, flags.get("--to") ?? null];
  const error = rangeError(from, to);
  return error === null ? { from: from!, to: to! } : { error };
}

export interface CalendarSyncRun {
  readonly db: SqlDriver;
  /** The CLI identity's user ID, stored as who asked. */
  readonly by: string;
  readonly ticks: TickGenerator;
  print(line: string): void;
  error(line: string): void;
}

/** Stores the request on the first tick, then reads it on each tick until it is done or WAIT_MS pass. The exit code. */
export async function runCalendarSync(d: CalendarSyncRun, range: { from: string; to: string }): Promise<number> {
  const stop = new AbortController();
  let code = 1;
  let wait: { id: string; until: number } | null = null;
  d.ticks.schedule(WAIT_SCHEDULE, WAIT_TICK_MS, async (tick) => {
    if (stop.signal.aborted) return;
    try {
      code = await step(Date.parse(tick.now));
    } catch (err) {
      d.error(`calendar sync failed: ${err instanceof Error ? err.message : String(err)}`);
      stop.abort();
    }
  });
  /** One tick of the wait: the exit code so far (1 until the request is done). */
  async function step(now: number): Promise<number> {
    if (wait === null) {
      const { request, created } = await requestCalendarSync(d.db, { ...range, by: d.by, nowMs: now });
      wait = { id: request.id, until: now + WAIT_MS };
      d.print(`${created ? "Sync requested" : "A sync is pending already"} for ${range.from} through ${range.to}; waiting for the controller (up to 2 minutes).`);
    }
    const r = await readSyncRequest(d.db, wait.id);
    if (r !== null && r.done_at !== null) {
      stop.abort();
      return report(d, r);
    }
    if (now >= wait.until) {
      d.error("The controller did not finish the sync within 2 minutes: is the factory running with a calendar connected? The request stays and runs on its next poll.");
      stop.abort();
    }
    return 1;
  }
  await d.ticks.run(stop.signal);
  return code;
}

/** One line per source; 1 when any failed or none was read. */
function report(d: CalendarSyncRun, r: SyncRequest): number {
  const results = r.results ?? [];
  if (results.length === 0) {
    d.error("No calendar was read: no calendar is connected.");
    return 1;
  }
  for (const s of results) {
    if (s.ok) d.print(`${s.source}: ${s.events} ${s.events === 1 ? "event" : "events"}`);
    else d.error(`${s.source}: failed: ${s.error}`);
  }
  return results.every((s) => s.ok) ? 0 : 1;
}

export default defineCommand({
  names: ["calendar"],
  usage: `  calendar sync --from YYYY-MM-DD --to YYYY-MM-DD
               sync every connected calendar now for the local days from through to (at most 62 days; past days
               too), as the Calendar page's Sync does: stores the request, waits up to 2 minutes for the running
               factory's controller to read it, and prints each calendar's event count or error. Exit 1 when a
               calendar failed or the wait ended first. Connect calendars with \`factory setup\``,
  async run(args, ctx) {
    // The range is checked before the store opens.
    const range = parseCalendarArgs(args);
    if ("error" in range) {
      console.error(`${range.error}\n${CALENDAR_SYNC_USAGE}`);
      return 1;
    }
    // An ID, never a display name: the CLI identity, stored as who asked.
    const { user } = await ctx.identity();
    return ctx.withStore(async (store) =>
      runCalendarSync({ db: calendarSql(store), by: user, ticks: new TimeBasedTickGenerator(), print: console.log, error: console.error }, range),
    );
  },
});
