// Failed runs (design 11-signal-ledger): one signal per run that ended failed, keyed by the run ID, at its finish
// time, with its run kind's role. The transcript stays where it is: the run ID is its reference.

import { defineSignal, roleOfRun } from "./signal.js";

export default defineSignal({
  name: "failed_runs",
  kinds: ["run_failed"],
  async read(r, since) {
    const runs = await r.listRunsFinishedSince({ status: "failed", since });
    return runs.map((run) => ({
      source_ref: run.id, kind: "run_failed", work_item_id: run.work_item_id, role: roleOfRun(run.kind), at: run.finished_at ?? run.updated_at,
    }));
  },
});
