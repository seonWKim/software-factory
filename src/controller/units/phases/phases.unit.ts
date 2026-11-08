// Split specs: the approval that files one phase per sub-issue, phase holds and releases, closing a finished split.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { type TriagePhase, parseTriage } from "../../../core/outputs.js";
import { runKey } from "../../../core/policy.js";
import { specDecisionDetail } from "../../../core/standing.js";
import { PHASE_HOLD, PHASES_OPEN, SPLIT_APPROVED, SPLIT_FILING, parseSubIssues, phaseIssueBody, phaseLinkDetail, phaseMarker, phaseTitle } from "../../../core/split.js";
import { type Actor, type SourceRef, type StateChange, type StateChangeDetail, type WorkItem, type WorkItemId } from "../../../core/types.js";
import { type Decision, type Refusal, SYSTEM, completed, splitFiling, splitOpen, footerAfter } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** Held phases and open split parents looked at per intake tick (design 2026-11-01). */
const PHASE_BATCH = 50;
/** A later phase of a split, waiting for the phase before it (design 2026-11-01). */
function phaseHeld(it: WorkItem): boolean {
  return it.stage === "NEW" && it.blocked_on === "upstream" && it.blocked_reason === PHASE_HOLD;
}
/** A phase whose spec waits at the gate for `/approve`. */
function phaseSpecPending(it: WorkItem): boolean {
  return it.parent_id !== null && it.stage === "READY" && it.blocked_on === "human" && it.blocked_reason === "spec_pending";
}

