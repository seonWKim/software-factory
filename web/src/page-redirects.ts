/** Old page paths and where they lead now (the landing page, Needs you, became Tasks; Queue became Work's Queued filter; Activity became part of Work; Spend and Failures became sections of Health). */
export const REDIRECTS: Readonly<Record<string, string>> = {
  "": "tasks",
  queue: "items?state=queued",
  activity: "items",
  spend: "health#spend",
  failures: "health#failures",
};
