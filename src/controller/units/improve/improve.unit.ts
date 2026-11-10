// The daily improve run, the improve run a burst or an old failure triggers, and filing an improve run's report.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { enqueueImprove, fileReport, triggerImprove, utcDay } from "../../../core/improver.js";
import { type Run } from "../../../core/types.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The daily improve run, the triggered improve run, and filing an improve run's report. */
export class ImproveUnit {
  constructor(private readonly c: Ctx) {}

  /** The UTC day whose improve run this process saw queued (design §7). A cache only: the run's key dedupes. */
  improveDay: string | null = null;

  /** Each tick: the day's improve run, then the trigger check. */
  async improveStep(): Promise<void> {
    await this.dailyStep();
    await this.triggerStep();
  }

  /**
   * Queues the improve run of the current UTC day on the project's system work item. The run's key holds the
   * day, so a second tick, a restart or another replica queues nothing more; `improveDay` only saves this
   * process the store write once the day's run is there.
   */
  private async dailyStep(): Promise<void> {
    const day = utcDay(this.c.k.d.clock.now());
    if (this.improveDay === day) return;
    const { run, created } = await enqueueImprove(this.c.k.d, this.c.k.project(), "daily");
    if (created) this.c.k.d.log.info("improve run queued", { run_id: run.id, day });
    this.improveDay = day;
  }

  /**
   * Queues one improve run when the project's unreviewed failures call for it (design §7: K failures of one run
   * kind, or one older than the age limit). Store state only, no process memory: the run's key names the last
   * improve run, so replicas on one store queue one run between them.
   */
  private async triggerStep(): Promise<void> {
    const r = await triggerImprove(this.c.k.d, this.c.k.project());
    if (r?.created) this.c.k.d.log.info("improve run triggered", { run_id: r.run.id, ...r.why });
  }

  /**
   * Files the groups of an improve run's report (design §7) through the first source that can file, in
   * `plugins.source` order. A comment on a filed item the store holds goes through its thread (and the outbox);
   * one on an item nobody started yet goes straight to the item's source, once per marker.
   */
  async fileImprove(run: Run): Promise<void> {
    const report = await this.c.k.d.store.getImproveReport(run.id);
    if (!report) return;
    const filer = this.c.k.sources.find((s) => typeof s.fileIssue === "function");
    const done = await fileReport({
      store: this.c.k.d.store,
      scanner: this.c.k.d.scanner,
      clock: this.c.k.d.clock,
      file: filer?.fileIssue ? (input) => filer.fileIssue!(input) : null,
      comment: async (ref, body, marker) => {
        const it = await this.c.k.d.store.getWorkItemBySource(ref.type, ref.id);
        if (it) await this.c.unit("outbox").post(it, it.source, body, marker);
        else await this.c.unit("outbox").postWithoutItem(ref, body, marker);
      },
    }, report);
    const count = (status: string) => done.groups.filter((g) => g.filing?.status === status).length;
    this.c.k.d.log.info("improve report filed", { report_id: report.id, filed: count("filed"), commented: count("commented"), skipped: count("skipped") });
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "improve": ImproveUnit;
  }
}

export default controllerUnit({
  name: "improve",
  create: (c: Ctx) => new ImproveUnit(c),
  steps: [
    { name: "improve", every: "tick", order: 120, run: (u) => u.improveStep() },
  ],
});