/** Split specs: the approval that files one phase per sub-issue, phase holds and releases, closing a finished split. */
export class PhasesUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * phases_auto_approve: a phase of a split whose parent the owner approved (its phases are open) needs no
   * `/approve` of its own. Off, not a phase, or a parent that is gone or no longer waiting on its phases: false.
   */
  async approvedByParent(it: WorkItem): Promise<boolean> {
    if (this.c.k.cfg.phases_auto_approve !== true || it.parent_id === null) return false;
    const parent = await this.c.k.d.store.getWorkItem(it.parent_id);
    return parent !== null && splitOpen(parent);
  }

  /** The phases of the spec waiting at the gate: those of the latest succeeded triage run, or null for no split. */
  async specPhases(it: WorkItem): Promise<TriagePhase[] | null> {
    const run = (await this.c.k.d.store.listRuns(it.id))
      .filter((r) => r.kind === "triage" && r.outcome?.status === "succeeded" && r.acknowledged_at !== null)
      .at(-1);
    if (run?.outcome?.status !== "succeeded") return null;
    const parsed = parseTriage(run.outcome.data.spec);
    return parsed.ok && parsed.value.phases ? parsed.value.phases : null;
  }

  /**
   * `/approve` on a split spec (design 2026-11-01): one sub-issue per phase, in order, each with the intake label
   * and linked to the parent, and one work item per phase, requested by the approver. The first phase is queued
   * for triage; each later one starts held (`phase_hold`) until the phase before it closes as completed
   * (tickPhases). The approval first claims the filing with a conditional transition to `split_filing`, so of
   * two passes at once (two replicas, an old process still draining) only one files (2026-11-07). A phase that
   * already has a work item under this parent is not filed again; the rest are filed by marker (the parent's
   * sub-issues, then the newest labelled issues) and taken in keyed on the source. A failure refuses the
   * approval and puts the spec back at the gate, so `/approve` again files the rest. On success the parent
   * waits on its phases (`phases_open`); it is never implemented itself. Returns null once applied: the
   * transitions are its own, conditional on the claim.
   */
  async approveSplit(
    it: WorkItem,
    phases: TriagePhase[],
    actor: Actor,
    note: string | null,
    commentId: string,
    tag: StateChangeDetail | null,
  ): Promise<Decision | Refusal> {
    const adapter = this.c.k.adapterFor(it.source, "fileSubIssue");
    if (!adapter?.fileSubIssue) {
      return { refuse: "this source cannot file sub-issues, so a split spec cannot be approved here; reply `/revise <feedback>` to get a spec without phases" };
    }
    const claim = await this.c.k.d.store.transition({
      id: it.id,
      expected_version: it.version,
      patch: { blocked_on: "upstream", blocked_reason: SPLIT_FILING },
      actor,
      reason: SPLIT_FILING,
      detail: { phases: phases.length, comment_id: commentId },
    });
    if (!claim.ok) {
      if (claim.reason !== "version_conflict") return null;
      // Another pass claimed it first: the same command is answered by that pass, another one is refused.
      const cur = claim.current;
      if (!splitFiling(cur) && !splitOpen(cur)) return { refuse: "the item changed while the approval was applied; reply `/approve` again" };
      if ((await this.splitClaim(it.id))?.detail?.comment_id === commentId) return null;
      return { refuse: "another `/approve` already approved this split" };
    }
    const requester = actor.kind === "user" ? actor.id : it.requester_id;
    const known = new Map((await this.c.k.d.store.listPhases(it.id)).map((p) => [p.phase, p.source]));
    const refs: SourceRef[] = [];
    try {
      for (const [i, phase] of phases.entries()) {
        const index = i + 1;
        const prev = refs[i - 1] ?? null;
        const title = phaseTitle(index, phases.length, phase.title);
        const body = phaseIssueBody({ parent: it.source, phase, index, total: phases.length, depends_on: prev });
        const ref = known.get(index) ?? await adapter.fileSubIssue({ parent: it.source, title, body, marker: phaseMarker(it.id, index) });
        const { item, created } = await this.c.k.d.store.createWorkItem(
          {
            source: ref,
            title,
            requester_id: requester,
            project: it.project,
            problem: `${title}\n\n${body}`,
            resources: [ref.link, it.source.link],
            parent: { id: it.id, phase: index },
            ...(prev ? { hold: { blocked_on: "upstream" as const, blocked_reason: PHASE_HOLD } } : {}),
          },
          actor,
          {
            detail: phaseLinkDetail({ parent_work_item_id: it.id, phase: index, phases: phases.length, depends_on: prev?.id ?? null }),
            // The intake key, so a later delivery of the same issue is a no-op.
            ...(prev ? {} : { enqueue: { kind: "triage" as const, idempotency_key: `${ref.type}:${ref.id}:triage` } }),
          },
        );
        refs.push(ref);
        if (created) {
          this.c.k.d.log.info("phase filed", { work_item_id: item.id, parent_work_item_id: it.id, phase: index, held: prev !== null });
          await this.c.unit("outbox").showStatus(item);
        }
      }
    } catch (err) {
      this.c.k.d.log.warn("filing split phases failed; /approve again files the rest", {
        work_item_id: it.id,
        filed: refs.length,
        phases: phases.length,
        error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
      });
      // Back at the gate, so `/approve` again is accepted at once.
      const back = splitFiling(it)
        ? { blocked_on: "human" as const, blocked_reason: "spec_pending" }
        : { blocked_on: it.blocked_on, blocked_reason: it.blocked_reason };
      await this.settleSplit(claim.item, { patch: back, actor, reason: "split_filing_failed", detail: { filed: refs.length, phases: phases.length } });
      return {
        refuse: `filing the phase sub-issues stopped after ${refs.length} of ${phases.length}; reply \`/approve\` again to file the rest (none is filed twice)`,
      };
    }
    const patch = { blocked_on: "upstream" as const, blocked_reason: PHASES_OPEN };
    await this.c.unit("outbox").comment(it, `split:${it.id}`, [
      `The split spec was approved, so the factory filed ${phases.length} phases as sub-issues of this issue:`,
      "",
      ...refs.map((r, i) => `${i + 1}. ${r.link}${i === 0 ? " (starts now)" : " (waits for the phase before it)"}`),
      "",
      this.c.k.cfg.phases_auto_approve === true
        ? "Each phase gets its own spec, approved by this `/approve` (`phases_auto_approve`), so it is implemented without asking again. This issue closes as completed when the last phase does."
        : "Each phase gets its own spec and its own `/approve`. This issue closes as completed when the last phase does.",
      "",
      footerAfter(it, patch),
    ].join("\n"));
    await this.settleSplit(claim.item, {
      patch,
      actor,
      reason: SPLIT_APPROVED,
      detail: {
        phases: phases.length,
        sub_issues: JSON.stringify(refs.map((r) => r.id)),
        ...(note ? { note } : {}),
        ...specDecisionDetail({ tier: it.tier, kind: "split", outcome: "approved", spec_changed: false, actor }),
        ...tag,
      },
    });
    return null;
  }

  /** The claim's end (`split_approved` or `split_filing_failed`), conditional on the claim being the item's last change. */
  async settleSplit(claimed: WorkItem, d: NonNullable<Decision>): Promise<void> {
    if (!this.c.unit("transitions").inTable(claimed, d.patch)) return;
    const r = await this.c.k.d.store.transition({ ...d, id: claimed.id, expected_version: claimed.version });
    if (!r.ok) {
      this.c.k.d.log.warn("split claim changed before it settled", { work_item_id: claimed.id, reason: d.reason, conflict: r.reason });
      return;
    }
    this.c.k.d.log.info("transition", { work_item_id: claimed.id, reason: d.reason, version: r.item.version });
    await this.c.unit("outbox").showStatus(r.item);
  }

  /** The parent's latest `split_filing` claim, whose detail names the command that made it. */
  async splitClaim(id: WorkItemId): Promise<StateChange | null> {
    return (await this.c.k.d.store.listStateChanges(id)).filter((c) => c.reason === SPLIT_FILING).at(-1) ?? null;
  }

  /**
   * Moves split specs along (design 2026-11-01). A held phase whose previous phase is CLOSED / completed is
   * released into triage. A split parent whose phases are all CLOSED / completed gets one comment, is closed as
   * completed on its source, then CLOSED / completed in the store. A phase closed any other way keeps the next
   * phase held and the parent open. Safe on any replica and safe to repeat: every step re-reads the store, the
   * comment is keyed, closing a closed issue changes nothing, and each transition is conditional.
   */
  async tickPhases(): Promise<void> {
    await this.c.k.live.refresh();
    const held = await this.c.k.d.store.listWorkItemsWhere({ stage: "NEW", blocked_on: "upstream", limit: PHASE_BATCH });
    for (const h of held) if (phaseHeld(h)) await this.c.k.guard("phase release", () => this.releasePhase(h.id));
    const parents = await this.c.k.d.store.listWorkItemsWhere({ stage: "READY", blocked_on: "upstream", limit: PHASE_BATCH });
    for (const p of parents) if (splitOpen(p)) await this.c.k.guard("split close", () => this.closeSplitIfDone(p.id));
    if (this.c.k.cfg.phases_auto_approve !== true) return;
    // A phase spec that waited at the gate before phases_auto_approve was turned on.
    const waiting = await this.c.k.d.store.listWorkItemsWhere({ stage: "READY", blocked_on: "human", limit: PHASE_BATCH });
    for (const w of waiting) if (phaseSpecPending(w)) await this.c.k.guard("phase approve", () => this.approvePhaseSpec(w.id));
  }

  /** phases_auto_approve on a phase spec already waiting at the gate: approved as the parent's /approve covers it. */
  async approvePhaseSpec(id: WorkItemId): Promise<void> {
    const it = await this.c.k.d.store.getWorkItem(id);
    if (!it || !phaseSpecPending(it) || !(await this.approvedByParent(it))) return;
    // A phase whose own triage proposed phases still waits for a human: that /approve files issues.
    if (await this.specPhases(it)) return;
    await this.c.unit("transitions").decide(id, (cur) =>
      phaseSpecPending(cur)
        ? {
            patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null },
            actor: SYSTEM,
            reason: "phase_spec_auto_approved",
            detail: { parent_work_item_id: cur.parent_id! },
            enqueue: { kind: "implement", idempotency_key: runKey(cur, "implement") },
          }
        : null,
    );
  }

  /** Releases held phase `id` once the phase before it (by the store's parent link and phase number) closed as completed. */
  async releasePhase(id: WorkItemId): Promise<void> {
    const it = await this.c.k.d.store.getWorkItem(id);
    if (!it || !phaseHeld(it)) return;
    if (it.parent_id === null || it.phase === null) {
      this.c.k.d.log.warn("held phase has no parent link; left held", { work_item_id: id });
      return;
    }
    const parentId = it.parent_id;
    const phase = it.phase;
    const prev = phase > 1 ? (await this.recordedPhases(parentId)).find((p) => p.phase === phase - 1) : null;
    if (phase > 1 && !completed(prev)) return;
    await this.c.unit("transitions").decide(id, (cur) =>
      phaseHeld(cur)
        ? {
            patch: { blocked_on: "none", blocked_reason: null },
            actor: SYSTEM,
            reason: "phase_released",
            detail: { parent_work_item_id: parentId, phase, depends_on: prev?.source.id ?? null },
            enqueue: { kind: "triage", idempotency_key: `${cur.source.type}:${cur.source.id}:triage` },
          }
        : null,
    );
  }

  /**
   * The parent's phases, only those its approval recorded (`sub_issues` of its last split_approved). Another
   * work item linked to the parent (a duplicate sub-issue a racing approval filed, then closed by hand) neither
   * holds the next phase nor keeps the parent open. With no recorded list, every linked phase counts.
   */
  async recordedPhases(parentId: WorkItemId): Promise<WorkItem[]> {
    const phases = await this.c.k.d.store.listPhases(parentId);
    const approved = (await this.c.k.d.store.listStateChanges(parentId)).filter((c) => c.reason === SPLIT_APPROVED).at(-1);
    const ids = parseSubIssues(approved?.detail);
    return ids ? phases.filter((p) => ids.includes(p.source.id)) : phases;
  }

  async closeSplitIfDone(id: WorkItemId): Promise<void> {
    const it = await this.c.k.d.store.getWorkItem(id);
    if (!it || !splitOpen(it)) return;
    // How many phases the approval filed: the store's phase rows must all exist and all be closed as completed.
    const approved = (await this.c.k.d.store.listStateChanges(id)).filter((c) => c.reason === SPLIT_APPROVED).at(-1);
    const ids = parseSubIssues(approved?.detail);
    if (!ids) return;
    const phases = await this.recordedPhases(id);
    if (phases.length < ids.length || !phases.every(completed)) return;
    const adapter = this.c.k.adapterFor(it.source, "closeIssue");
    if (!adapter) return;
    await this.c.unit("outbox").comment(it, `split-done:${it.id}`,
      `Closed because all ${ids.length} phases of this split were closed as completed.`);
    await adapter.closeIssue(it.source, "completed");
    await this.c.unit("transitions").decide(id, (cur) =>
      splitOpen(cur)
        ? {
            patch: { stage: "CLOSED", close_reason: "completed", blocked_on: "none", blocked_reason: null },
            actor: SYSTEM,
            reason: "split_completed",
            detail: { phases: ids.length },
          }
        : null,
    );
    // Its dependents count it merged now that its phases are (design §5).
    await this.c.k.guard("dependents", () => this.c.unit("coordination").releaseDependents(it.source.id));
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "phases": PhasesUnit;
  }
}

export default controllerUnit({
  name: "phases",
  create: (c: Ctx) => new PhasesUnit(c),
});
