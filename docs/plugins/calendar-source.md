# CalendarSource

What it does: reads the owner's calendars, so the factory keeps a copy of their events beside the tasks (design [02-tasks.md](../design/02-tasks.md), calendar). A source only reads: the factory never creates, edits or deletes an event.

The interface (`src/interfaces/calendar-source.ts`) has one call, `events({ from, to })`: every event that overlaps the window, each with `id` (the source's own, stable and unique within the source), `title`, `starts_at`, `ends_at` (ISO 8601 instants), `all_day` and `updated_at` (null when the source reports none). A throw is that sync's error.

**Config.** The top-level key `calendar` is a list of CalendarSource plugin names, in order, never a `plugins` key:

```jsonc
"calendar": []          // the default: no source, nothing is read
"calendar": ["google-calendar"]  // read the owner's Google calendars
```

Absent or `[]`: no source is built and no calendar data is read or stored. A value that is not a list, a name listed twice, or a name no plugin has fails startup with an error that names `calendar` and the available plugins. `calendar` under `plugins` fails too, pointing to the top-level key. A plugin's context is the base context, the `SecretStore`, for a provider's credentials, and the `Clock`, for a provider that narrows the window to its own "today".

**Cadence.** The controller's `calendar` unit runs each poll; each configured source syncs **at most once every 5 minutes**. Its next sync time is stored per source in `calendar_sync_state` and taken by a conditional write, so every replica keeps one schedule and two never read one source in the same period. A sync asks for the window from one day back to 30 days ahead and replaces the source's rows in `calendar_events`, keyed by source name and event ID. A failed read stores its error (cut to 1000 characters) and time on the source's state row, keeps the source's last events, waits for the next due time, and is cleared by the next success. A down source never holds up the controller's other steps or a task action.

Plugins:

- `google-calendar`: Google Calendar, read-only (`src/calendar/plugins/google-calendar/`). Asks Google only for the `calendar.readonly` scope; its token refresh refuses an answer whose scope is anything else. Reads today through 14 days ahead: from the start of today to the end of the day 14 days ahead, "today" being the calendar date in the process's time zone (as in [02-tasks.md](../design/02-tasks.md)), with "now" from the `Clock` in its context. The sync's wider window (a day back to 30 days ahead) is narrowed to this one. Each HTTP call to Google, its body included, is given up after 30 seconds (`GOOGLE_HTTP_TIMEOUT_MS`) and throws "no answer", so a hung Google never holds up the controller's tick. A failed token refresh or read throws, so the sync stores the error and keeps the last events; an error names the step and the HTTP status, never a secret value or a response body.
  - Secrets: `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, read only through the `SecretStore`: an OAuth refresh token granted `calendar.readonly`, and the client it was issued to.
  - Config: the optional top-level key `calendar_ids`, a list of calendar IDs (`"calendar_ids": ["work@example.com"]`). Absent or `[]`: the `primary` calendar only. Listed: those calendars instead of the primary one, each event's ID then prefixed with its calendar ID when more than one is listed. A value that is not a list of non-empty strings fails startup.
  - Cache: the access token (until it expires), and per calendar the sync token, the last answer's ETag and the last events, all in process memory, never in the store. A read sends the stored sync token and the ETag as `If-None-Match`; a `304` reuses the stored events, and a `410` clears the sync token and runs a full read in the same sync. A new day moves the window and runs a full read. A restart, or another replica, loses the cache: that costs one full read.
  - Turn on: run `factory setup calendar google` (after `npm run setup`, which creates the secret file; with no secret file it stops and creates nothing). It reads `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the secret file, or asks for them once with hidden input (an OAuth client of type Desktop app, with the Google Calendar API enabled). It opens the browser to Google's consent page for `https://www.googleapis.com/auth/calendar.readonly` only, with a PKCE S256 challenge, a random state and a redirect to a listener on `127.0.0.1` that closes after 5 minutes. It refuses a wrong state, an error from Google, a token answer whose scope is not exactly `calendar.readonly`, or one with no refresh token: then nothing is written and it exits non-zero. Otherwise it writes the three secrets together to the secret file, shows the diff that adds `"google-calendar"` to `calendar` and writes it after a yes (other names stay), and runs one sync that prints how many events it read. No secret, token, code or verifier is printed or stored anywhere else; the consent URL shows the client ID.
  - Off: `factory setup calendar google --disconnect` removes the three secret lines from the secret file (other lines stay, mode 600) and, after a diff and a yes, drops `"google-calendar"` from `calendar` (other names stay; a key left empty is `[]`). It does not revoke the token at Google.

Turn on / off: list plugin names in `calendar` (on); set `[]` or delete the key (off). Stored events and state rows stay until a later change removes them.

## History

- 2026-11-12: `google-calendar` gives up an HTTP call after 30 seconds. Before, a sync waited on Google with no limit.

- 2026-11-12: `google-calendar` is turned on with `factory setup calendar google` and off with `--disconnect`. Before, the owner pasted the three secrets into the secret file and edited `calendar` by hand, and ran the OAuth consent outside the factory.

- 2026-11-12: `google-calendar` added, the first provider, with the `calendar_ids` key and the `Clock` in the plugin context. Before, no provider shipped and `calendar` could name none.

- 2026-11-12: the interface, the `calendar` config key and the sync added, with no provider. Before, the factory had no calendar.
