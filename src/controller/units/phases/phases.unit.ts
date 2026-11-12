// Split specs: the approval that files one phase per sub-issue through outbound, phase holds and releases, closing a
// finished split. Moved out of the legacy controller (RFC 0015 M5); its store I/O is still inline (unit-purity ratchet).

import { type TriagePhase, parseTriage } from "../../../core/outputs.js";
import { runKey } from "../../../core/policy.js";
import { specDecisionDetail } from "../../../core/standing.js";
import { PHASE_HOLD, PHASES_OPEN, SPLIT_APPROVED, SPLIT_FILING, parseSubIssues, phaseIssueBody, phaseLinkDetail, phaseMarker, phaseTitle } from "../../../core/split.js";
import { type Actor, type SourceRef, type StateChange, type StateChangeDetail, type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { ActionRow } from "../../../outbound/index.js";
import { type Decision, DELIVERY_FAILED, type Refusal, SYSTEM, completed, splitFiling, splitOpen, footerAfter } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** Held phases and open split parents looked at per intake tick (design 2026-11-01). */
const PHASE_BATCH = 50;
/** A later phase of a split, waiting for the phase before it (design 2026-11-01). */
function phaseHeld(it: WorkItem): boolean {
  return it.stage === "NEW" && it.blocked_on === "upstream" && it.blocked_reason === PHASE_HOLD;
}
/** The claim detail of a split whose parent's source cannot file sub-issues: its phases are local tasks. */
const LOCAL_FILING = "local";
/** A phase filed as a local task: its ref derived from the parent's source id and its phase number, as `LocalSource` does. */
function localPhaseRef(parent: SourceRef, index: number): SourceRef {
  const id = `${parent.id}-phase-${index}`;
  return { type: "local", id, link: `local:${id}` };
}
/** A phase whose spec waits at the gate for `/approve`. */
function phaseSpecPending(it: WorkItem): boolean {
  return it.parent_id !== null && it.stage === "READY" && it.blocked_on === "human" && it.blocked_reason === "spec_pending";
}

/** Held phase `it` released: its hold lifted and its triage queued under its intake key. */
function release(it: WorkItem, actor: Actor, reason: string, detail: StateChangeDetail): NonNullable<Decision> {
  const enqueue = { kind: "triage" as const, idempotency_key: `${it.source.type}:${it.source.id}:triage` };
  return { patch: { blocked_on: "none", blocked_reason: null }, actor, reason, detail, enqueue };
}

/** One phase of a split being filed: its place, its spec, and the ref of the phase before it. */
type PhaseFiling = { index: number; phase: TriagePhase; total: number; prev: SourceRef | null };
function phaseBody(it: WorkItem, f: PhaseFiling): string {
  return phaseIssueBody({ parent: it.source, phase: f.phase, index: f.index, total: f.total, depends_on: f.prev });
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
   * `/approve` on a split spec (design 04-split-specs; through outbound since RFC 0015 M7). The approval claims the
   * filing with a conditional transition to `split_filing` (detail: the command, its note and tag), so of two
   * passes at once (two replicas, an old process still draining) only one files; the pass that loses to the same
   * command answers nothing, one that loses to another command is refused. The winner replies that the filing is
   * queued and records phase 1's keyed `file_sub_issue` action (`advanceSplit`); outbound files it, retrying a
   * failure, and each phase's DeliveryCompleted records the next, whose body names it. A parent whose source cannot
   * file sub-issues (a Slack thread) gets its phases as local tasks instead, filed in the same pass with no network
   * call (claim detail `filing: local`). Returns null once applied: the transitions are its own, conditional on the claim.
   */
  async approveSplit(
    it: WorkItem,
    phases: TriagePhase[],
    actor: Actor,
    note: string | null,
    commentId: string,
    tag: StateChangeDetail | null,
  ): Promise<Decision | Refusal> {
    const local = !this.c.k.adapterFor(it.source, "fileSubIssue")?.fileSubIssue;
    const patch = { blocked_on: "upstream" as const, blocked_reason: SPLIT_FILING };
    const claim = await this.c.k.d.store.transition({
      id: it.id,
      expected_version: it.version,
      patch,
      actor,
      reason: SPLIT_FILING,
      detail: { phases: phases.length, comment_id: commentId, note, tag: tag ? JSON.stringify(tag) : null, ...(local ? { filing: LOCAL_FILING } : {}) },
    });
    if (!claim.ok) {
      if (claim.reason !== "version_conflict") return null;
      // Another pass claimed it first: the same command is answered by that pass, another one is refused.
      const cur = claim.current;
      if (!splitFiling(cur) && !splitOpen(cur)) return { refuse: "the item changed while the approval was applied; reply `/approve` again" };
      if ((await this.splitClaim(it.id))?.detail?.comment_id === commentId) return null;
      return { refuse: "another `/approve` already approved this split" };
    }
    this.c.k.d.log.info("transition", { work_item_id: it.id, reason: SPLIT_FILING, version: claim.item.version });
    // Local tasks are filed in this pass: the thread gets only the line listing them.
    if (!local) await this.c.unit("outbox").comment(it, `split-queued:${it.id}:${commentId}`, [
      `\`/approve\` was applied: the factory is filing the ${phases.length} phases of this split as sub-issues of this issue, one at a time (each names the phase before it, so it is filed once that one is). This issue lists them once all are filed.`,
      "",
      footerAfter(it, patch),
    ].join("\n"));
    await this.advanceSplit(it.id);
    return null;
  }

  /**
   * Files a split's phases one at a time through outbound (RFC 0015 M7), from what the store holds, so it is safe
   * to run again on any replica: on the claim, on each filing's DeliveryCompleted, and on the phase tick, which
   * resumes a filing whose step was lost. A phase's ref is its work item's (an earlier approval took it in) or its
   * delivered `file_sub_issue` action's, taken in now as a work item (held after the first). The first phase with
   * neither gets its keyed action and the pass stops: the key names the phase and the approval, so it is recorded
   * once, and `/approve` after a give-up records the rest again. A given-up filing stops the split for a person
   * (`delivery_failed`). A split filed as local tasks takes each phase in at once under its derived ref, so a retry
   * finds the same rows. With every phase taken in, the parent gets one comment listing them and waits on them: one
   * line for local tasks, posted to the parent's thread like any comment.
   */
  async advanceSplit(id: WorkItemId): Promise<void> {
    const it = await this.c.k.d.store.getWorkItem(id);
    if (!it || !splitFiling(it)) return;
    const claim = await this.splitClaim(id);
    const phases = await this.specPhases(it);
    if (!claim || !phases) {
      this.c.k.d.log.warn("split filing has no claim or no phases; left as it is", { work_item_id: id });
      return;
    }
    const known = new Map((await this.c.k.d.store.listPhases(id)).map((p) => [p.phase, p.source]));
    const d = claim.detail ?? {};
    const local = d.filing === LOCAL_FILING;
    const refs: SourceRef[] = [];
    for (const [i, phase] of phases.entries()) {
      const f = { index: i + 1, phase, total: phases.length, prev: refs[i - 1] ?? null };
      const ref = known.get(i + 1) ?? (local ? await this.takeIn(it, claim, f, localPhaseRef(it.source, f.index)) : await this.filed(it, claim, f));
      if (!ref) return;
      refs.push(ref);
    }
    const tag = typeof d.tag === "string" ? (JSON.parse(d.tag) as StateChangeDetail) : null;
    const patch = { blocked_on: "upstream" as const, blocked_reason: PHASES_OPEN };
    if (local) {
      await this.c.unit("outbox").comment(it, `split:${it.id}`,
        `The split spec was approved, so the factory filed its ${phases.length} phases as local tasks, each starting when the one before it closes as completed: ` +
          `${refs.map((r) => r.link).join(", ")}. This thread closes as completed when the last one does.`);
    } else await this.c.unit("outbox").comment(it, `split:${it.id}`, [
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
    await this.settleSplit(it, {
      patch,
      actor: claim.actor,
      reason: SPLIT_APPROVED,
      detail: {
        phases: phases.length,
        sub_issues: JSON.stringify(refs.map((r) => r.id)),
        ...(typeof d.note === "string" ? { note: d.note } : {}),
        ...specDecisionDetail({ tier: it.tier, kind: "split", outcome: "approved", spec_changed: false, actor: claim.actor }),
        ...tag,
      },
    });
  }

  /**
   * Phase `f.index`'s ref once outbound filed it, taken in as a work item now; null while its action is being
   * filed, or just recorded (and announced), or given up.
   */
  private async filed(it: WorkItem, claim: StateChange, f: PhaseFiling): Promise<SourceRef | null> {
    const key = `file_sub_issue:${it.id}:${f.index}:${String(claim.detail?.comment_id)}`;
    const a = await this.c.k.actionByKey(key);
    if (!a) {
      const args = { title: phaseTitle(f.index, f.total, f.phase.title), body: phaseBody(it, f), marker: phaseMarker(it.id, f.index), phase: f.index, phases: f.total };
      await this.c.k.commit({ writes: [{ kind: "intent", action: { action: "file_sub_issue", target: it.source, work_item_id: it.id, args, key } }] });
      await this.c.k.announce();
      return null;
    }
    if (a.delivered_at === null) return null;
    if (a.outcome !== "sent" || !a.delivered_ref) {
      await this.filingGaveUp(it, f, a);
      return null;
    }
    // The source files under its own type: the ref is the parent's type with the delivered id.
    return this.takeIn(it, claim, f, { type: it.source.type, id: a.delivered_ref, link: a.delivered_url ?? "" });
  }

  /** Phase `f.index` taken in as a work item under `ref`, linked to its parent, held after the first; keyed on `ref`. */
  private async takeIn(it: WorkItem, claim: StateChange, f: PhaseFiling, ref: SourceRef): Promise<SourceRef> {
    const title = phaseTitle(f.index, f.total, f.phase.title);
    const body = phaseBody(it, f);
    const requester = claim.actor.kind === "user" ? claim.actor.id : it.requester_id;
    const { item, created } = await this.c.k.d.store.createWorkItem(
      {
        source: ref,
        title,
        requester_id: requester,
        project: it.project,
        problem: `${title}\n\n${body}`,
        resources: [ref.link, it.source.link],
        parent: { id: it.id, phase: f.index },
        ...(f.prev ? { hold: { blocked_on: "upstream" as const, blocked_reason: PHASE_HOLD } } : {}),
      },
      claim.actor,
      {
        detail: phaseLinkDetail({ parent_work_item_id: it.id, phase: f.index, phases: f.total, depends_on: f.prev?.id ?? null }),
        // The intake key, so a later delivery of the same issue is a no-op.
        ...(f.prev ? {} : { enqueue: { kind: "triage" as const, idempotency_key: `${ref.type}:${ref.id}:triage` } }),
      },
    );
    if (created) {
      this.c.k.d.log.info("phase filed", { work_item_id: item.id, parent_work_item_id: it.id, phase: f.index, held: f.prev !== null });
      await this.c.unit("outbox").showStatus(item);
    }
    return ref;
  }

  /**
   * Outbound gave up filing phase `f.index` (the source refused it for good; its dead-letter alarm is raised): the
   * parent stops for a person (`delivery_failed`), and `/approve` again files the rest, none twice.
   */
  private async filingGaveUp(it: WorkItem, f: { index: number; total: number }, a: ActionRow): Promise<void> {
    const error = a.last_error ?? "unknown";
    const patch = { blocked_on: "human" as const, blocked_reason: DELIVERY_FAILED };
    await this.c.unit("outbox").comment(it, `split-failed:${it.id}:${a.seq}`, [
      `Filing phase ${f.index} of ${f.total} as a sub-issue was refused (${error}), so the split stopped after ${f.index - 1} of ${f.total}. ` +
        "Reply `/approve` again to file the rest (none is filed twice).",
      "",
      footerAfter(it, patch),
    ].join("\n"));
    await this.c.unit("transitions").decide(it.id, (cur) =>
      splitFiling(cur)
        ? { patch, actor: SYSTEM, reason: DELIVERY_FAILED, detail: { action: "file_sub_issue", phase: f.index, phases: f.total, error } }
        : null,
    );
  }

  /** The claim's end (`split_approved`), conditional on the claim being the item's last change. */
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
   * Moves split specs along (design 2026-11-01). A split whose phases are being filed goes on (`advanceSplit`). A
   * held phase whose previous phase is CLOSED / completed is released into triage. A split parent whose phases are all CLOSED / completed gets one comment, is closed as
   * completed on its source, then CLOSED / completed in the store. A phase closed any other way keeps the next
   * phase held and the parent open. Safe on any replica and safe to repeat: every step re-reads the store, the
   * comment is keyed, closing a closed issue changes nothing, and each transition is conditional.
   */
  async tickPhases(): Promise<void> {
    await this.c.k.live.refresh();
    const held = await this.c.k.d.store.listWorkItemsWhere({ stage: "NEW", blocked_on: "upstream", limit: PHASE_BATCH });
    for (const h of held) if (phaseHeld(h)) await this.c.k.guard("phase release", () => this.releasePhase(h.id));
    const parents = await this.c.k.d.store.listWorkItemsWhere({ stage: "READY", blocked_on: "upstream", limit: PHASE_BATCH });
    for (const p of parents) {
      if (splitOpen(p)) await this.c.k.guard("split close", () => this.closeSplitIfDone(p.id));
      // A filing whose step was lost (a crash after the claim, a lost DeliveryCompleted) goes on.
      else if (splitFiling(p)) await this.c.k.guard("split filing", () => this.advanceSplit(p.id));
    }
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
    const prev = await this.previousPhase(it);
    if (it.phase > 1 && !completed(prev)) return;
    const detail = { parent_work_item_id: it.parent_id, phase: it.phase, depends_on: prev?.source.id ?? null };
    await this.c.unit("transitions").decide(id, (cur) => (phaseHeld(cur) ? release(cur, SYSTEM, "phase_released", detail) : null));
  }

  /**
   * `/retry` on held phase `it` (design 04-split-specs, 2026-11-12): releases it into triage unless the phase before
   * it is still open, so a phase whose previous phase closed without a merge (rejected, superseded) can start. The
   * transition records that phase and its close reason. Runs inside the command's conditional transition.
   */
  async retryPhase(it: WorkItem, actor: Actor, note: string | null, paths: readonly string[]): Promise<Decision | Refusal> {
    if (paths.length > 0) return { refuse: "`+paths` applies only to a failed implement run; reply `/retry` without `+paths`" };
    const prev = await this.previousPhase(it);
    if (prev && prev.stage !== "CLOSED") {
      return {
        refuse: `the previous phase, phase ${prev.phase ?? "?"} (${prev.source.link}), is still open: it must close as completed first, which starts this phase, ` +
          "or close without a merge, after which `/retry` releases this phase",
      };
    }
    return release(it, actor, "retry_requested", {
      released: PHASE_HOLD,
      parent_work_item_id: it.parent_id,
      phase: it.phase,
      depends_on: prev?.source.id ?? null,
      close_reason: prev?.close_reason ?? null,
      ...(note ? { note } : {}),
    });
  }

  /** The phase before held phase `it`, among those its parent's approval recorded; null for phase 1 or no parent link. */
  private async previousPhase(it: WorkItem): Promise<WorkItem | null> {
    if (it.parent_id === null || it.phase === null || it.phase < 2) return null;
    const phase = it.phase;
    return (await this.recordedPhases(it.parent_id)).find((p) => p.phase === phase - 1) ?? null;
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
    if (!this.c.k.adapterFor(it.source, "closeIssue")) return;
    await this.c.unit("outbox").comment(it, `split-done:${it.id}`,
      `Closed because all ${ids.length} phases of this split were closed as completed.`);
    await this.c.unit("outbox").close(it, "completed");
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
