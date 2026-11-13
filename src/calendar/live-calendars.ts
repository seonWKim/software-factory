// The calendars a process syncs, live (design 08-settings, 2026-11-13): the `calendar` setting names them, and each
// process's LiveSettings hands this holder the list after every refresh. A name that joins is built then, its secrets
// read fresh from the secret file, so a calendar connected from the dashboard or the terminal syncs from the next tick
// with no restart; a name that leaves is dropped. Only a cache of built sources: a restart rebuilds it from the setting.

import type { CalendarFeed, NamedFeed } from "./calendar-sync.js";

export interface LiveCalendarsLog {
  warn(msg: string, fields: Record<string, string>): void;
}

export class LiveCalendars {
  /** The feeds the sync reads, in the setting's order. Changed in place, so a holder of this array sees each change. */
  readonly feeds: NamedFeed[] = [];
  private names: readonly string[] = [];

  constructor(
    private readonly build: (name: string) => Promise<CalendarFeed>,
    private readonly log: LiveCalendarsLog,
  ) {}

  /** Rebuilds the feeds when `names` differ from the last list: kept names keep their source, new ones are built. */
  async apply(names: readonly string[]): Promise<void> {
    if (names.length === this.names.length && names.every((n, i) => n === this.names[i])) return;
    this.names = [...names];
    const next: NamedFeed[] = [];
    for (const name of names) {
      const kept = this.feeds.find((f) => f.name === name);
      if (kept) {
        next.push(kept);
        continue;
      }
      try {
        next.push({ name, source: await this.build(name) });
      } catch (err) {
        // Not retried until the list changes: a bad name logs once, and the other calendars still sync.
        this.log.warn("calendar source could not be built; it is not synced", { source: name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.feeds.splice(0, this.feeds.length, ...next);
  }
}
