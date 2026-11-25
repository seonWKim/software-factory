// Applies finished runs: triage, implement, review, update and resolve outcomes, failures, retries and blocks.
// Moved out of the legacy controller (RFC 0015 M5); it reads through the kernel's reader and writes through the kernel.
// The decisions by area live beside it: retry.ts (retries and blocks), delivery.ts (PR and push waits), resolve.ts
// (conflict resolve) and notices.ts (needs-human, floor, empty diff, pauses, spec revision, unchanged head).

import { prNumber } from "../../../core/change-ref.js";
import { NO_FILES_REFUSAL, changesNoFile, commandFooter, commandState, retryPathsReply, withholdReplyLines } from "../../../core/commands.js";
import { type NeedsHuman, type ReviewOutput, SPEC_CONFLICT, type TriageOutput, doneCheckCommands, findingLine, parseNeedsHuman, parseReview, parseTriage, specFindings } from "../../../core/outputs.js";
import { AGENT_NEEDS_HUMAN, AUTO_ACTOR, AUTO_RESOLVE_LIMIT, autoApproveRefusal, REPEATED_FAILURE, type FailureClass, failureLine, repeatsFastInfraFailure, repeatsLastFailure, preflightCheck, PREFLIGHT_ACCESS, autoResolveAttempts, autoResolveKey, effectiveTier, failureClass, floorTier, isCovered, needsSpecApproval, nextAutoResolveAttempt, parseAutoResolveKey, retryDelayMs, retryKey, retryNotBefore, GITHUB_RATE_LIMITED, runKey, sameStep, STALL_STREAK_HOLD, stallStreak, takenOver, FORGE_AUTH, NO_AUTO_RETRY, CHECKS_ENV, CHECKS_ENV_LIMIT, SESSION_RELEASED, freeMigrationStamps, takenStamps } from "../../../core/policy.js";
import { FIX_SPEC_APPROVED, gatePathTouched } from "../../../core/improver.js"; import { autoApprovalDetail, ownerAnswersFor } from "../../../shared/command-notes.js";
import { isScreenshotStep, queueScreenshots, screenshotStep } from "./screenshots.js";
import { conflictCounts, conflictCountsLine } from "../../../core/resolve.js";
import { autoApprovedFooter, droppedAnswers, droppedValues, heldNote, renderSpec } from "../../../core/spec-comment.js";
import { STANDING_APPROVED, ruleId, specKind, standingActor } from "../../../core/standing.js";
import { applyCompanions } from "../../../core/companions.js";
import { atSizeCheckpoint, itemSizeCaps, sizeCheckpointNote, suggestedSplit } from "../../../core/split.js";
import { type Actor, RECURRING_FAILURE, type Run, type RunKind, type StateChangeDetail, type WorkItem, type WorkItemId, runTokenCount } from "../../../core/types.js";
import { failingTests, firstErrorLine, stripAnsi } from "../../../core/output-summary.js"; import { doneChecksDetail } from "../../../core/checks.js";
import { PROVIDER_SETUP } from "../../../interfaces/agent-runner.js";
import type { ActionRow } from "../../../outbound/index.js";
import { AUTO, DELIVERY_FAILED, type Decision, SYSTEM, UNCHANGED_HEAD, MAX_FEEDBACK_CHARS, FLOOR_TIER, CONFLICT_PENDING, quote, footerAfter, fenced, iso, keptWip, updatingForChecks } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";
import { deliveredMeanwhile, deliveryGaveUp, prDelivered, prPending, pushApplied, pushDelivered, pushPending, pushWait } from "./delivery.js";
import { EMPTY_DIFF, emptyDiff, floorBlock, forgeAuthComment, needsHuman, preflightAccessComment, specRevision, unchangedHead } from "./notices.js";
import { autoResolve, autoResolvedComment, resolveFailed } from "./resolve.js";
import { failedBlock, failedCode, leakBlock, noAutoRetry, providerSetup, retryOrBlock, sessionReleased } from "./retry.js";
import { runKindLabel } from "./run-kind-label.js";

