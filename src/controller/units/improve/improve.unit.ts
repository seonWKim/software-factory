// The daily improve run, the improve run a burst or an old failure triggers, filing an improve run's report, and the
// design learnings: capturing the owner's corrections to UI changes and committing them in one batch per improve run.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import {
  type DesignLearningSource, FIX_SPEC_APPROVED, type FilingDeps, LEARNINGS_HEAD, LEARNINGS_PATH, captureDesignLearning, captureKey, dailyTriggerOn, enqueueImprove, fileProposals,
  fileReport, isDesignFinding, markerKey, renderLine, settleOutcomes, triggerImprove, utcDay,
} from "../../../core/improver.js";
import type { FiledPattern, Run, SourceRef, Timestamp, WorkItem } from "../kernel.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The daily improve run, the triggered improve run, and filing an improve run's report. */
export class ImproveUnit {
  constructor(private readonly c: Ctx) {}

  /** The UTC day whose improve run this process saw queued (design §7). A cache only: the run's key dedupes. */
  improveDay: string | null = null;

  /** Each tick: the day's improve run, the trigger check, the outcomes of filed patterns due one, then promoted proposals. */
  async improveStep(): Promise<void> {
    await this.dailyStep();
    await this.triggerStep();
    await this.outcomeStep();
    await this.proposalStep();
  }

  /**
   * Files one work item per entity proposal the owner promoted (design §7, #496), through the first source that can file,
   * as improve patterns are: the diff as an unverified draft, never applied or merged. One caller takes each (a store claim).
   */
  private async proposalStep(): Promise<void> {
    for (const p of await fileProposals({ store: this.c.k.d.store, file: this.filer() }, this.c.k.project())) {
      this.c.k.d.log.info("proposal filed", { proposal_id: p.id, ref: p.filed_ref?.id });
    }
  }

  /**
   * Sets whether each filed pattern's fix held, seven days after its item closed as completed (design §7). Store
   * reads and conditional writes only: replicas that tick together write each outcome once.
   */
  private async outcomeStep(): Promise<void> {
    for (const p of await settleOutcomes(this.c.k.d, this.c.k.project())) {
      this.c.k.d.log.info("filed pattern outcome", { pattern_key: p.pattern_key, outcome: p.outcome });
    }
  }

  /**
   * Queues the improve run of the current UTC day on the project's system work item. The run's key holds the
   * day, so a second tick, a restart or another replica queues nothing more; `improveDay` only saves this
   * process the store write once the day's run is there. Off with `improver.daily_trigger` false: an `improve`
   * schedule queues the day's run under the same key (design 08-schedules).
   */
  private async dailyStep(): Promise<void> {
    if (!dailyTriggerOn(this.c.k.cfg.improver)) return;
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
    const done = await fileReport({
      store: this.c.k.d.store,
      scanner: this.c.k.d.scanner,
      clock: this.c.k.d.clock,
      file: this.filer(),
      comment: (ref, body, marker) => this.commentFiled(ref, body, marker),
    }, report);
    const count = (status: string) => done.groups.filter((g) => g.filing?.status === status).length;
    this.c.k.d.log.info("improve report filed", { report_id: report.id, filed: count("filed"), commented: count("commented"), skipped: count("skipped") });
    await this.c.k.guard("design learnings commit", () => this.commitLearnings(run));
  }

  /**
   * The project's design learnings not in design-system/learnings.md yet, appended to it on the local base in one
   * commit for the improve run `run` (design 07-design-learnings). The action, keyed by the run and its lines, is stored
   * before the lines are marked taken, so a crash between the two appends them again next time, and the append skips a
   * line the file holds. No sandbox that can commit locally: the lines wait in the store.
   */
  private async commitLearnings(run: Run): Promise<void> {
    const merge = this.c.unit("local-merge");
    if (!merge.canAppend()) return;
    const lines = (await this.c.k.d.store.listDesignLearnings(this.c.k.project())).filter((l) => l.batch === null);
    if (lines.length === 0) return;
    const batch = `${run.id}-${lines[0]!.id}-${lines.at(-1)!.id}-${lines.length}`;
    await merge.appendToBase(`design_learnings:${batch}`, {
      path: LEARNINGS_PATH, head: LEARNINGS_HEAD, lines: lines.map(renderLine), branch: `${this.c.k.cfg.branch_prefix}design-learnings-${batch}`,
      message: `Design learnings: ${lines.length} new ${lines.length === 1 ? "line" : "lines"}\n\nAppended by improve run ${run.id} (design 07-design-learnings).`,
    });
    await this.c.k.d.store.markDesignLearningBatch(lines.map((l) => l.id), run.id);
  }

  /**
   * An owner correction on `it` kept as a design learnings line (design 07-design-learnings): a `/revise` or `/reject`
   * with words (`pushback`, keyed by its comment) or an explicit `changes` verdict with a reason (`verdict`). Only an
   * item whose change touches `web/`. A failure is logged: the command it follows has applied.
   */
  async captureCorrection(it: WorkItem, source: Extract<DesignLearningSource, "pushback" | "verdict">, comment_id: string, words: string): Promise<void> {
    await this.c.k.guard("design learnings", async () => {
      await captureDesignLearning(this.c.k.d, it, { source, key: captureKey[source](it.id, comment_id), words, at: this.now() });
    });
  }

  /** Each design-system finding of a finished review run on `it`, kept as a line keyed by the run and the finding's place. */
  async captureReview(it: WorkItem, run: Run, findings: readonly Parameters<typeof isDesignFinding>[0][]): Promise<void> {
    await this.c.k.guard("design learnings", async () => {
      for (const [i, f] of findings.entries()) {
        if (isDesignFinding(f)) await captureDesignLearning(this.c.k.d, it, { source: "review", key: captureKey.review(run.id, i), words: f.text, at: run.finished_at ?? this.now() });
      }
    });
  }

  private now(): Timestamp {
    return this.c.k.d.clock.now().toISOString() as Timestamp;
  }

  /** The filing source's `fileIssue` (the kernel's `filingSource`); null when no source can file. */
  private filer(): FilingDeps["file"] {
    return this.c.k.filingSource()?.fileIssue ?? null;
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
