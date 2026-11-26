// Split specs: the approval that files one phase per sub-issue through outbound, phase holds and releases, closing a
// finished split. Moved out of the legacy controller (RFC 0015 M5); its store I/O is still inline (unit-purity ratchet).

import { type TriageOutput, type TriagePhase, parseJudge, parseTriage } from "../../../core/outputs.js";
import { failureClass, runKey, sameStep, takenOver } from "../../../core/policy.js";
import { specDecisionDetail } from "../../../core/standing.js";
import { PHASE_HOLD, PHASES_OPEN, SPLIT_APPROVED, SPLIT_FILING, atSizeCheckpoint, goalLinesText, itemSizeCaps, parseSubIssues, phaseIssueBody, phaseLinkDetail, phaseMarker, phaseTitle, withParentDependsOn } from "../../../core/split.js";
import { type Actor, type Run, type SourceRef, type StateChange, type StateChangeDetail, type WorkItem, type WorkItemId, runTokenCount } from "../../../core/types.js";
import type { ActionRow } from "../../../outbound/index.js";
import { type Decision, DELIVERY_FAILED, type Refusal, SYSTEM, completed, splitFiling, splitOpen, footerAfter } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";
import { FIX_PHASE_CAP, GOAL_LIMIT, GOAL_PHASE_ADDED, GOAL_QUESTION, JUDGE_FAILED, JUDGE_QUEUED, JUDGE_SKIPPED, JUDGE_VERDICT, fixPhases, goalLines, judgeKey, judgeable, jsonStrings } from "./goal.js";

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

/** The fix a judge verdict's detail stores (`fix_*`), checked as parseJudge checks a fix (its reason a placeholder); null for none. */
function storedFix(d: StateChangeDetail): TriagePhase | null {
  // parseJudge needs a non-empty reason; this one is a placeholder, never a state change's reason.
  const placeholder = "stored";
  const r = parseJudge({ verdict: "fix", reason: placeholder, fix: { title: d.fix_title, problem: d.fix_problem, done_criteria: jsonStrings(d.fix_done_criteria), allowed_paths: jsonStrings(d.fix_allowed_paths) } });
  return r.ok ? (r.value.fix ?? null) : null;
}
/** The source ids of a split's recorded phases in order: its last split_approved's `sub_issues`, then each goal_phase_added's after it. */
function recordedIds(changes: readonly StateChange[]): string[] | null {
  const at = changes.findLastIndex((c) => c.reason === SPLIT_APPROVED), ids = parseSubIssues(changes[at]?.detail);
  return ids && [...ids, ...fixPhases(changes.slice(at + 1)).map((c) => String(c.detail?.sub_issue))];
}