// The area files take these values from here, which imports them already: an import of core/ or ../support.js in
// them would raise the dependency-direction and kinds counts (tests/architecture).
export type { FailureClass, NeedsHuman, RunKind, StateChangeDetail };
export {
  AGENT_NEEDS_HUMAN, AUTO_RESOLVE_LIMIT, CHECKS_ENV, CHECKS_ENV_LIMIT, DELIVERY_FAILED, FLOOR_TIER, FORGE_AUTH, MAX_FEEDBACK_CHARS, PREFLIGHT_ACCESS,
  PROVIDER_SETUP, RECURRING_FAILURE, REPEATED_FAILURE, SESSION_RELEASED, STALL_STREAK_HOLD, SYSTEM, autoResolveAttempts, autoResolveKey,
  commandFooter, commandState, conflictCounts, conflictCountsLine, doneChecksDetail, failingTests, failureClass, failureLine, fenced, firstErrorLine,
  footerAfter, isCovered, iso, nextAutoResolveAttempt, parseAutoResolveKey, prNumber, preflightCheck, quote, repeatsFastInfraFailure,
  repeatsLastFailure, retryDelayMs, retryKey, retryNotBefore, retryPathsReply, runKey, runKindLabel, sameStep, itemSizeCaps, stallStreak, stripAnsi, suggestedSplit,
  takenOver, withholdReplyLines, keptWip,
};

/** blocked_reason of an adopted PR whose review found bugs: the factory never changes a person's branch. */
const CHANGES_REQUESTED = "changes_requested";
/** The state a PR waiting on its merge conflict is in; every comment that sets it ends with its footer (`/resolve`). */
export const CONFLICT_PATCH = { stage: "REVIEW", blocked_on: "human", blocked_reason: CONFLICT_PENDING } as const;
/**
 * A failed or cancelled run's decision with its usage added to `token_cost` (design §6 Measurement): only a
 * decision that acknowledges this run, so the add lands in the ack's transaction and the ack fences it (a
 * second apply is refused as already acknowledged, and adds nothing). A run with no usage changes nothing.
 */
function withSpent(d: Decision, run: Run, it: WorkItem): Decision {
  const spent = runTokenCount(run);
  if (!d || spent === 0 || d.ack_run !== run.id || "token_cost" in d.patch) return d;
  return { ...d, patch: { ...d.patch, token_cost: it.token_cost + spent } };
}
/** An implement run's push and PR wait in outbound (RFC 0015 M7): `blocked_on: outbound`. */
export const PR_PENDING = "pr_pending";
/** An update or resolve run's push waits for outbound (RFC 0015 M7) before the review of its head is queued. */
export const PUSH_PENDING = "push_pending";

/** The PR link a run outcome carries from the forge's open result (`pr_url`), as the patch's change_url (design 02). */
function prUrlOf(data: Record<string, unknown>): { change_url?: string } {
  return typeof data.pr_url === "string" ? { change_url: data.pr_url } : {};
}
/** The spec feedback of a review with a spec finding: every finding, spec ones marked, then the summary. */
function specFeedback(r: ReviewOutput): string {
  return ["The factory reviewer found that the spec needs a change.", "", r.summary, "", ...r.findings.map((f) => `- ${findingLine(f)}`)].join("\n");
}
/** The spec feedback of an implement run that returned spec_conflict. */
function conflictFeedback(reason: string): string {
  return ["The implementer could not meet a done criterion inside the spec:", "", reason].join("\n");
}
/** What auto mode answered for each decision of a spec it approved, above the footer naming the approval (design 03-risk, #586). */
function autoAnswers(spec: TriageOutput): string {
  const items = spec.decision_items ?? [];
  const head = "Auto mode (`system:auto`) approves a spec below tier 4 with no owner-only decision and no path on the gate list.";
  if (items.length === 0) return head;
  return [head, "", "Answers taken (each decision's proposed default):", ...items.map((d) => `- ${d.text} → ${d.default}`)].join("\n");
}

/** Applies finished runs: triage, implement, review, update and resolve outcomes, failures, retries and blocks. */
export class RunResultsUnit {
  constructor(private readonly c: Ctx) {}

  async runsStep(): Promise<void> {
    for (const run of await this.c.k.reader.listUnacknowledgedRuns(20)) {
      await this.c.k.guard(`run:${run.kind}`, () => this.apply(run));
    }
    // A store read only in auto mode: the items the runs just moved to merge_pending merge in the same tick.
    await this.c.k.guard("auto merge", () => this.c.unit("local-merge").autoMergeStep());
  }

