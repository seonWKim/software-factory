# CalendarSource

What it does: reads the owner's calendars, so the factory keeps a copy of their events beside the tasks (design [02-tasks.md](../design/02-tasks.md), calendar). A source only reads: the factory never creates, edits or deletes an event.

The interface (`src/interfaces/calendar-source.ts`) has one call, `events({ from, to })`: every event that overlaps the window, each with `id` (the source's own, stable and unique within the source), `title`, `starts_at`, `ends_at` (ISO 8601 instants), `all_day` and `updated_at` (null when the source reports none). A throw is that sync's error.

**Config.** The top-level key `calendar` is a list of CalendarSource plugin names, in order, never a `plugins` key:

```jsonc
"calendar": []          // the default: no source, nothing is read
"calendar": ["<name>"]  // once a provider ships
```

Absent or `[]`: no source is built and no calendar data is read or stored. A value that is not a list, a name listed twice, or a name no plugin has fails startup with an error that names `calendar` and the available plugins (`none` today). `calendar` under `plugins` fails too, pointing to the top-level key. A plugin's context is the base context and the `SecretStore`, for a provider's credentials.

**Cadence.** The controller's `calendar` unit runs each poll; each configured source syncs **at most once every 5 minutes**. Its next sync time is stored per source in `calendar_sync_state` and taken by a conditional write, so every replica keeps one schedule and two never read one source in the same period. A sync asks for the window from one day back to 30 days ahead and replaces the source's rows in `calendar_events`, keyed by source name and event ID. A failed read stores its error (cut to 1000 characters) and time on the source's state row, keeps the source's last events, waits for the next due time, and is cleared by the next success.

Plugins:

- None yet. No calendar provider (Google, Outlook, iCal or another) ships in this phase; tests register fake sources only (`tests/calendar/`).

Turn on / off: list plugin names in `calendar` (on, once a provider exists); set `[]` or delete the key (off). Stored events and state rows stay until a later change removes them.

## History

- 2026-11-12: the interface, the `calendar` config key and the sync added, with no provider. Before, the factory had no calendar.
