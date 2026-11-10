// Verdicts (design 11-signal-ledger): a person's `/verdict` and the implicit ones the factory reads from PR events (a
// merge, a person's push to a factory PR, a revert). One signal per verdict row, keyed by its ID. No role.

import { defineSignal } from "./signal.js";

const HUMAN = "human_verdict";
const IMPLICIT = "implicit_verdict";

export default defineSignal({
  name: "verdicts",
  kinds: [HUMAN, IMPLICIT],
  async read(r, since) {
    const verdicts = await r.listVerdictsSince(since);
    return verdicts.map((v) => ({ source_ref: v.id, kind: v.implicit ? IMPLICIT : HUMAN, work_item_id: v.work_item_id, role: null, at: v.at }));
  },
});