  async apply(run: Run): Promise<void> {
    // A merge-check run changes no item stage: the merge queue decides on its entry and acks it (RFC 0015 M8); a restart run's result is posted and acked (local-merge unit); a judge run's applies to its goal split (phases unit).
    // Screenshot runs and screenshot reviews post and ack, changing no item state; a passing review on a UI change queues a screenshot run first (design 04-screenshots).
    if (run.kind === "merge-check" || run.kind === "restart" || run.kind === "judge") return run.kind === "restart" ? this.c.unit("local-merge").restarted(run) : run.kind === "judge" ? this.c.unit("phases").judgeResult(run) : this.c.unit("merge-queue").checked(run);
    if (isScreenshotStep(run)) return screenshotStep(this.c, run, runTokenCount(run)); else await this.c.k.guard("screenshots", () => queueScreenshots(this.c, run));
    // A succeeded improve run's groups are filed before its ack (design §7); a fault is logged and the run acked.
    if (run.kind === "improve" && run.outcome?.status === "succeeded") await this.c.k.guard("improve filing", () => this.c.unit("improve").fileImprove(run));
    // A finished routine run's findings become pending suggestions before its ack; a fault is logged and the run acked.
    if (run.kind === "routine") await this.c.k.guard("routine findings", () => this.c.unit("routines").recordFindings(run));
    const ack = (reason: string): Decision => ({ patch: {}, actor: SYSTEM, reason, ack_run: run.id });
    // Every finished run adds its tokens to token_cost, an ignored one included (design §6 Measurement): `withSpent`
    // adds them to each decision that does not set token_cost itself.
    const decision = async (it: WorkItem): Promise<Decision> => {
      // An improve run changes nothing else on its system item (design §7): its report is already stored.
      if (run.kind === "improve") return ack(run.outcome?.status === "succeeded" ? "improve_done" : "improve_failed");
      // A routine run changes nothing on its item either: it is read-only, and what it found is in its stored outcome.
      if (run.kind === "routine") return ack(run.outcome?.status === "succeeded" ? "routine_done" : "routine_failed");
      // The run's full token count (design §6 Measurement); old succeeded rows keep the data.tokens they stored.
      const tokens = it.token_cost + runTokenCount(run);
      if (!run.outcome || run.outcome.status !== "succeeded") return this.c.unit("model-probe").stallScope(run, await this.applyFailedRun(it, run));
      if (!this.c.unit("transitions").expects(it, run.kind)) return ack("run_ignored");
      const data = run.outcome.data;
      // The agent asked for a human (decided 2026-11-07): a finished run with data, never retried on its own.
      if ((run.kind === "implement" || run.kind === "review" || run.kind === "resolve") && data.needs_human != null) {
        const ask = parseNeedsHuman(data.needs_human);
        if (ask.ok && ask.value) return needsHuman(this.c, it, run, ask.value, tokens);
        if (run.kind === "resolve") return resolveFailed(this.c, it, run, "invalid_output");
        return this.retryOrBlock(it, run, "task", "invalid_output");
      }

      switch (run.kind) {
        case "merge-check": case "restart": case "judge": case "screenshot": // `apply` hands these to the merge queue, the local-merge unit, the phases unit and screenshots.ts before it reads any outcome.
          throw new Error(`${run.kind} run ${run.id} reached the run outcome path`);
        case "triage": { const context = await this.c.unit("commands").applyQueued(it, { patch: { token_cost: tokens }, actor: SYSTEM, reason: "triaged", ack_run: run.id }); if (context.enqueue) return context; // added context: one more triage (design 02-attachments)
          // The item's size caps (src/core/size-cap.ts) decide whether the estimate needs phases (src/core/split.ts).
          const settings = this.c.k.settings(it.project), { floors } = settings, caps = await itemSizeCaps(this.c.k.reader, it.id, settings);
          // Migration timestamps, then path companions (design 04-triage.md): a new migration on a base branch's timestamp moves to the next free minute; companions on that answer, so one named only in
          // files_to_change is covered, and before the floor, which raises the tier or refuses a built-in rule's path.
          const { answer, added } = applyCompanions(freeMigrationStamps(data.spec, takenStamps((await this.c.k.reader.baseFiles("src/")) ?? [])).answer, this.c.k.cfg.path_companions ?? [], floors);
          const parsed = parseTriage(answer, { check_commands: doneCheckCommands(this.c.k.cfg.repo) }); // done_checks required (design 04-triage); no caps: 1 or over 4 phases is refused, an oversize estimate with none waits at its size checkpoint below
          if (!parsed.ok) return this.retryOrBlock(it, run, "task", "invalid_output");
          const spec = parsed.value;
          const floor = floorTier(spec.allowed_paths, floors);
          const tier = effectiveTier(spec.tier, floor, it.tier);
          const fields = {
            problem: spec.problem,
            done_criteria: spec.done_criteria,
            desired_output: spec.desired_output,
            scope: spec.scope,
            allowed_paths: spec.allowed_paths,
            files_to_change: spec.files_to_change, // the coordination cost's input until the PR exists (design §5, 2026-11-03)
            done_checks: spec.done_checks ?? null,
            tier,
            token_cost: tokens,
          };
          const missing = droppedValues(spec, it.issue_text), answers = droppedAnswers(spec, await ownerAnswersFor(it, (id) => this.c.k.reader.listStateChanges(id))), held = missing.length + answers.length > 0, noFiles = changesNoFile(spec), oversize = atSizeCheckpoint(spec, caps), waitsAnyway = held || noFiles || oversize; // dropped request values or owner answers, no file changed here (design 04-spec-gate-commands), or over the split threshold with no phases (its size checkpoint): no approval without a person
          // Each approval below without a person's reply: the spec comment with its note, no answer block and `footer`, RUNNING, the implement run queued.
          const approved = async (note: readonly string[], how: { actor: Actor; reason: string; detail?: StateChangeDetail }, footer = footerAfter(it, { stage: "RUNNING" })): Promise<Decision> => {
            const patch = { ...fields, stage: "RUNNING" as const };
            const url = await this.c.unit("outbox").comment(it, `spec:${run.id}`,
              renderSpec(spec, tier, { floor, previous: it.tier, added }, [...note, "", footer].join("\n"), { approved: true }), "spec_comment_url");
            return { patch: { ...patch, spec_comment_url: url }, ...how, ack_run: run.id, enqueue: { kind: "implement", idempotency_key: runKey({ ...it, ...fields }, "implement") } };
          };
          // A split spec always waits for a human: its /approve files issues on the source.
          const byParent = !noFiles && (await this.c.unit("phases").approvedByParent(it, spec));
          if (byParent) {
            // phases_auto_approve: the owner's /approve of the split covers this phase's spec (design 2026-11-01), held values or answers too.
            const next = { ...it, ...fields };
            const patch = { ...fields, stage: "RUNNING" as const };
            const url = await this.c.unit("outbox").comment(it, `spec:${run.id}`,
              renderSpec(spec, tier, { floor, previous: it.tier, added }, [
                "The owner approved the split on the parent issue (`phases_auto_approve`), so this phase is implemented without its own `/approve`.",
                "",
                footerAfter(it, patch),
              ].join("\n"), { approved: true }), "spec_comment_url");
            return {
              patch: { ...patch, spec_comment_url: url },
              actor: SYSTEM,
              reason: "triaged_phase_approved",
              detail: { parent_work_item_id: it.parent_id! },
              ack_run: run.id,
              enqueue: { kind: "implement", idempotency_key: runKey(next, "implement") },
            };
          }
          if (!waitsAnyway && !spec.phases && !needsSpecApproval(tier, this.c.k.cfg.dials)) {
            const next = { ...it, ...fields };
            return {
              patch: { ...fields, stage: "RUNNING" },
              actor: SYSTEM,
              reason: "triaged_auto_approved",
              ack_run: run.id,
              enqueue: { kind: "implement", idempotency_key: runKey(next, "implement") },
            };
          }
          // The factory's fix for a recurring failure runs without a person (design §7); a gate-path change still waits for a person's merge.
          const fix = spec.phases || waitsAnyway ? null : await this.c.unit("improve").fixPattern(it);
          if (fix) {
            const gate = gatePathTouched(spec.allowed_paths);
            return approved([
              "Approved without a person: this item is the factory's fix for a recurring failure, so it is implemented and reviewed on its own.",
              ...(gate ? [`It touches the gate list (\`${gate}\`), so its change waits for a person's merge.`] : []),
            ], { actor: SYSTEM, reason: FIX_SPEC_APPROVED, detail: { pattern_key: fix.pattern_key } });
          }
          // A standing rule approves a tier 1 spec that would wait here, never one that touches protected paths.
          const rule = spec.phases || waitsAnyway ? null : await this.c.unit("standing").standingRule(it, tier, spec.allowed_paths);
          if (rule) {
            const id = ruleId(rule.gate, rule.tier);
            return approved([
              `Approved by the standing rule \`${id}\` (turned on by \`${rule.set_by}\`): a tier ${rule.tier} spec that waits at the spec gate is approved without a reply.`,
              `To turn the rule off, reply \`/standing decline ${id}\`, or \`/revise <feedback>\` or \`/reject <reason>\` on an item it approved.`,
            ], {
              actor: standingActor(rule.gate, rule.tier),
              reason: STANDING_APPROVED,
              detail: { standing_rule: id, gate: rule.gate, tier: rule.tier, kind: specKind(it, false), owner_id: rule.set_by },
            });
          }
          // Auto mode (design 03-risk): a spec it may approve starts with each decision's default; any other waits.
          const auto = spec.phases || waitsAnyway ? null : await this.c.unit("local-merge").autoMode(it.project);
          // Auto mode approves under the controller's service passport (RFC 0015 §8).
          const refusal = auto
            ? autoApproveRefusal({ tier, decisions: spec.decision_items ?? [], gate_path: gatePathTouched(spec.allowed_paths) })
              ?? (await this.c.unit("auth").automatic("approve_spec", it))
            : null;
          if (auto && refusal === null) {
            return approved([autoAnswers(spec)], {
              actor: AUTO,
              reason: "spec_approved",
              detail: autoApprovalDetail({ approved_by: AUTO_ACTOR, mode_change: auto.seq }, spec.decision_items ?? []),
            }, autoApprovedFooter(commandState({ ...it, stage: "RUNNING" }), tier, this.c.k.d.clock.now().toISOString()));
          }
          const patch = { ...fields, stage: "READY" as const, blocked_on: "human" as const, blocked_reason: "spec_pending" };
          const waits = noFiles ? `This spec cannot be approved: ${NO_FILES_REFUSAL}.\n\n` : oversize ? `${sizeCheckpointNote(spec, caps)}\n\n${held ? heldNote(missing, answers) : ""}` : held ? heldNote(missing, answers) : auto ? `Auto mode is on, but this spec waits for \`/approve\`: ${refusal}.\n\n` : "";
          const url = await this.c.unit("outbox").comment(it, `spec:${run.id}`, renderSpec(spec, tier, { floor, previous: it.tier, added }, // no `/approve` in a no-file spec's footer
            `${waits}${noFiles ? commandFooter(commandState({ ...it, ...patch }), ["approve"]) : footerAfter(it, patch)}`, { missing, answers }), "spec_comment_url");
          return {
            patch: { ...patch, spec_comment_url: url },
            actor: SYSTEM,
            reason: "triaged", ack_run: run.id,
          };
        }
        case "implement": {
          if (data.floor_block === true) return floorBlock(this.c, it, run, data, tokens);
          // What the PR changes, for the coordination cost (design §5, 2026-11-03); absent on older outcomes.
          const files = Array.isArray(data.files) && data.files.every((f) => typeof f === "string") ? (data.files as string[]) : null;
          // The run stored its push and PR as intents (RFC 0015 M7): the item waits for outbound, and `prDelivered`
          // applies the PR number and queues the review once the PR delivery completes. One delivered before this
          // result is applied (outbound ran first) is applied here, so the wait never misses it.
          if (data.pr_pending === true) return prPending(this.c, it, run, data, { token_cost: tokens, ...(files ? { pr_files: files } : {}) }, "implemented", doneChecksDetail(data));
          // No PR (the local broker, design 05-sources): the item reviews and merges as its local branch.
          const pr = data.pr_number === null || data.pr_number === undefined ? null : Number(data.pr_number);
          return this.c.unit("commands").applyQueued(it, {
            patch: {
              stage: "REVIEW",
              change_ref: pr === null ? null : String(pr),
              ...prUrlOf(data),
              token_cost: tokens,
              ...(files ? { pr_files: files } : {}),
              ...(it.blocked_on === "dependency" ? { blocked_on: "none" as const, blocked_reason: null } : {}),
            },
            actor: SYSTEM,
            reason: "implemented", ...(doneChecksDetail(data) ? { detail: doneChecksDetail(data)! } : {}), // each done-when line's result (design 04-pre-push-gates)
            ack_run: run.id,
            enqueue: { kind: "review", idempotency_key: runKey(it, "review"), input: await this.c.unit("checks-gate").reviewInput(pr, it.id) },
          });
        }
        case "review": {
          // The worker withheld finding text its scan flagged (issue #222): only the rule names reached here.
          if (Array.isArray(data.egress_rules)) return leakBlock(this.c, it, run, data.egress_rules.map(String), { token_cost: tokens }, "review");
          // The worker's cheap checks (issue #223): nothing to review, or the head the last verdict was for (unchangedHead).
          if (data.no_agent === EMPTY_DIFF) return emptyDiff(this.c, it, run, tokens);
          if (data.no_agent === UNCHANGED_HEAD) return unchangedHead(this.c, it, run);
          const parsed = parseReview(data.review); // routes on `findings` only: confirmed ones; `unconfirmed` never sends the item back (design 04-agents)
          if (!parsed.ok) return this.retryOrBlock(it, run, "task", "invalid_output");
          const tier = effectiveTier(parsed.value.tier, floorTier(it.allowed_paths, this.c.k.settings(it.project).floors), it.tier); await this.c.unit("improve").captureReview(it, run, parsed.value.findings);
          if (parsed.value.verdict === "bug" && it.origin === "adopted") {
            // A person's branch: the review comment is on the PR, and the author fixes it. No implement run.
            return {
              patch: { tier, token_cost: tokens, blocked_on: "human", blocked_reason: CHANGES_REQUESTED },
              actor: SYSTEM,
              reason: CHANGES_REQUESTED,
              detail: { run_id: run.id },
              ack_run: run.id,
            };
          }
          const spec = specFindings(parsed.value);
          if (parsed.value.verdict === "bug" || spec.length > 0) {
            // Finding text becomes the next run's input or the spec feedback: scanned before anything is stored.
            const scan = await this.c.k.d.scanner.scan("comment", parsed.value.findings.map((f) => f.text).join("\n"));
            if (!scan.clean) return leakBlock(this.c, it, run, scan.findings.map((f) => f.rule), { tier, token_cost: tokens }, "review");
          }
          // Any spec finding: the implementer cannot fix it inside the spec, so the spec is revised (issue #222).
          if (spec.length > 0) return specRevision(this.c, it, run, specFeedback(parsed.value), { tier, token_cost: tokens }, "review");
          if (parsed.value.verdict === "bug") return this.c.unit("checks-gate").reviewBug(it, run, { tier, token_cost: tokens });
          return this.c.unit("checks-gate").checkGate(it, run, { tier, token_cost: tokens }, run.id);
        }
        case "resolve": {
          // A base reconcile (design 05-sources): its checked merge waits for the merge queue, never for a review.
          if (this.c.unit("local-merge").reconcileOf(it)) {
            return { patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", token_cost: tokens }, actor: SYSTEM, reason: "resolved", detail: { cause: "base_reconcile" }, ack_run: run.id };
          }
          // The worker pushed the merge to the same PR branch. A fresh review checks it; its key comes from
          // this run's id, so it never collides with the review of an earlier loop or resolve.
          await autoResolvedComment(this.c, it, run);
          if (await pushPending(this.c, data)) return pushWait(run, "resolved", { token_cost: tokens });
          const pushed = await pushApplied(this.c, it, run);
          return { ...pushed, patch: { ...pushed.patch, token_cost: tokens }, reason: "resolved", ack_run: run.id };
        }
        case "manual":
          // Written already acknowledged, so never here; kept for exhaustiveness.
          return ack("run_ignored");
        case "interactive": {
          // `session finish` passed every gate and stored its branch through the broker (design §5, 2026-11-01): as an implement PR.
          const files = Array.isArray(data.files) && data.files.every((f) => typeof f === "string") ? { pr_files: data.files as string[] } : {};
          const detail = { run_id: run.id, ...(run.actor_id ? { actor_id: run.actor_id } : {}) };
          // A forge item's push and PR are outbound's (RFC 0015 M7), as an implement run's: the item waits for the PR.
          if (data.pr_pending === true) return prPending(this.c, it, run, data, { token_cost: tokens, ...files }, "session_finished", detail);
          // No PR (a local item, design 05-sources): it reviews and merges as its local branch, as an implement run's.
          const pr = data.pr_number === null || data.pr_number === undefined ? null : Number(data.pr_number);
          const input = await this.c.unit("checks-gate").reviewInput(pr, it.id);
          return this.c.unit("commands").applyQueued(it, {
            patch: { stage: "REVIEW", change_ref: pr === null ? null : String(pr), ...prUrlOf(data), token_cost: tokens, ...files }, actor: SYSTEM, reason: "session_finished", detail,
            ack_run: run.id, enqueue: { kind: "review", idempotency_key: runKey(it, "review"), input },
          });
        }
        case "update": {
          // The worker already commented on the PR. A PR waiting for a merge stays in REVIEW waiting for a human; one
          // whose checks failed (CHECKS_FAILED_UPDATE) is reviewed again on the pushed head, or, already up to date,
          // goes on to the implement run the update held back.
          const beforeImplement = updatingForChecks(it);
          switch (data.result) {
            case "pushed":
              if (beforeImplement) {
                if (await pushPending(this.c, data)) return pushWait(run, "update_pushed", {});
                return { ...(await pushApplied(this.c, it, run)), reason: "update_pushed", ack_run: run.id };
              }
              return { patch: {}, actor: SYSTEM, reason: "update_pushed", ack_run: run.id };
            case "up_to_date": {
              const review = beforeImplement ? await this.latestReview(it.id) : undefined;
              return review ? this.c.unit("checks-gate").checkGate(it, review, {}, run.id) : ack("update_up_to_date");
            }
            case "conflict":
              return this.autoResolve(it, typeof data.base_sha === "string" ? data.base_sha : "", { run_id: run.id }, run.id);
            case "tests_failed":
              // The worker's PR comment names the failure; this one offers the command that applies now.
              await this.c.unit("outbox").prComment(it, `update-tests-failed:${run.id}`, [
                `The base branch merged cleanly into PR #${it.change_ref}, but the tests failed on the updated branch, so nothing was pushed.`,
                "Comment `/resolve [notes]` to let an agent fix it, or fix it by hand.",
                "",
                footerAfter(it, CONFLICT_PATCH),
              ].join("\n"));
              return { patch: CONFLICT_PATCH, actor: SYSTEM, reason: "update_tests_failed", ack_run: run.id };
            default:
              return {
                // No comment is posted for this one, so an older failure link must not stand in for it.
                patch: { blocked_reason: "run_failed:update:invalid_output", failure_comment_url: null },
                actor: SYSTEM,
                reason: "run_failed",
                ack_run: run.id,
              };
          }
        }
      }
    };
    await this.c.unit("transitions").decide(run.work_item_id, async (it) => this.landed(it, run, withSpent(await decision(it), run, it)));
    await deliveredMeanwhile(this.c, run);
    if (run.kind === "resolve" && run.outcome?.status === "succeeded") await this.c.unit("local-merge").reconciled(run.work_item_id, run.id);
  }

  /**
   * A failed run's outcome always lands (design 05-restarts, 2026-11-11): a decision the WorkItem state table refuses
   * becomes the plain failed-run block, so `/retry` works and the run is acknowledged, not refused on every tick.
   */
  private async landed(it: WorkItem, run: Run, d: Decision): Promise<Decision> {
    if (!d || run.outcome?.status === "succeeded" || this.c.unit("transitions").inTable(it, d.patch)) return d;
    return withSpent(await this.failedBlock(it, run), run, it);
  }

  /** A failed or cancelled run's decision, before its usage is added (`apply` does that). A takeover's run: no retry (05-restarts). */
  async applyFailedRun(it: WorkItem, run: Run): Promise<Decision> {
    // One owner comment per forge-auth pause, from the run that started it (marker-keyed on the pause end).
    if (run.outcome?.status === "failed" && run.outcome.error_code === FORGE_AUTH && run.outcome.pause_started) {
      await forgeAuthComment(this.c, it, run);
    }
    // The same for a preflight-access pause (issue #216), keyed on its own pause end.
    if (run.outcome?.status === "failed" && run.outcome.error_code === PREFLIGHT_ACCESS && run.outcome.pause_started) {
      await preflightAccessComment(this.c, it, run);
    }
    // A run a transition cancelled with no outcome (a close, a block, or a `/retry +paths` that queued its replacement) is no failure to retry.
    if (takenOver(run) || (run.status === "cancelled" && !run.outcome) || !this.c.unit("transitions").expects(it, run.kind)) return { patch: {}, actor: SYSTEM, reason: "run_ignored", ack_run: run.id };
    const code = failedCode(run);
    if (run.kind === "resolve") return resolveFailed(this.c, it, run, code);
    if (run.kind === "interactive") return sessionReleased(it, run, code);
    // The provider's account or config needs a person (design §5 Restarts): no retry would get further.
    if (code === PROVIDER_SETUP) return providerSetup(this.c, it, run);
    // The implementer reported a criterion the spec does not let it meet (issue #222): a spec revision, not a block.
    if (run.kind === "implement" && code === SPEC_CONFLICT) {
      const reason = run.outcome?.status === "failed" ? run.outcome.detail.trim() : "";
      const scan = await this.c.k.d.scanner.scan("comment", reason);
      if (!scan.clean) return leakBlock(this.c, it, run, scan.findings.map((f) => f.rule), {}, "implement");
      return specRevision(this.c, it, run, conflictFeedback(reason), {}, "implement");
    }
    // Deterministic codes, diff_too_large among them (design §5 Restarts): the same spec fails the same way.
    if (run.kind === "implement" && NO_AUTO_RETRY.includes(code)) return noAutoRetry(this.c, it, run, code);
    // A forge rate limit is no attempt for an update run either: it waits for the reset (design §5 Restarts).
    if (run.kind !== "update" || code === GITHUB_RATE_LIMITED) return this.retryOrBlock(it, run, failureClass(run.outcome), code);
    return this.failedBlock(it, run, code);
  }

  /** The plain failed-run block: blocked on a human with `run_failed:<kind>:<code>`, one comment offering `/retry` (retry.ts). */
  async failedBlock(it: WorkItem, run: Run, code = failedCode(run)): Promise<Decision> {
    return failedBlock(this.c, it, run, code);
  }

  /** A failed triage, implement, review or judge run: a retry under its limits, else a block (retry.ts). */
  async retryOrBlock(it: WorkItem, run: Run, cls: FailureClass, code: string, stop?: (limit: string, detail: StateChangeDetail) => Promise<Decision>): Promise<Decision> {
    return retryOrBlock(this.c, it, run, cls, code, stop);
  }

  /** A conflict to resolve with no person: an automatic resolve run, or a wait for a person at the limit (resolve.ts). */
  async autoResolve(it: WorkItem, baseSha: string, cause: StateChangeDetail, ack_run: Run["id"] | null): Promise<Decision> {
    return autoResolve(this.c, it, baseSha, cause, ack_run);
  }

  /** Outbound gave up a run's PR or push: an item still waiting for it waits for a person (delivery.ts). */
  async deliveryGaveUp(id: WorkItemId, a: ActionRow): Promise<void> {
    return deliveryGaveUp(this.c, id, a);
  }

  /** Outbound delivered an implement run's PR: the wait ends and the review is queued (delivery.ts). */
  async prDelivered(id: WorkItemId, ref: string, url: string | null): Promise<void> {
    return prDelivered(this.c, id, ref, url);
  }

  /** Outbound delivered an update or resolve run's push: the review of the pushed head is queued (delivery.ts). */
  async pushDelivered(id: WorkItemId, run_id: string): Promise<void> {
    return pushDelivered(this.c, id, run_id);
  }

  /** A run kind's plain label for owner text ("Merge check"), from the one map (run-kind-label.ts). */
  kindLabel(kind: RunKind): string {
    return runKindLabel(kind);
  }

  /** The item's latest succeeded review run, the one the CI gate applies to. */
  async latestReview(id: WorkItemId): Promise<Run | undefined> {
    return (await this.c.k.reader.listRuns(id)).filter((r) => r.kind === "review" && r.outcome?.status === "succeeded" && r.input?.screenshot_review !== true).at(-1);
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "run-results": RunResultsUnit;
  }
}

export default controllerUnit({
  name: "run-results",
  create: (c: Ctx) => new RunResultsUnit(c),
  steps: [
    { name: "runs", every: "tick", order: 90, run: (u) => u.runsStep() },
  ],
});
