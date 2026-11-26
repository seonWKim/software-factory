// The Activity capability (design 09-dashboard-activity, 09-api-registry): what the Activity page and the chat read.
// The query stays in src/ui/activity-api.ts; the handler is imported inside the run, so scripts/gen-api.mjs, which loads
// this file with Node's type stripping, never loads it.

import { type Declared, declare } from "../registry.js";
import { array, nullable, number, object, oneOf, string } from "../schema.js";

const LINK = nullable(object({ kind: oneOf(["transcript", "log"] as const), href: nullable(string()), text: string() }));
const ACTION = object({ seq: number(), kind: string(), subject: string(), outcome: string(), reason: string(), at: string(), link: LINK });
const ACTOR = object({
  actor_id: string(), name: string(), about: string(), state: oneOf(["idle", "running", "attention"] as const), now: string(),
  last_at: nullable(string()), next_run_at: nullable(string()), transcript: LINK, actions: array(ACTION),
});

export const ACTIVITY: readonly Declared[] = [
  declare({
    id: "activity.actors", area: "activity",
    description: "Every autonomous actor with its name, what it does now, its last and next run and its recent actions (outcome, reason, transcript or log link; none older than the retention days), and the open factory alerts (clear one with POST /api/v1/alarms/dismiss).",
    permission: "read", method: "GET", path: "/api/v1/activity", input: object({}),
    output: object({ as_of: string(), retention_days: number(), actors: array(ACTOR), alerts: array(object({ alert_id: string(), text: string(), created_at: string() })) }),
    run: async (c) => (await import("../../ui/activity-api.js")).readActivity(c.d),
  }),
];
