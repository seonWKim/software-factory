// The dashboard's POST routes that check the settings CSRF token: settings, calendar, model credential and Ask.
// write-routes.ts runs the guards before each; a new settings-token write route adds one entry here.

import { SETTINGS_PATH, writeSettings } from "./settings-api.js";
import { ownerOf } from "./rules-api.js";
import { CALENDAR_CONNECT_PATH, CALENDAR_DISCONNECT_PATH, CALENDAR_SYNC_PATH, writeCalendar, writeCalendarSync } from "./calendar-api.js";
import { DATA_ASK_PATH, askData } from "./data-ask.js";
import { MODEL_CREDENTIAL_PATH, writeModelCredential } from "./model-credential.js";
import { type WriteRoute, settingsToken } from "./write-route-types.js";

/** The settings-token write routes, in table order (first match wins). */
export const SETTINGS_WRITE_ROUTES: readonly WriteRoute[] = [
  { matches: (d, p) => p === SETTINGS_PATH && d.settings !== undefined, token: settingsToken, run: (d, _p, b) => writeSettings(d, d.settings!, b) },
  {
    matches: (d, p) => (p === CALENDAR_CONNECT_PATH || p === CALENDAR_DISCONNECT_PATH || p === CALENDAR_SYNC_PATH) && d.settings?.calendar !== undefined,
    token: settingsToken,
    run: (d, p, b) => (p === CALENDAR_SYNC_PATH ? writeCalendarSync(d, b) : writeCalendar(d, p, b)),
  },
  {
    matches: (d, p) => p === MODEL_CREDENTIAL_PATH && d.settings?.modelCredential !== undefined,
    token: settingsToken,
    run: (d, _p, b) => writeModelCredential(d, d.pauses ? (does) => ownerOf(d, d.pauses!, does) : null, b),
  },
  { matches: (d, p) => p === DATA_ASK_PATH && d.settings?.ask !== undefined, token: settingsToken, run: (d, _p, b) => askData(d, d.settings!.ask!, b) },
];
