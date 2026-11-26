// The Coordinator capability (design 09-dashboard-system, 05-coordinator): what the Work page's Coordinator card reads.
// The query stays in src/ui/coordinator-api.ts; the handler is imported inside the run, so scripts/gen-api.mjs, which
// loads this file with Node's type stripping, never loads it.

import { type Declared, declare } from "../registry.js";
import { array, boolean, nullable, number, object, string } from "../schema.js";

const ACTION = object({
  cycle_id: string(), seq: number(), command: string(), work_item_id: nullable(string()), outcome: string(), reason: string(), at: string(),
  transcript: nullable(string()),
});

export const COORDINATOR: readonly Declared[] = [
  declare({
    id: "coordinator.status", area: "coordinator",
    description: "The coordinator's switch (the coordinator setting), when its next cycle is due (null before the first cycle) and its recent actions, newest first, each with its outcome, reason and the storage key of its cycle's transcript (null when none is stored).",
    permission: "read", method: "GET", path: "/api/v1/coordinator", input: object({}),
    output: object({ as_of: string(), on: boolean(), next_check_at: nullable(string()), actions: array(ACTION) }),
    run: async (c) => (await import("../../ui/coordinator-api.js")).readCoordinator(c.d),
  }),
];
