import { definePlugin, secretName } from "../../../plugin-api.js";
import { GoogleCalendarSource, calendarIds } from "./google-calendar-source.js";

// Google Calendar, read-only (docs/plugins/calendar-source.md): on when the top-level `calendar` key lists
// "google-calendar". Reads the primary calendar, or the calendars the top-level `calendar_ids` key lists.
export const GOOGLE_REFRESH_TOKEN = secretName("GOOGLE_REFRESH_TOKEN");
export const GOOGLE_CLIENT_ID = secretName("GOOGLE_CLIENT_ID");
export const GOOGLE_CLIENT_SECRET = secretName("GOOGLE_CLIENT_SECRET");

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
      http: (url, init) => fetch(url, init),
      now: () => c.clock.now(),
      secrets: c.secrets,
      names: { refreshToken: GOOGLE_REFRESH_TOKEN, clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
      calendarIds: calendarIds(c.loaded.file.calendar_ids),
    }),
});
