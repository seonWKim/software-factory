// The Activity page's read: GET /api/v1/activity (useActivity), through the generated typed call (generated.ts, the
// `activity.actors` capability; design 09-api-registry, 09-dashboard-activity). The chat reads the same capability.
// Clearing a factory alert is the alarm dismissal in alarms.ts.

import { useQuery } from "@tanstack/react-query";
import { POLL_MS } from "./client.js";
import { type ActivityActorsOutput, activityActors } from "./generated.js";

export type ActivityView = ActivityActorsOutput;
export type ActivityActor = ActivityView["actors"][number];
export type ActivityAction = ActivityActor["actions"][number];
export type ActivityAlert = ActivityView["alerts"][number];

/** The query key: the page rereads it after a Clear. */
export const ACTIVITY_KEY = "/api/v1/activity";

/** The actors, their recent actions and the open alerts, polled like the other reads. */
export function useActivity() {
  return useQuery({ queryKey: [ACTIVITY_KEY], queryFn: () => activityActors({}), refetchInterval: POLL_MS, refetchIntervalInBackground: false });
}
