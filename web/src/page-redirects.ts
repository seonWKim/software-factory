/** Old page paths and where they lead now (the landing page, Needs you, became Tasks; Queue became Work's Queued filter; Spend, Failures and Runners became sections of Health's tabs; Activity became Health's Activity tab; Routines became Schedules). */
export const REDIRECTS: Readonly<Record<string, string>> = {
  "": "tasks",
  queue: "items?state=queued",
  spend: "health?tab=spend",
  failures: "health?tab=failures",
  runners: "health?tab=runners",
  activity: "health?tab=activity",
  routines: "schedules",
};
