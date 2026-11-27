// The items list capability (design 09-api-registry): GET /api/v1/items, the ranked list of work items. Its handler
// stays in src/ui/api.ts (listItems), imported inside the run so scripts/gen-api.mjs never loads it. The query's
// fields are strings; parseFilters (src/ui/filters.ts) checks them, so its 400 texts stay ("Unknown state.").

import { type Declared, declare } from "../registry.js";
import { object, optional, string } from "../schema.js";
import { ITEMS_OUTPUT } from "../schemas/items.js";

const filter = () => optional(string());

export const ITEMS: readonly Declared[] = [
  declare({
    id: "items.list", area: "items",
    description: "The work items, ranked, with the list's facets and counts; filtered by state, stage, tier, run kind, unblocks, closed, words (q), task project and blocked_on (human: the items blocked on the owner).",
    permission: "read", method: "GET", path: "/api/v1/items",
    input: object({ state: filter(), stage: filter(), tier: filter(), kind: filter(), unblocks: filter(), closed: filter(), q: filter(), project: filter(), blocked_on: filter() }),
    output: ITEMS_OUTPUT,
    run: async (c, i) => {
      const { answerOf, listItems } = await import("../../ui/api.js");
      const params = new URLSearchParams(Object.entries(i).filter((e): e is [string, string] => typeof e[1] === "string"));
      return answerOf(await listItems(c.d, params));
    },
  }),
];
