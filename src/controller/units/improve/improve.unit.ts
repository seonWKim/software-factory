// The daily improve run and improve runs filed from a failed run.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { FIX_SPEC_APPROVED, enqueueImprove, fileReport, markerKey, utcDay } from "../../../core/improver.js";
import { type FiledPattern, type Run, type SourceRef, type WorkItem } from "../../../core/types.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The daily improve run and improve runs filed from a failed run. */
export class ImproveUnit {
  constructor(private readonly c: Ctx) {}

  /** The UTC day whose improve run this process saw queued (design §7). A cache only: the run's key dedupes. */
  improveDay: string | null = null;

  /**
   * Queues the improve run of the current UTC day on the project's system work item. The run's key holds the
   * day, so a second tick, a restart or another replica queues nothing more; `improveDay` only saves this
   * process the store write once the day's run is there.
   */
  async improveStep(): Promise<void> {
    const day = utcDay(this.c.k.d.clock.now());
    if (this.improveDay === day) return;
    const { run, created } = await enqueueImprove(this.c.k.d, this.c.k.project(), "daily");
    if (created) this.c.k.d.log.info("improve run queued", { run_id: run.id, day });
    this.improveDay = day;
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
      comment: (ref, body, marker) => this.commentFiled(ref, body, marker),
    }, report);
    const count = (status: string) => done.groups.filter((g) => g.filing?.status === status).length;
    this.c.k.d.log.info("improve report filed", { report_id: report.id, filed: count("filed"), commented: count("commented"), skipped: count("skipped") });
  }

  /** A comment on a filed item: through its thread (and the outbox) when the store holds it, else to its source. */
  async commentFiled(ref: SourceRef, body: string, marker: string): Promise<void> {
    const it = await this.c.k.d.store.getWorkItemBySource(ref.type, ref.id);
    if (it) await this.c.unit("outbox").post(it, it.source, body, marker);
    else await this.c.unit("outbox").postWithoutItem(ref, body, marker);
  }

  /**
   * The filed pattern `it` is the fix of (design §7), or null. The key comes from the marker in its filed body, or,
   * once triage replaced the body with the spec, from its earlier fix approval; the pattern's stored item must be
   * this item (its source ref), so a body that only copies a marker is no fix item.
   */
  async fixPattern(it: WorkItem): Promise<FiledPattern | null> {
    const key = markerKey(it.problem) ?? (await this.c.k.reader.listStateChanges(it.id)).find((c) => c.reason === FIX_SPEC_APPROVED)?.detail?.pattern_key;
    if (typeof key !== "string") return null;
    const p = await this.c.k.d.store.getFiledPattern(it.project, key);
    return p?.filed_ref?.type === it.source.type && p.filed_ref.id === it.source.id ? p : null;
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