/** Split specs: the approval that files one phase per sub-issue, phase holds and releases, closing a finished split. */
export class PhasesUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * phases_auto_approve: a phase of a split whose parent the owner approved (its phases are open) needs no
   * `/approve` of its own for `spec`. Off, not a phase, a parent that is gone or no longer waiting on its phases, a
   * spec that is itself a split (its /approve files issues), or one at its own size checkpoint: false.
   */
  async approvedByParent(it: WorkItem, spec: TriageOutput): Promise<boolean> {
    if (this.c.k.cfg.phases_auto_approve !== true || it.parent_id === null) return false;
    if (spec.phases || atSizeCheckpoint(spec, await itemSizeCaps(this.c.k.reader, it.id, this.c.k.settings(it.project)))) return false;
    const parent = await this.c.k.d.store.getWorkItem(it.parent_id);
    return parent !== null && splitOpen(parent);
  }

  /** The phases of the spec waiting at the gate: those of the latest succeeded triage run, or null for no split. */
  async specPhases(it: WorkItem): Promise<TriagePhase[] | null> {
    return (await this.specSplit(it))?.phases ?? null;
  }

  /** The split of the latest succeeded triage run: its phases and the goal lines of the same run, or null for no split. */
  private async specSplit(it: WorkItem): Promise<{ phases: TriagePhase[]; goal: string[] | undefined } | null> {
    const spec = await this.latestSpec(it);
    return spec?.phases ? { phases: spec.phases, goal: spec.goal_done_when } : null;
  }

  /** The spec of the latest succeeded, applied triage run, or null when there is none or it does not parse. */
  private async latestSpec(it: WorkItem): Promise<TriageOutput | null> {
    const run = (await this.c.k.d.store.listRuns(it.id))
      .filter((r) => r.kind === "triage" && r.outcome?.status === "succeeded" && r.acknowledged_at !== null)
      .at(-1);
    if (run?.outcome?.status !== "succeeded") return null;
    const parsed = parseTriage(run.outcome.data.spec);
    return parsed.ok ? parsed.value : null;
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
    const split = await this.specSplit(it);
    if (!claim || !split) {
      this.c.k.d.log.warn("split filing has no claim or no phases; left as it is", { work_item_id: id });
      return;
    }
    const { phases, goal } = split;
    const known = new Map((await this.c.k.d.store.listPhases(id)).map((p) => [p.phase, p.source]));
    const d = claim.detail ?? {};
    const local = d.filing === LOCAL_FILING;
    const refs: SourceRef[] = [];
    for (const [i, phase] of phases.entries()) {
      const f = { index: i + 1, phase, total: phases.length, prev: refs[i - 1] ?? null };
      const ref = known.get(i + 1) ?? (local ? await this.takeIn(it, claim.actor, f, localPhaseRef(it.source, f.index)) : await this.filed(it, claim, f));
      if (!ref) return;
      refs.push(ref);
    }
    const tag = typeof d.tag === "string" ? (JSON.parse(d.tag) as StateChangeDetail) : null;
    const patch = { blocked_on: "upstream" as const, blocked_reason: PHASES_OPEN };
    if (local) {
      await this.c.unit("outbox").comment(it, `split:${it.id}`, [
        `The split spec was approved, so the factory filed its ${phases.length} phases as local tasks, each starting when the one before it closes as completed: ` +
          `${refs.map((r) => r.link).join(", ")}. This thread closes as completed when the last one does.`,
        ...goalLinesText(goal),
      ].join("\n"));
    } else await this.c.unit("outbox").comment(it, `split:${it.id}`, [
      `The split spec was approved, so the factory filed ${phases.length} phases as sub-issues of this issue:`,
      "",
      ...refs.map((r, i) => `${i + 1}. ${r.link}${i === 0 ? " (starts now)" : " (waits for the phase before it)"}`),
      ...goalLinesText(goal),
      "",
      this.c.k.cfg.phases_auto_approve === true
        ? "Each phase gets its own spec, approved by this `/approve` (`phases_auto_approve`), so it is implemented without asking again. This issue closes as completed when the last phase does."
        : "Each phase gets its own spec and its own `/approve`. This issue closes as completed when the last phase does.",
      "",
      footerAfter(it, patch),
    ].join("\n"));
    const gate = specDecisionDetail({ tier: it.tier, kind: "split", outcome: "approved", spec_changed: false, actor: claim.actor });
    await this.settleSplit(it, { patch, actor: claim.actor, reason: SPLIT_APPROVED, detail: {
      phases: phases.length, sub_issues: JSON.stringify(refs.map((r) => r.id)), ...(goal ? { goal_done_when: JSON.stringify(goal) } : {}), ...(typeof d.note === "string" ? { note: d.note } : {}), ...gate, ...tag,
    } });
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
    return this.takeIn(it, claim.actor, f, { type: it.source.type, id: a.delivered_ref, link: a.delivered_url ?? "" });
  }

  /**
   * Phase `f.index` taken in as a work item under `ref`, linked to its parent, held after the first; keyed on `ref`.
   * A local phase inherits its parent's `Depends on:` lines (withParentDependsOn).
   */
  private async takeIn(it: WorkItem, actor: Actor, f: PhaseFiling, ref: SourceRef): Promise<SourceRef> {
    const title = phaseTitle(f.index, f.total, f.phase.title);
    const body = ref.type === "local" ? withParentDependsOn(phaseBody(it, f), it) : phaseBody(it, f);
    const requester = actor.kind === "user" ? actor.id : it.requester_id;
    const hold = f.prev ? { hold: { blocked_on: "upstream" as const, blocked_reason: PHASE_HOLD } } : {};
    const { item, created } = await this.c.k.d.store.createWorkItem(
      { source: ref, title, requester_id: requester, project: it.project, problem: `${title}\n\n${body}`, resources: [ref.link, it.source.link], parent: { id: it.id, phase: f.index }, ...hold },
      actor,
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
        "Reply `/approve` again to file the rest (none is filed twice).", "", footerAfter(it, patch),
    ].join("\n"));
    const detail = { action: "file_sub_issue", phase: f.index, phases: f.total, error };
    await this.c.unit("transitions").decide(it.id, (cur) => (splitFiling(cur) ? { patch, actor: SYSTEM, reason: DELIVERY_FAILED, detail } : null));
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
   * held phase whose previous phase is CLOSED / completed is released into triage (on a goal split, once the judge
   * let that phase go on). An open goal split gets one judge run per merged phase (judgePhases). A split parent whose recorded phases are all CLOSED gets one comment, is closed on its source,
   * then CLOSED in the store: completed when its last phase closed completed, else rejected (closeSplitIfDone). A
   * phase closed any other way keeps the next phase held. Safe on any replica and safe to repeat: every step re-reads the store, the
   * comment is keyed, closing a closed issue changes nothing, and each transition is conditional.
   */
  async tickPhases(): Promise<void> {
    await this.c.k.live.refresh();
    const held = await this.c.k.d.store.listWorkItemsWhere({ stage: "NEW", blocked_on: "upstream", limit: PHASE_BATCH });
    for (const h of held) if (phaseHeld(h)) await this.c.k.guard("phase release", () => this.releasePhase(h.id));
    const parents = await this.c.k.d.store.listWorkItemsWhere({ stage: "READY", blocked_on: "upstream", limit: PHASE_BATCH });
    for (const p of parents) {
      if (splitOpen(p)) {
        await this.c.k.guard("goal judge", () => this.judgePhases(p.id));
        await this.c.k.guard("split close", () => this.closeSplitIfDone(p.id));
      }
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
    if (!it || !phaseSpecPending(it)) return;
    // A phase whose own triage proposed phases, or whose spec is at its size checkpoint, still waits for a human.
    const spec = await this.latestSpec(it);
    if (!spec || !(await this.approvedByParent(it, spec))) return;
    await this.c.unit("transitions").decide(id, (cur) => phaseSpecPending(cur) ? {
      patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null }, actor: SYSTEM, reason: "phase_spec_auto_approved",
      detail: { parent_work_item_id: cur.parent_id! }, enqueue: { kind: "implement", idempotency_key: runKey(cur, "implement") },
    } : null);
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
    // A goal split's phase starts only after the judge let the one before it go on (design 04-split-specs).
    if (prev && !(await this.judgedOn(it.parent_id, prev))) return;
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
   * The parent's phases, only those its approval recorded (`sub_issues` of its last split_approved) and the fix
   * phases its goal added since (goal_phase_added). Another work item linked to the parent (a duplicate sub-issue a
   * racing approval filed, then closed by hand) neither holds the next phase nor keeps the parent open. With no
   * recorded list, every linked phase counts.
   */
  async recordedPhases(parentId: WorkItemId): Promise<WorkItem[]> {
    const phases = await this.c.k.d.store.listPhases(parentId);
    const ids = recordedIds(await this.c.k.d.store.listStateChanges(parentId));
    return ids ? phases.filter((p) => ids.includes(p.source.id)) : phases;
  }

  /** The recorded phase with the highest phase number: the one whose close decides how the parent closes. */
  async lastPhase(parentId: WorkItemId): Promise<WorkItem | null> {
    const phases = await this.recordedPhases(parentId);
    return phases.reduce<WorkItem | null>((last, p) => (last === null || (p.phase ?? 0) > (last.phase ?? 0) ? p : last), null);
  }

  /**
   * Closes split parent `id` once every recorded phase is CLOSED, whatever each phase's close reason (design
   * 04-split-specs, 2026-11-18). The last phase decides how: closed completed, the parent closes completed with that
   * phase's merge sha; closed any other way, the parent closes rejected and its source issue is closed as a rejected
   * item's is. A goal split whose last phase merged closes only after the judge's done on it, and its comment says
   * the goal's lines were met (design 04-split-specs). Its dependents are re-checked either way (design 05-dependencies).
   */
  async closeSplitIfDone(id: WorkItemId): Promise<void> {
    const it = await this.c.k.d.store.getWorkItem(id);
    if (!it || !splitOpen(it)) return;
    // How many phases the approval and the goal's fix phases filed: the store's phase rows must all exist and all be closed.
    const ids = recordedIds(await this.c.k.d.store.listStateChanges(id));
    if (!ids) return;
    const phases = await this.recordedPhases(id);
    if (phases.length < ids.length || !phases.every((p) => p.stage === "CLOSED")) return;
    if (!this.c.k.adapterFor(it.source, "closeIssue")) return;
    const last = await this.lastPhase(id);
    const merged = completed(last);
    // A goal split's last merged phase waits for the judge's verdict: done closes it, any other stops it for the owner.
    if (merged && last && !(await this.judgedOn(id, last))) return;
    const goalMet = merged && last ? (await this.judgement(id, last))?.reason === JUDGE_VERDICT : false;
    const done = phases.filter(completed).length;
    await this.c.unit("outbox").comment(it, `split-done:${it.id}`, merged
      ? goalMet
        ? `Closed because all ${ids.length} phases of this split were closed and the judge found the goal's lines met after the last phase.`
        : done === ids.length
        ? `Closed because all ${ids.length} phases of this split were closed as completed.`
        : `Closed because all ${ids.length} phases of this split were closed and the last phase was closed as completed (${done} of ${ids.length} completed).`
      : `Closed because all ${ids.length} phases of this split were closed and the last phase closed without a merge. The factory closed this issue as not planned.`);
    if (merged) await this.c.unit("outbox").close(it, "completed");
    else await this.c.unit("outbox").close(it);
    const merge_sha = merged ? (last?.merge_sha ?? null) : null;
    const patch = { stage: "CLOSED" as const, close_reason: merged ? ("completed" as const) : ("rejected" as const), merge_sha, blocked_on: "none" as const, blocked_reason: null };
    const detail = { phases: ids.length, completed: done, ...(goalMet ? { goal_met: true } : {}) };
    await this.c.unit("transitions").decide(id, (cur) => (splitOpen(cur) ? { patch, actor: SYSTEM, reason: merged ? "split_completed" : "split_rejected", detail } : null));
    // Its dependents count it merged, or get the dependency_closed hold, now that its phases are closed (design §5).
    await this.c.k.guard("dependents", () => this.c.unit("coordination").releaseDependents(it.source.id));
  }

  /** The goal lines of open split `id`'s last approval, or null for a split without a goal. */
  private async goal(id: WorkItemId): Promise<string[] | null> {
    return goalLines((await this.c.k.d.store.listStateChanges(id)).filter((c) => c.reason === SPLIT_APPROVED).at(-1)?.detail);
  }

  /**
   * Queues one judge run per goal phase that closed completed with a merge sha (design 04-split-specs), on the
   * parent, keyed `judge:<parent>:<phase>`. Each queue is a conditional transition that re-reads the parent's runs,
   * so a second pass (another tick, another replica) finds the run of that phase, its retries included, and queues
   * nothing. A split without goal lines queues none.
   */
  async judgePhases(id: WorkItemId): Promise<void> {
    const goal = await this.goal(id);
    if (!goal) return;
    const phases = (await this.recordedPhases(id)).sort((a, b) => (a.phase ?? 0) - (b.phase ?? 0));
    for (const p of phases.filter(judgeable)) {
      const key = judgeKey(id, p.phase);
      await this.c.unit("transitions").decide(id, async (cur) => {
        if (!splitOpen(cur)) return null;
        if ((await this.c.k.d.store.listRuns(id)).some((r) => r.kind === "judge" && sameStep(r.idempotency_key, key))) return null;
        const judge = { phase: p.phase, goal_done_when: goal, title: p.title ?? "", problem: p.problem, done_criteria: p.done_criteria ?? [], merge_sha: p.merge_sha, phases: phases.map((x) => x.title ?? "") };
        return { patch: {}, actor: SYSTEM, reason: JUDGE_QUEUED, detail: { phase: p.phase, merge_sha: p.merge_sha }, enqueue: { kind: "judge" as const, idempotency_key: key, input: { judge } } };
      });
    }
  }

  /** The parent's latest judgement of `phase`: its judge_verdict, judge_skipped or goal_phase_added change; null while none is applied. */
  private async judgement(id: WorkItemId, phase: WorkItem): Promise<StateChange | null> {
    const judged = [JUDGE_VERDICT, JUDGE_SKIPPED, GOAL_PHASE_ADDED];
    return (await this.c.k.d.store.listStateChanges(id)).filter((c) => judged.includes(c.reason) && c.detail?.phase === phase.phase).at(-1) ?? null;
  }

  /**
   * Whether the goal may go on past `phase`: always for a split without goal lines or a phase the judge does not read
   * (no merge sha); else once its judgement let it (next, done, a fix phase filed after it, or no prompts/judge.md).
   * A goal question or the fix cap keeps it.
   */
  private async judgedOn(id: WorkItemId, phase: WorkItem): Promise<boolean> {
    if (!judgeable(phase) || !(await this.goal(id))) return true;
    const j = await this.judgement(id, phase);
    return j !== null && (j.reason === JUDGE_SKIPPED || j.detail?.applied === "next" || j.detail?.applied === "done" || j.detail?.applied === "fix");
  }

  /** The phase a judge run judges: its input's, else its key's (`judge:<parent>:<phase>`, a retry's `:a<n>` after it). */
  private judgedPhase(run: Run): number | null {
    const m = /^judge:.+:(\d+)(?::a\d+)?$/.exec(run.idempotency_key);
    return run.input?.judge?.phase ?? (m ? Number(m[1]) : null);
  }

  /**
   * Applies a finished judge run to its goal split's parent (design 04-split-specs), acked in the same conditional
   * transition so a second apply is refused; the run's tokens go to the parent's token_cost. A parent no longer
   * waiting on its phases, or a run a takeover cancelled: acked, nothing else. No prompts/judge.md (`prompt_missing`):
   * the phase counts as unjudged, so the split goes on as one without a goal. Any other failure, or an answer that
   * fails parseJudge, is retried as a triage failure is (`invalid_output`); the phase stays closed. A judge that
   * reaches a retry limit stops the goal as a goal question (`judge_failed`), not as a dead run: the parent keeps a
   * state the owner's answer on the goal lifts, where max_attempts or repeated_failure would leave it unreachable.
   */
  async judgeResult(run: Run): Promise<void> {
    await this.c.unit("transitions").decide(run.work_item_id, async (it) => {
      const d = await this.judgeDecision(it, run);
      return d && d.ack_run === run.id && !("token_cost" in d.patch) ? { ...d, patch: { ...d.patch, token_cost: it.token_cost + runTokenCount(run) } } : d;
    });
  }

  private async judgeDecision(it: WorkItem, run: Run): Promise<Decision> {
    const ack = (reason: string, detail?: StateChangeDetail): Decision => ({ patch: {}, actor: SYSTEM, reason, ...(detail ? { detail } : {}), ack_run: run.id });
    if (takenOver(run) || !splitOpen(it)) return ack("run_ignored");
    const phase = this.judgedPhase(run);
    const of = `phase ${phase ?? "?"} of ${(await this.recordedPhases(it.id)).length}`;
    const stop = (limit: string, detail: StateChangeDetail) => this.waitForOwner(it, run, phase, GOAL_QUESTION, JUDGE_FAILED, { ...detail, phase, limit },
      [`The judge of ${of} could not give a verdict (${limit}), so the goal waits for the owner.`, "", `Last error: ${String(detail.error_code)}`]);
    if (run.outcome?.status !== "succeeded") {
      const code = run.outcome?.status === "failed" ? run.outcome.error_code || "unknown" : "cancelled";
      if (code === "prompt_missing") return ack(JUDGE_SKIPPED, { phase, run_id: run.id, error_code: code });
      return this.c.unit("run-results").retryOrBlock(it, run, failureClass(run.outcome), code, stop);
    }
    const parsed = parseJudge(run.outcome.data.verdict);
    if (!parsed.ok) return this.c.unit("run-results").retryOrBlock(it, run, "task", "invalid_output", stop);
    const v = parsed.value;
    const fix = v.fix ? { fix_title: v.fix.title, fix_problem: v.fix.problem, fix_done_criteria: JSON.stringify(v.fix.done_criteria), fix_allowed_paths: JSON.stringify(v.fix.allowed_paths) } : {};
    const verdict = { phase, verdict: v.verdict, reason: v.reason, run_id: run.id, ...fix };
    const found = `The judge found that the goal's lines do not hold after ${of}: ${v.reason}`;
    if (v.verdict === "fix" && v.fix) {
      // Decision 3: fix phases are filed up to the cap; past it, the owner decides on the next one.
      const filed = fixPhases(await this.c.k.d.store.listStateChanges(it.id)).length;
      if (filed < FIX_PHASE_CAP) return { ...(await this.addFixPhase(it, SYSTEM, verdict, v.fix, found)), ack_run: run.id };
      return this.waitForOwner(it, run, phase, GOAL_LIMIT, JUDGE_VERDICT, { ...verdict, applied: GOAL_LIMIT },
        [`${found}. It proposes fix phase "${v.fix.title}", but this goal already filed ${filed} fix phases, the cap of ${FIX_PHASE_CAP}, so it waits for the owner.`]);
    }
    const isLast = phase !== null && phase === (await this.lastPhase(it.id))?.phase;
    // done before the last phase goes on as next; next on the last leaves no phase to run, so the owner decides.
    const applied = v.verdict === "done" ? (isLast ? "done" : "next") : v.verdict === "next" && !isLast ? "next" : GOAL_QUESTION, detail = { ...verdict, applied };
    if (applied !== GOAL_QUESTION) {
      const said = applied === "done" ? `The judge found the goal's lines met after ${of}, the last recorded phase.` : `The judge let the goal go on after ${of}: the next phase starts.`;
      await this.c.unit("outbox").comment(it, `goal-verdict:${it.id}:${phase ?? "?"}`, `${said}\n\nReason: ${v.reason}`);
      return ack(JUDGE_VERDICT, detail);
    }
    const why = v.verdict === "ask" ? `The judge of ${of} asks the owner to decide before the goal goes on.` : `The judge answered next on ${of}, the last recorded phase, so no phase is left to run and the goal waits for the owner.`;
    return this.waitForOwner(it, run, phase, GOAL_QUESTION, JUDGE_VERDICT, detail, [why, "", `Reason: ${v.reason}`]);
  }

  /** Stops goal split `it` for the owner on `phase` (blocked_on human, `blocked`: goal_question or goal_limit), with one comment keyed on the phase. */
  private async waitForOwner(it: WorkItem, run: Run, phase: number | null, blocked: string, reason: string, detail: StateChangeDetail, lines: string[]): Promise<Decision> {
    const patch = { blocked_on: "human" as const, blocked_reason: blocked };
    const answers = "Reply `/approve` to go on (filing the proposed fix phase, if any), or `/reject <reason>` to close the goal.";
    await this.c.unit("outbox").comment(it, `${blocked.replace("_", "-")}:${it.id}:${phase ?? "?"}`, [...lines, "", answers, "", footerAfter(it, patch)].join("\n"));
    return { patch, actor: SYSTEM, reason, detail, ack_run: run.id };
  }

  /**
   * Files `fix` as the goal's next phase (design 04-split-specs; a local task, decision 1): the number after its last
   * recorded phase, held after it, keyed on its derived ref so a second pass finds the same row, with one comment in
   * the goal's thread. Returns the goal_phase_added change recording it (`sub_issue`), the goal waiting on its phases.
   */
  private async addFixPhase(it: WorkItem, actor: Actor, verdict: StateChangeDetail, fix: TriagePhase, found: string): Promise<NonNullable<Decision>> {
    const last = await this.lastPhase(it.id), index = (last?.phase ?? 0) + 1, filed = fixPhases(await this.c.k.d.store.listStateChanges(it.id)).length + 1;
    const ref = await this.takeIn(it, actor, { index, phase: fix, total: index, prev: last?.source ?? null }, localPhaseRef(it.source, index));
    const open = { blocked_on: "upstream" as const, blocked_reason: PHASES_OPEN };
    await this.c.unit("outbox").comment(it, `goal-phase:${it.id}:${index}`, [
      `${found}. So the factory filed fix phase ${index}, "${fix.title}", as a local task, ${ref.link}, which starts when phase ${index - 1} closes as completed ` +
        `(fix phase ${filed} of this goal; the cap is ${FIX_PHASE_CAP} before the owner decides).`, "", footerAfter(it, open),
    ].join("\n"));
    return { patch: splitOpen(it) ? {} : open, actor, reason: GOAL_PHASE_ADDED, detail: { ...verdict, applied: "fix", added_phase: index, sub_issue: ref.id } };
  }

  /** Whether goal split `it` waits for the owner's answer on its goal: a goal question or the fix cap. */
  waitsOnGoal(it: WorkItem): boolean {
    return it.stage === "READY" && it.blocked_on === "human" && (it.blocked_reason === GOAL_QUESTION || it.blocked_reason === GOAL_LIMIT);
  }

  /**
   * `/approve` on a goal waiting for the owner (design 04-split-specs, decision 4), inside the command's conditional
   * transition. The latest verdict's fix (`fix_*`) is filed as a fix phase, past the cap too. No fix: an applied next
   * verdict on the judged phase lets judgedOn release the next held phase; on the last recorded phase it is refused.
   */
  async approveGoal(it: WorkItem, actor: Actor): Promise<Decision | Refusal> {
    const d = (await this.c.k.d.store.listStateChanges(it.id)).filter((c) => c.reason === JUDGE_VERDICT || c.reason === JUDGE_FAILED).at(-1)?.detail ?? {};
    const phase = typeof d.phase === "number" ? d.phase : null, last = await this.lastPhase(it.id), fix = storedFix(d);
    const of = `phase ${phase ?? "?"} of ${(await this.recordedPhases(it.id)).length}`;
    if (fix) return this.addFixPhase(it, actor, { ...d, answered_by: "approve" }, fix, `The owner approved the fix phase the judge proposed after ${of}`);
    if (phase === null || last === null || phase >= (last.phase ?? 0)) {
      return { refuse: `the goal's question is on ${of}, the last recorded phase, so no held phase is left to start; reply \`/reject <reason>\` to close the goal` };
    }
    return { patch: { blocked_on: "upstream", blocked_reason: PHASES_OPEN }, actor, reason: JUDGE_VERDICT, detail: { ...d, applied: "next", answered_by: "approve" } };
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
