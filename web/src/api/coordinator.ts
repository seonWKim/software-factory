// The Work page's Coordinator card read: GET /api/v1/coordinator (useCoordinator), through the generated typed call
// (generated.ts, the `coordinator.status` capability; design 09-api-registry, 09-dashboard-system).

import { useQuery } from "@tanstack/react-query";
import { POLL_MS } from "./client.js";
import { type CoordinatorStatusOutput, coordinatorStatus } from "./generated.js";

export type CoordinatorView = CoordinatorStatusOutput;
export type CoordinatorAction = CoordinatorView["actions"][number];

/** The switch, the next check time and the recent actions, polled like the other reads. */
export function useCoordinator() {
  return useQuery({ queryKey: ["/api/v1/coordinator"], queryFn: () => coordinatorStatus({}), refetchInterval: POLL_MS, refetchIntervalInBackground: false });
}
