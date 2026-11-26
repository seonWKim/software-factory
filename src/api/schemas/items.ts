// The output schema of GET /api/v1/items (the capability items.list; src/ui/api.ts items()) (design 09-api-registry,
// owner answer 3): the answer's and each row's top-level fields are typed (tier an integer or null), and
// every nested object (source, issue, merge check, merge, why, run, claim, need, facets, counts) is a JSON object.

import { array, boolean, integer, jsonObject, nullable, object, optional, string } from "../schema.js";

const json = jsonObject;

/** One row of the ranked list. */
export const ITEM_ROW = object({
  id: string(),
  source: json(),
  title: nullable(string()),
  item_phase: string(),
  state_label: string(),
  reason_code: string(),
  stage: string(),
  tier: nullable(integer()),
  kind: nullable(string()),
  blocked_on: nullable(string()),
  blocked_reason: nullable(string()),
  close_reason: nullable(string()),
  run_status: nullable(string()),
  change_ref: nullable(string()),
  change_url: nullable(string()),
  issue: nullable(json()),
  since: nullable(string()),
  updated_at: string(),
  version: integer(),
  dependents: integer(),
  conflicts: json(),
  merge_check: nullable(json()),
  merge: nullable(json()),
  rank_reason: optional(string()),
  held: optional(boolean()),
  need: optional(nullable(json())),
  commands: optional(array(json())),
  overlaps: optional(array(json())),
  why: json(),
  parent_id: nullable(string()),
  phase: nullable(integer()),
  waiting_on_number: nullable(integer()),
  run: nullable(json()),
  claim: nullable(json()),
});

export const ITEMS_OUTPUT = object({
  as_of: string(),
  total: integer(),
  items: array(ITEM_ROW),
  facets: json(),
  counts: json(),
});
