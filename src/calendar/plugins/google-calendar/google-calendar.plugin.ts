import { definePlugin, secretName } from "../../../plugin-api.js";
import { defaultGoogleClient } from "./default-client.js";
import { googleCalendarConnect } from "./google-calendar-connect.js";
import { GOOGLE_HTTP_TIMEOUT_MS, GoogleCalendarSource, calendarIds, timedFetch } from "./google-calendar-source.js";

// Google Calendar, read-only (docs/plugins/calendar-source.md): on when the top-level `calendar` key lists
// "google-calendar". Reads the primary calendar, or the calendars the top-level `calendar_ids` key lists.
// `factory setup calendar google` and the dashboard's Calendar section connect the account through the one connect
// hook (google-calendar-connect.ts), with the factory's default client when the secret file names none
// (default-client.ts); `--disconnect` and the section's Disconnect undo it.
export const GOOGLE_REFRESH_TOKEN = secretName("GOOGLE_REFRESH_TOKEN");
export const GOOGLE_CLIENT_ID = secretName("GOOGLE_CLIENT_ID");
export const GOOGLE_CLIENT_SECRET = secretName("GOOGLE_CLIENT_SECRET");

export { GOOGLE_HTTP_TIMEOUT_MS, timedFetch };

const NAMES = { refreshToken: GOOGLE_REFRESH_TOKEN, clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET };

export default definePlugin({
  kind: "calendar",
  name: "google-calendar",
  secrets: [
    { name: GOOGLE_REFRESH_TOKEN, purpose: "OAuth refresh token granted the calendar.readonly scope: exchanged for short-lived access tokens" },
    { name: GOOGLE_CLIENT_ID, purpose: "OAuth client ID the refresh token was issued to: the factory's default client, or your own" },
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
  // The token exchange is given up after GOOGLE_HTTP_TIMEOUT_MS too, so a hung Google never holds a dashboard request.
  connect: googleCalendarConnect({ http: timedFetch(GOOGLE_HTTP_TIMEOUT_MS), names: NAMES, defaultClient: () => defaultGoogleClient() }),
});
