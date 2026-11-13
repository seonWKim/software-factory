# CalendarSource

What it does: reads the owner's calendars, so the factory keeps a copy of their events beside the tasks (design [02-tasks.md](../design/02-tasks.md), calendar). A source only reads: the factory never creates, edits or deletes an event.

The interface (`src/interfaces/calendar-source.ts`) has one call, `events({ from, to })`: every event that overlaps the window, each with `id` (the source's own, stable and unique within the source), `title`, `starts_at`, `ends_at` (ISO 8601 instants), `all_day` and `updated_at` (null when the source reports none). A throw is that sync's error.

**Config.** The top-level key `calendar` is a list of CalendarSource plugin names, in order, never a `plugins` key:

```jsonc
"calendar": []          // the default: no source, nothing is read
"calendar": ["google-calendar"]  // read the owner's Google calendars
```

Absent or `[]`: no source is built and no calendar data is read or stored. The runtime setting `calendar` (owner only, design [08-settings.md](../design/08-settings.md)), which connect and disconnect write, overrides the file's key and applies at the controller's next tick with no restart; with no override the file decides. A value that is not a list, a name listed twice, or a name no plugin has fails startup with an error that names `calendar` and the available plugins. `calendar` under `plugins` fails too, pointing to the top-level key. A plugin's context is the base context, the `SecretStore`, for a provider's credentials, and the `Clock`, for a provider that narrows the window to its own "today".

**Cadence.** The controller's `calendar` unit runs each poll; each configured source syncs **at most once every 5 minutes**. Its next sync time is stored per source in `calendar_sync_state` and taken by a conditional write, so every replica keeps one schedule and two never read one source in the same period. A sync asks for the window from one day back to 30 days ahead and replaces the source's rows in `calendar_events`, keyed by source name and event ID. A failed read stores its error (cut to 1000 characters) and time on the source's state row, keeps the source's last events, waits for the next due time, and is cleared by the next success. A down source never holds up the controller's other steps or a task action.

Plugins:

- `google-calendar`: Google Calendar, read-only (`src/calendar/plugins/google-calendar/`). Asks Google only for the `calendar.readonly` scope; its token refresh refuses an answer whose scope is anything else. Reads today through 14 days ahead: from the start of today to the end of the day 14 days ahead, "today" being the calendar date in the process's time zone (as in [02-tasks.md](../design/02-tasks.md)), with "now" from the `Clock` in its context. The sync's wider window (a day back to 30 days ahead) is narrowed to this one. Each HTTP call to Google, its body included, is given up after 30 seconds (`GOOGLE_HTTP_TIMEOUT_MS`) and throws "no answer", so a hung Google never holds up the controller's tick; the connect's token exchange takes the same limit, on the context's `Clock`, so a hung exchange fails with "no answer" and writes nothing. A failed token refresh or read throws, so the sync stores the error and keeps the last events; an error names the step and the HTTP status, never a secret value or a response body.
  - Secrets: `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, read only through the `SecretStore`: an OAuth refresh token granted `calendar.readonly`, and the client it was issued to.
  - Config: the optional top-level key `calendar_ids`, a list of calendar IDs (`"calendar_ids": ["work@example.com"]`). Absent or `[]`: the `primary` calendar only. Listed: those calendars instead of the primary one, each event's ID then prefixed with its calendar ID when more than one is listed. A value that is not a list of non-empty strings fails startup.
  - Cache: the access token (until it expires), and per calendar the sync token, the last answer's ETag and the last events, all in process memory, never in the store. A read sends the stored sync token and the ETag as `If-None-Match`; a `304` reuses the stored events, and a `410` clears the sync token and runs a full read in the same sync. A new day moves the window and runs a full read. A restart, or another replica, loses the cache: that costs one full read.
  - Turn on, from the dashboard: Settings → Calendar lists each calendar plugin with a connect hook (from the registry), connected or not, with its last sync time and last error. Connect asks, in a dialog with password fields, for `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` only when the secret file lacks one of them (an OAuth client of type Desktop app, with the Google Calendar API enabled); the typed values leave the page once sent. The answer is Google's consent page, opened in a new tab; the page then polls `GET /api/v1/calendar` and shows "Connected, N events read" after the first sync. The sign-in uses the same listener on `127.0.0.1` as the CLI, so Google needs no other redirect URI; it lives in the `factory ui` process, which keeps the sign-in's state in memory only. The routes (`POST /api/v1/calendar/connect`, `/disconnect`) take the write routes' guards and the owner check.
  - Turn on, from the terminal: `factory setup calendar google` (after `npm run setup`, which creates the secret file; with no secret file it stops and creates nothing) reads the client from the secret file or asks for it once with hidden input.
  - Both run one flow (`connectCalendar` in `src/setup.ts`, over this plugin's connect hook): the consent page asks for `https://www.googleapis.com/auth/calendar.readonly` only, with a PKCE S256 challenge, a random state and a redirect to a listener on `127.0.0.1` (a port the system picks, path `/callback`) that closes after 5 minutes. It refuses a wrong state, an error from Google, a token answer whose scope is not exactly `calendar.readonly`, or one with no refresh token: then nothing is written (the CLI exits non-zero; the page shows why). Otherwise it writes the three secrets together to the secret file (mode 600), adds `"google-calendar"` to the live `calendar` setting (other names stay), and runs one sync. No secret, token, code or verifier is printed, returned by the dashboard, logged or stored anywhere else; the consent URL shows the client ID.
  - Off: Disconnect on the Settings page (after a confirmation dialog; nothing is written before Confirm) or `factory setup calendar google --disconnect` removes the three secret lines from the secret file (other lines stay, mode 600) and drops `"google-calendar"` from the live `calendar` setting (other names stay; the last one leaves `[]`). It does not revoke the token at Google, and the source's stored events stay until a later change removes them.

Turn on / off: connect or disconnect a plugin (above), or list plugin names in `calendar`, the file key or the live setting (on); set `[]` (off). Stored events and state rows stay until a later change removes them.

## History

- 2026-11-13: `google-calendar` is connected and disconnected from the dashboard too, and both the dashboard and `factory setup calendar google` write the live `calendar` setting through one flow; the token exchange is given up after 30 seconds. Before, only the terminal connected it, it wrote the file's `calendar` key after a diff and a yes, and the exchange waited on Google with no limit.

- 2026-11-12: `google-calendar` gives up an HTTP call after 30 seconds. Before, a sync waited on Google with no limit.

- 2026-11-12: `google-calendar` is turned on with `factory setup calendar google` and off with `--disconnect`. Before, the owner pasted the three secrets into the secret file and edited `calendar` by hand, and ran the OAuth consent outside the factory.

- 2026-11-12: `google-calendar` added, the first provider, with the `calendar_ids` key and the `Clock` in the plugin context. Before, no provider shipped and `calendar` could name none.

- 2026-11-12: the interface, the `calendar` config key and the sync added, with no provider. Before, the factory had no calendar.
