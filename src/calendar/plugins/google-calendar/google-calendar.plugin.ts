import { definePlugin, secretName } from "../../../plugin-api.js";
import { googleCalendarConnect } from "./google-calendar-connect.js";
import { GoogleCalendarSource, type HttpClient, calendarIds } from "./google-calendar-source.js";

// Google Calendar, read-only (docs/plugins/calendar-source.md): on when the top-level `calendar` key lists
// "google-calendar". Reads the primary calendar, or the calendars the top-level `calendar_ids` key lists.
// `factory setup calendar google` connects the account (google-calendar-connect.ts); `--disconnect` undoes it.
export const GOOGLE_REFRESH_TOKEN = secretName("GOOGLE_REFRESH_TOKEN");
export const GOOGLE_CLIENT_ID = secretName("GOOGLE_CLIENT_ID");
export const GOOGLE_CLIENT_SECRET = secretName("GOOGLE_CLIENT_SECRET");

/** How long one HTTP call to Google may take, its body included, before it fails as "no answer". */
export const GOOGLE_HTTP_TIMEOUT_MS = 30_000;

/** fetch, given up after `ms`: a hung Google fails that sync instead of holding up the controller's tick. */
export const timedFetch = (ms: number): HttpClient => (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

const NAMES = { refreshToken: GOOGLE_REFRESH_TOKEN, clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET };

export default definePlugin({
  kind: "calendar",
  name: "google-calendar",
  secrets: [
    { name: GOOGLE_REFRESH_TOKEN, purpose: "OAuth refresh token granted the calendar.readonly scope: exchanged for short-lived access tokens" },
    { name: GOOGLE_CLIENT_ID, purpose: "OAuth client ID the refresh token was issued to" },
    { name: GOOGLE_CLIENT_SECRET, purpose: "OAuth client secret of that client" },
  ],
  create: (c) =>
    new GoogleCalendarSource({
      http: timedFetch(GOOGLE_HTTP_TIMEOUT_MS),
      now: () => c.clock.now(),
      secrets: c.secrets,
      names: NAMES,
      calendarIds: calendarIds(c.loaded.file.calendar_ids),
    }),
  connect: googleCalendarConnect({ http: (url, init) => fetch(url, init), names: NAMES }),
});
