// Applies finished runs: triage, implement, review, update and resolve outcomes, failures, retries and blocks.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { prNumber } from "../../../core/change-ref.js";
import { commandFooter, commandState, retryPathsReply } from "../../../core/commands.js";
import { type NeedsHuman, type ReviewOutput, SPEC_CONFLICT, type TriageOutput, findingLine, parseNeedsHuman, parseReview, parseTriage, specFindings } from "../../../core/outputs.js";
import { AGENT_NEEDS_HUMAN, AUTO_ACTOR, AUTO_RESOLVE_LIMIT, autoApproveRefusal, REPEATED_FAILURE, type FailureClass, failureLine, repeatsFastInfraFailure, repeatsLastFailure, preflightCheck, PREFLIGHT_ACCESS, autoResolveAttempts, autoResolveKey, effectiveTier, failureClass, floorTier, isCovered, needsSpecApproval, nextAutoResolveAttempt, parseAutoResolveKey, retryDelayMs, retryKey, retryNotBefore, GITHUB_RATE_LIMITED, runKey, sameStep, FORGE_AUTH, NO_AUTO_RETRY, CHECKS_ENV, CHECKS_ENV_LIMIT, SESSION_RELEASED } from "../../../core/policy.js";
import { FIX_SPEC_APPROVED, gatePathTouched } from "../../../core/improver.js"; import { autoApprovalDetail, ownerAnswersFor } from "../../../shared/command-notes.js";
import { dependencyStop } from "./dependency-stop.js";
import { conflictCounts, conflictCountsLine } from "../../../core/resolve.js";
import { autoApprovedFooter, droppedAnswers, droppedValues, heldNote, renderSpec } from "../../../core/spec-comment.js";
import { STANDING_APPROVED, ruleId, specKind, standingActor } from "../../../core/standing.js";
import { applyCompanions } from "../../../core/companions.js";
import { suggestedSplit } from "../../../core/split.js";
import { type Actor, type Run, type StateChangeDetail, type Tier, type WorkItem, type WorkItemId, runTokenCount } from "../../../core/types.js";
import { failingTests, firstErrorLine, stripAnsi } from "../../../core/output-summary.js";
import { PROVIDER_SETUP } from "../../../interfaces/agent-runner.js";
import type { ActionRow } from "../../../outbound/index.js";
import { AUTO, DELIVERY_FAILED, type Decision, SYSTEM, UNCHANGED_HEAD, MAX_FEEDBACK_CHARS, FLOOR_TIER, CONFLICT_PENDING, quote, footerAfter, fenced, iso, updatingForChecks } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** blocked_reason of an adopted PR whose review found bugs: the factory never changes a person's branch. */
const CHANGES_REQUESTED = "changes_requested";
/** A review with nothing to review: no commits ahead of the base, or an empty diff (issue #223). */
const EMPTY_DIFF = "empty_diff";
/** The state a PR waiting on its merge conflict is in; every comment that sets it ends with its footer (`/resolve`). */
const CONFLICT_PATCH = { stage: "REVIEW", blocked_on: "human", blocked_reason: CONFLICT_PENDING } as const;
/** error_code of an implement run whose diff is over max_diff_lines or max_diff_files (design §4). */
const DIFF_TOO_LARGE = "diff_too_large";
/** A failed run's error code (`unknown` when the stored outcome has none), or `cancelled`. */
const failedCode = (run: Run): string => (run.outcome?.status === "failed" ? run.outcome.error_code || "unknown" : "cancelled");
/**
 * A failed or cancelled run's decision with its usage added to `token_cost` (design §6 Measurement): only a
 * decision that acknowledges this run, so the add lands in the ack's transaction and the ack fences it (a
 * second apply is refused as already acknowledged, and adds nothing). A run with no usage changes nothing.
 */
/**
 * A session that ended without a PR (abandoned, lease lost), design §5, 2026-11-01: never retried. The item is released:
 * RUNNING, blocked on a human with `session_released`, nothing queued, for the next `session start`. A pushed branch stays.
 */
function sessionReleased(_it: WorkItem, run: Run, code: string): Decision {
  const detail = { run_id: run.id, error_code: code, ...(run.actor_id ? { actor_id: run.actor_id } : {}) };
  return { patch: { blocked_on: "human", blocked_reason: SESSION_RELEASED }, actor: SYSTEM, reason: SESSION_RELEASED, detail, ack_run: run.id };
}
function withSpent(d: Decision, run: Run, it: WorkItem): Decision {
  const spent = runTokenCount(run);
  if (!d || spent === 0 || d.ack_run !== run.id || "token_cost" in d.patch) return d;
  return { ...d, patch: { ...d.patch, token_cost: it.token_cost + spent } };
}
/** The PR link a run outcome carries from the forge's open result (`pr_url`), as the patch's change_url (design 02). */
/** An implement run's push and PR wait in outbound (RFC 0015 M7): `blocked_on: outbound`. */
export const PR_PENDING = "pr_pending";
/** An update or resolve run's push waits for outbound (RFC 0015 M7) before the review of its head is queued. */
export const PUSH_PENDING = "push_pending";

function prUrlOf(data: Record<string, unknown>): { change_url?: string } {
  return typeof data.pr_url === "string" ? { change_url: data.pr_url } : {};
}
const FAILURES: Record<string, string> = {
  invalid_output: "the agent's answer did not have the expected shape",
  no_commits: "the implementer made no commits",
  scope_violation: "the branch changed files outside the allowed paths",
  diff_too_large: "the branch diff is over max_diff_lines or max_diff_files",
  merge_conflict: "the branch conflicts with the base branch and the conflict could not be resolved; nothing was pushed",
  untrusted_base: "the base fetched before pushing does not contain the base the run started from; nothing was pushed",
  out_of_scope: "the resolve run changed files that are neither conflicting nor under the allowed paths",
  tests_failed: "the install or test command failed on the resolved branch",
  // The implement run's code (design §4, 2026-11-03): a task failure, retried up to max_attempts. Not the
  // CHECKS_FAILED blocked reason above, which is a failed PR check after review (design §5 CI gate).
  checks_failed: "a check before push (repo.check_commands) failed, also after one fix step; nothing was pushed to the PR branch",
  checks_env: "a check before push failed, also after one fix step, and its failing test files fail on the base commit too (flaky or broken on the base); retried without spending an attempt or a restart",
  toolchain_missing: "a check before push could not start its tools (a module under node_modules or a tool binary is missing); an infrastructure failure, retried without spending an attempt",
  unresolved_conflicts: "conflicts were left unresolved",
  head_moved: "the install or test command moved HEAD off the commit the gates checked",
  prompt_missing: "prompts/resolve.md is missing",
  push_failed: "the push was rejected",
  forge_auth: "the forge refused the factory's credentials (401 or 403); implement and update runs are paused",
  preflight_failed: "a check before the agent started failed (the base fetch); no agent ran",
  preflight_access: "the push access or PR API check before the agent started failed; implement and update runs are paused",
  rate_limited: "the model provider's usage or rate limit was hit",
  github_rate_limited: "the forge's API rate limit was hit; implement, update and review runs are paused until it resets",
  provider_setup: "the model provider refused the account or config: its quota, the API key or the model name; nothing was retried",
  egress_blocked: "the output was stopped by the leak scanner",
  agent_failed: "the agent exited with an error",
  agent_timed_out: "the agent run timed out",
  agent_stalled: "the model printed nothing for stall_ms with no tool call open; runs are paused until a probe answers",
  lease_lost: "the worker lost its lease on the run (stopped, crashed or slept)",
  lease_expired: "the run's lease expired with no heartbeat (the worker stopped, crashed or slept)",
  exception: "the worker hit an unexpected error",
  git_failed: "a git command failed",
  cancelled: "the run was cancelled",
};
/** The spec feedback of a review with a spec finding: every finding, spec ones marked, then the summary. */
function specFeedback(r: ReviewOutput): string {
  return ["The factory reviewer found that the spec needs a change.", "", r.summary, "", ...r.findings.map((f) => `- ${findingLine(f)}`)].join("\n");
}
/** The spec feedback of an implement run that returned spec_conflict. */
function conflictFeedback(reason: string): string {
  return ["The implementer could not meet a done criterion inside the spec:", "", reason].join("\n");
}
function describeFailure(code: string): string {
  return FAILURES[code] ?? "the run failed";
}
function parseFloorHits(v: unknown): { path: string; tier: number }[] {
  if (!Array.isArray(v)) return [];
  const hits = v.filter(
    (h): h is { path: string; tier: number } =>
      typeof h === "object" && h !== null && typeof h.path === "string" && Number.isInteger(h.tier) && h.tier >= 1 && h.tier <= 5,
  );
  return hits.length === v.length ? hits : [];
}
/** A PR that passed review and waits for a human merge, the state an update run usually changes. */
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
    // A merge-check run changes no item stage: the merge queue decides on its entry and acks it (RFC 0015 M8).
    if (run.kind === "merge-check") return this.c.unit("merge-queue").checked(run);
    // A succeeded improve run's groups are filed before its ack (design §7); a fault is logged and the run acked.
    if (run.kind === "improve" && run.outcome?.status === "succeeded") await this.c.k.guard("improve filing", () => this.c.unit("improve").fileImprove(run));
    const ack = (reason: string): Decision => ({ patch: {}, actor: SYSTEM, reason, ack_run: run.id });
    // Every finished run adds its tokens to token_cost, an ignored one included (design §6 Measurement): `withSpent`
    // adds them to each decision that does not set token_cost itself.
    const decision = async (it: WorkItem): Promise<Decision> => {
      // An improve run changes nothing else on its system item (design §7): its report is already stored.
      if (run.kind === "improve") return ack(run.outcome?.status === "succeeded" ? "improve_done" : "improve_failed");
      // The run's full token count (design §6 Measurement); old succeeded rows keep the data.tokens they stored.
      const tokens = it.token_cost + runTokenCount(run);
      if (!run.outcome || run.outcome.status !== "succeeded") return this.applyFailedRun(it, run);
      if (!this.c.unit("transitions").expects(it, run.kind)) return ack("run_ignored");
      const data = run.outcome.data;
      // The agent asked for a human (decided 2026-11-07): a finished run with data, never retried on its own.
      if ((run.kind === "implement" || run.kind === "review" || run.kind === "resolve") && data.needs_human != null) {
        const ask = parseNeedsHuman(data.needs_human);
        if (ask.ok && ask.value) return this.needsHuman(it, run, ask.value, tokens);
        if (run.kind === "resolve") return this.resolveFailed(it, run, "invalid_output");
        return this.retryOrBlock(it, run, "task", "invalid_output");
      }

      switch (run.kind) {
        case "merge-check":
          // `apply` hands merge-check runs to the merge queue before it reads any outcome.
          throw new Error(`merge-check run ${run.id} reached the run outcome path`);
        case "triage": {
          // The item's size caps decide whether the estimate needs phases (src/core/split.ts).
          const { max_diff_lines, max_diff_files } = this.c.k.settings(it.project);
          // Path companions first (design 04-triage.md): on the raw answer, so a companion triage named only in
          // files_to_change is covered, and before the floor, so an added path under a floor raises the tier.
          const { answer, added } = applyCompanions(data.spec, this.c.k.cfg.path_companions ?? []);
          const parsed = parseTriage(answer, { max_diff_lines, max_diff_files });
          if (!parsed.ok) return this.retryOrBlock(it, run, "task", "invalid_output");
          const spec = parsed.value;
          const floor = floorTier(spec.allowed_paths, this.c.k.settings(it.project).floors);
          const tier = effectiveTier(spec.tier, floor, it.tier);
          const fields = {
            problem: spec.problem,
            done_criteria: spec.done_criteria,
            desired_output: spec.desired_output,
            scope: spec.scope,
            allowed_paths: spec.allowed_paths,
            // The coordination cost's input until the PR exists (design §5, 2026-11-03).
            files_to_change: spec.files_to_change,
            tier,
            token_cost: tokens,
          };
          const missing = droppedValues(spec, it.issue_text), answers = droppedAnswers(spec, await ownerAnswersFor(it, (id) => this.c.k.reader.listStateChanges(id))), held = missing.length + answers.length > 0; // dropped request values or owner answers: no approval without /approve below
          // Each approval below without a person's reply: the spec comment with its note, no answer block and `footer`, RUNNING, the implement run queued.
          const approved = async (note: readonly string[], how: { actor: Actor; reason: string; detail?: StateChangeDetail }, footer = footerAfter(it, { stage: "RUNNING" })): Promise<Decision> => {
            const patch = { ...fields, stage: "RUNNING" as const };
            const url = await this.c.unit("outbox").comment(it, `spec:${run.id}`,
              renderSpec(spec, tier, { floor, previous: it.tier, added }, [...note, "", footer].join("\n"), { approved: true }), "spec_comment_url");
            return { patch: { ...patch, spec_comment_url: url }, ...how, ack_run: run.id, enqueue: { kind: "implement", idempotency_key: runKey({ ...it, ...fields }, "implement") } };
          };
          // A split spec always waits for a human: its /approve files issues on the source.
          const byParent = !spec.phases && (await this.c.unit("phases").approvedByParent(it));
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
          if (!held && !spec.phases && !needsSpecApproval(tier, this.c.k.cfg.dials)) {
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
          const fix = spec.phases || held ? null : await this.c.unit("improve").fixPattern(it);
          if (fix) {
            const gate = gatePathTouched(spec.allowed_paths);
            return approved([
              "Approved without a person: this item is the factory's fix for a recurring failure, so it is implemented and reviewed on its own.",
              ...(gate ? [`It touches the gate list (\`${gate}\`), so its change waits for a person's merge.`] : []),
            ], { actor: SYSTEM, reason: FIX_SPEC_APPROVED, detail: { pattern_key: fix.pattern_key } });
          }
          // A standing rule approves a tier 1 spec that would wait here, never one that touches protected paths.
          const rule = spec.phases || held ? null : await this.c.unit("standing").standingRule(it, tier, spec.allowed_paths);
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
          const auto = spec.phases || held ? null : await this.c.unit("local-merge").autoMode(it.project);
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
          const waits = held ? heldNote(missing, answers) : auto ? `Auto mode is on, but this spec waits for \`/approve\`: ${refusal}.\n\n` : "";
          const url = await this.c.unit("outbox").comment(it, `spec:${run.id}`,
            renderSpec(spec, tier, { floor, previous: it.tier, added }, `${waits}${footerAfter(it, patch)}`, { missing, answers }), "spec_comment_url");
          return {
            patch: { ...patch, spec_comment_url: url },
            actor: SYSTEM,
            reason: "triaged", ack_run: run.id,
          };
        }
        case "implement": {
          if (data.floor_block === true) return this.floorBlock(it, run, data, tokens);
          // What the PR changes, for the coordination cost (design §5, 2026-11-03); absent on older outcomes.
          const files = Array.isArray(data.files) && data.files.every((f) => typeof f === "string") ? (data.files as string[]) : null;
          // The run stored its push and PR as intents (RFC 0015 M7): the item waits for outbound, and `prDelivered`
          // applies the PR number and queues the review once the PR delivery completes. One delivered before this
          // result is applied (outbound ran first) is applied here, so the wait never misses it.
          if (data.pr_pending === true) return this.prPending(it, run, data, { token_cost: tokens, ...(files ? { pr_files: files } : {}) }, "implemented");
          // No PR (the local broker, design 05-sources): the item reviews and merges as its local branch.
          const pr = data.pr_number === null || data.pr_number === undefined ? null : Number(data.pr_number);
          return {
            patch: {
              stage: "REVIEW",
              change_ref: pr === null ? null : String(pr),
              ...prUrlOf(data),
              token_cost: tokens,
              ...(files ? { pr_files: files } : {}),
              ...(it.blocked_on === "dependency" ? { blocked_on: "none" as const, blocked_reason: null } : {}),
            },
            actor: SYSTEM,
            reason: "implemented",
            ack_run: run.id,
            enqueue: { kind: "review", idempotency_key: runKey(it, "review"), input: await this.c.unit("checks-gate").reviewInput(pr, it.id) },
          };
        }
        case "review": {
          // The worker withheld finding text its scan flagged (issue #222): only the rule names reached here.
          if (Array.isArray(data.egress_rules)) return this.leakBlock(it, run, data.egress_rules.map(String), { token_cost: tokens }, "review");
          // The worker's cheap checks (issue #223): nothing to review, or the head the last verdict was for. An
          // unchanged head keeps the item's state as it is: the last verdict was applied already, none is replayed.
          if (data.no_agent === EMPTY_DIFF) return this.emptyDiff(it, run, tokens);
          if (data.no_agent === UNCHANGED_HEAD) return this.unchangedHead(it, run);
          const parsed = parseReview(data.review);
          if (!parsed.ok) return this.retryOrBlock(it, run, "task", "invalid_output");
          const tier = effectiveTier(parsed.value.tier, floorTier(it.allowed_paths, this.c.k.settings(it.project).floors), it.tier);
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
            if (!scan.clean) return this.leakBlock(it, run, scan.findings.map((f) => f.rule), { tier, token_cost: tokens }, "review");
          }
          // Any spec finding: the implementer cannot fix it inside the spec, so the spec is revised (issue #222).
          if (spec.length > 0) return this.specRevision(it, run, specFeedback(parsed.value), { tier, token_cost: tokens }, "review");
          if (parsed.value.verdict === "bug") {
            if (it.loop_count + 1 >= this.c.k.cfg.max_loops) {
              const patch = { tier, token_cost: tokens, blocked_on: "human" as const, blocked_reason: "max_loops" };
              await this.c.unit("outbox").comment(it, `max-loops:${run.id}`,
                `Review found bugs ${it.loop_count + 1} times (limit ${this.c.k.cfg.max_loops}). A human needs to decide.\n\n${footerAfter(it, patch)}`);
              return {
                patch,
                actor: SYSTEM,
                reason: "max_loops",
                ack_run: run.id,
              };
            }
            const next = { ...it, loop_count: it.loop_count + 1 };
            return {
              patch: { tier, token_cost: tokens, stage: "RUNNING", loop_count: next.loop_count },
              actor: SYSTEM,
              reason: "review_bug",
              ack_run: run.id,
              enqueue: { kind: "implement", idempotency_key: runKey(next, "implement") },
            };
          }
          return this.c.unit("checks-gate").checkGate(it, run, { tier, token_cost: tokens }, run.id);
        }
        case "resolve": {
          // The worker pushed the merge to the same PR branch. A fresh review checks it; its key comes from
          // this run's id, so it never collides with the review of an earlier loop or resolve.
          const auto = parseAutoResolveKey(run.idempotency_key);
          if (auto) {
            const counts = await this.conflictCountsOf(it, 0);
            await this.c.unit("outbox").prComment(it, `auto-resolved:${run.id}`, [
              `The factory resolved the merge conflict on ${this.c.unit("local-merge").changeName(it)} automatically (attempt ${auto.attempt} of ${AUTO_RESOLVE_LIMIT} for base \`${auto.base_sha.slice(0, 8)}\`) and ${it.change_ref === null ? "committed" : "pushed"} the merge. A fresh review runs next.`,
              "",
              conflictCountsLine(counts),
            ].join("\n"));
          }
          if (await this.pushPending(data)) return this.pushWait(run, "resolved", { token_cost: tokens });
          const pushed = await this.pushApplied(it, run);
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
          if (data.pr_pending === true) return this.prPending(it, run, data, { token_cost: tokens, ...files }, "session_finished", detail);
          // No PR (a local item, design 05-sources): it reviews and merges as its local branch, as an implement run's.
          const pr = data.pr_number === null || data.pr_number === undefined ? null : Number(data.pr_number);
          const input = await this.c.unit("checks-gate").reviewInput(pr, it.id);
          return {
            patch: { stage: "REVIEW", change_ref: pr === null ? null : String(pr), ...prUrlOf(data), token_cost: tokens, ...files }, actor: SYSTEM, reason: "session_finished", detail,
            ack_run: run.id, enqueue: { kind: "review", idempotency_key: runKey(it, "review"), input },
          };
        }
        case "update": {
          // The worker already commented on the PR. A PR waiting for a merge stays in REVIEW waiting for a human; one
          // whose checks failed (CHECKS_FAILED_UPDATE) is reviewed again on the pushed head, or, already up to date,
          // goes on to the implement run the update held back.
          const beforeImplement = updatingForChecks(it);
          switch (data.result) {
            case "pushed":
              if (beforeImplement) {
                if (await this.pushPending(data)) return this.pushWait(run, "update_pushed", {});
                return { ...(await this.pushApplied(it, run)), reason: "update_pushed", ack_run: run.id };
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
    await this.deliveredMeanwhile(run);
  }

  /**
   * A failed run's outcome always lands (design 05-restarts, 2026-11-11): a decision the WorkItem state table refuses
   * becomes the plain failed-run block, so `/retry` works and the run is acknowledged, not refused on every tick.
   */
  private async landed(it: WorkItem, run: Run, d: Decision): Promise<Decision> {
    if (!d || run.outcome?.status === "succeeded" || this.c.unit("transitions").inTable(it, d.patch)) return d;
    return withSpent(await this.failedBlock(it, run), run, it);
  }

  /**
   * A PR or push outbound delivered while this result was decided (the delivery's handler on another tick or
   * replica found the item not waiting yet, so it changed nothing): read once more after the wait is written, so
   * the wait never misses it. Only an item still waiting changes, as in `prDelivered` and `pushDelivered`.
   */
  private async deliveredMeanwhile(run: Run): Promise<void> {
    if (run.outcome?.status !== "succeeded") return;
    const data = run.outcome.data;
    const id = run.work_item_id as WorkItemId;
    for (const key of [data.pr_intent, data.push_intent]) {
      if (typeof key !== "string") continue;
      const a = await this.c.k.actionByKey(key);
      if (!a?.delivered_at) continue;
      if (a.outcome === "failed") await this.deliveryGaveUp(id, a);
      else if (a.action === "pr" && a.delivered_ref) await this.prDelivered(id, a.delivered_ref, a.delivered_url);
      else if (a.action === "push") await this.pushDelivered(id, run.id);
    }
  }

  /**
   * Outbound gave up a run's PR or push (refused for good): an item still waiting for it waits for a person instead
   * (`delivery_failed`), with the action and its error; the dead-letter alarm names it too. A redelivery changes nothing.
   */
  async deliveryGaveUp(id: WorkItemId, a: ActionRow): Promise<void> {
    const waiting = a.action === "pr" ? PR_PENDING : PUSH_PENDING;
    await this.c.unit("transitions").decide(id, async (it) =>
      it.blocked_on === "outbound" && it.blocked_reason === waiting
        ? { patch: { blocked_on: "human", blocked_reason: DELIVERY_FAILED }, actor: SYSTEM, reason: DELIVERY_FAILED, detail: { action: a.action, error: a.last_error ?? "unknown" } }
        : null,
    );
  }

  /**
   * Outbound delivered an implement run's PR (RFC 0015 M7): its number and link go on the item at its version, the
   * wait ends, and the review is queued as an implement result's was. Only an item still waiting for its PR changes,
   * so a redelivered result or a late one changes nothing.
   */
  async prDelivered(id: WorkItemId, ref: string, url: string | null): Promise<void> {
    await this.c.unit("transitions").decide(id, async (it) =>
      it.blocked_on === "outbound" && it.blocked_reason === PR_PENDING ? this.prApplied(it, ref, url) : null,
    );
  }

  /**
   * Outbound delivered an update or resolve run's push (RFC 0015 M7): the review its result queued once runs now, on
   * the pushed head. Only an item still waiting for a push changes, so a redelivered result changes nothing.
   */
  async pushDelivered(id: WorkItemId, run_id: string): Promise<void> {
    await this.c.unit("transitions").decide(id, async (it) => {
      if (it.blocked_on !== "outbound" || it.blocked_reason !== PUSH_PENDING) return null;
      const run = (await this.c.k.reader.listRuns(it.id)).find((r) => r.id === run_id);
      return run ? this.pushApplied(it, run) : null;
    });
  }

  /** Whether a run's result names a push intent (`push_intent`) outbound has not delivered yet. */
  private async pushPending(data: Record<string, unknown>): Promise<boolean> {
    if (typeof data.push_intent !== "string") return false;
    const push = await this.c.k.actionByKey(data.push_intent);
    // A given-up push waits too: the step after the result turns the wait into `delivery_failed`.
    return !push?.delivered_at || push.outcome === "failed";
  }

  /** The item waits for its run's push (`blocked_on: outbound`, `push_pending`); `pushDelivered` ends the wait. */
  private pushWait(run: Run, reason: string, patch: Partial<WorkItem>): Decision {
    return { patch: { ...patch, blocked_on: "outbound", blocked_reason: PUSH_PENDING }, actor: SYSTEM, reason, detail: { run_id: run.id }, ack_run: run.id };
  }

  /** The review of the head an update or resolve run pushed, keyed by that run (never an earlier loop's review). */
  private async pushApplied(it: WorkItem, run: Run): Promise<NonNullable<Decision>> {
    return {
      patch: { ...(it.stage === "REVIEW" ? {} : { stage: "REVIEW" as const }), blocked_on: "none", blocked_reason: null },
      actor: SYSTEM,
      reason: "push_delivered",
      detail: { run_id: run.id },
      enqueue: { kind: "review", idempotency_key: `${it.id}:review:after-${run.kind}:${run.id}`, input: await this.c.unit("checks-gate").reviewInput(prNumber(it), it.id) },
    };
  }

  /**
   * A run that stored its push and PR as intents (RFC 0015 M7, an implement run or a session's finish): the item
   * waits for outbound, and `prDelivered` applies the PR number and queues the review once the PR delivery completes.
   * One delivered before this result is applied (outbound ran first) is applied here, so the wait never misses it.
   */
  private async prPending(it: WorkItem, run: Run, data: Record<string, unknown>, patch: Partial<WorkItem>, reason: string, detail?: StateChangeDetail): Promise<Decision> {
    const delivered = typeof data.pr_intent === "string" ? await this.c.k.actionByKey(data.pr_intent) : null;
    if (delivered?.delivered_ref) {
      const applied = await this.prApplied(it, delivered.delivered_ref, delivered.delivered_url);
      return { ...applied, patch: { ...applied.patch, ...patch }, reason, ack_run: run.id, ...(detail ? { detail } : {}) };
    }
    return { patch: { ...patch, blocked_on: "outbound", blocked_reason: PR_PENDING }, actor: SYSTEM, reason, ack_run: run.id, ...(detail ? { detail } : {}) };
  }

  /** The PR on the item and the review queued, as an implement result with a PR number did before. */
  private async prApplied(it: WorkItem, ref: string, url: string | null): Promise<NonNullable<Decision>> {
    return {
      patch: { stage: "REVIEW", change_ref: ref, ...(url ? { change_url: url } : {}), blocked_on: "none", blocked_reason: null },
      actor: SYSTEM,
      reason: "pr_delivered",
      enqueue: { kind: "review", idempotency_key: runKey(it, "review"), input: await this.c.unit("checks-gate").reviewInput(Number(ref), it.id) },
    };
  }

  /** A failed or cancelled run's decision, before its usage is added (`apply` does that). */
  async applyFailedRun(it: WorkItem, run: Run): Promise<Decision> {
    // One owner comment per forge-auth pause, from the run that started it (marker-keyed on the pause end).
    if (run.outcome?.status === "failed" && run.outcome.error_code === FORGE_AUTH && run.outcome.pause_started) {
      await this.forgeAuthComment(it, run);
    }
    // The same for a preflight-access pause (issue #216), keyed on its own pause end.
    if (run.outcome?.status === "failed" && run.outcome.error_code === PREFLIGHT_ACCESS && run.outcome.pause_started) {
      await this.preflightAccessComment(it, run);
    }
    if (!this.c.unit("transitions").expects(it, run.kind)) return { patch: {}, actor: SYSTEM, reason: "run_ignored", ack_run: run.id };
    const code = failedCode(run);
    if (run.kind === "resolve") return this.resolveFailed(it, run, code);
    if (run.kind === "interactive") return sessionReleased(it, run, code);
    // The provider's account or config needs a person (design §5 Restarts): no retry would get further.
    if (code === PROVIDER_SETUP) return this.providerSetup(it, run);
    // The implementer reported a criterion the spec does not let it meet (issue #222): a spec revision, not a block.
    if (run.kind === "implement" && code === SPEC_CONFLICT) {
      const reason = run.outcome?.status === "failed" ? run.outcome.detail.trim() : "";
      const scan = await this.c.k.d.scanner.scan("comment", reason);
      if (!scan.clean) return this.leakBlock(it, run, scan.findings.map((f) => f.rule), {}, "implement");
      return this.specRevision(it, run, conflictFeedback(reason), {}, "implement");
    }
    // Deterministic codes, diff_too_large among them (design §5 Restarts): the same spec fails the same way.
    if (run.kind === "implement" && NO_AUTO_RETRY.includes(code)) return this.noAutoRetry(it, run, code);
    // A forge rate limit is no attempt for an update run either: it waits for the reset (design §5 Restarts).
    if (run.kind !== "update" || code === GITHUB_RATE_LIMITED) return this.retryOrBlock(it, run, failureClass(run.outcome), code);
    return this.failedBlock(it, run, code);
  }

  /** The plain failed-run block: blocked on a human with `run_failed:<kind>:<code>`, one comment offering `/retry`. */
  async failedBlock(it: WorkItem, run: Run, code = failedCode(run)): Promise<Decision> {
    const patch = { blocked_on: "human" as const, blocked_reason: `run_failed:${run.kind}:${code}` };
    const url = await this.c.unit("outbox").comment(it, `run-failed:${run.id}`,
      `The ${run.kind} run failed (\`${code}\`). Comment \`/retry\` to run it again.\n\n${footerAfter(it, patch)}`, "failure_comment_url");
    return {
      patch: { ...patch, failure_comment_url: url },
      actor: SYSTEM,
      reason: "run_failed",
      detail: { run_id: run.id, error_code: code },
      ack_run: run.id,
    };
  }

  /**
   * A review with nothing to review (issue #223): the PR branch has no commits ahead of the base (already merged)
   * or its diff is empty. No agent ran. The item blocks on a human with `empty_diff`; the one comment is keyed on
   * the item, so a repeated run posts nothing.
   */
  async emptyDiff(it: WorkItem, run: Run, tokens: number): Promise<Decision> {
    const patch = { token_cost: tokens, blocked_on: "human" as const, blocked_reason: EMPTY_DIFF };
    await this.c.unit("outbox").comment(it, EMPTY_DIFF, [
      `PR #${it.change_ref} has no changes against \`${this.c.k.cfg.repo.base_branch}\`: its branch has no commits ahead of the base, or its diff is empty. The factory ran no review (\`${EMPTY_DIFF}\`).`,
      "",
      "Close the PR if its change is already on the base, or push the missing commits to its branch.",
      "",
      footerAfter(it, patch),
    ].join("\n"));
    return { patch, actor: SYSTEM, reason: EMPTY_DIFF, detail: { run_id: run.id }, ack_run: run.id };
  }

  /**
   * A spec revision the factory starts itself (issue #222): a review with a spec finding, or an implement run that
   * returned `spec_conflict`. The same path as `/revise` after a failure: back to triage with the feedback under
   * the next `:v<n>` key, revision_count + 1, restart_count + 1 so the implement run after the revised spec is
   * approved gets a new key (it continues on the PR branch; the PR number is kept). loop_count is unchanged. At
   * the revision limit (`max_loops`) no triage run starts: the item waits at the spec gate with `max_revisions`
   * (restart_count + 1 there too, so `/approve` implements the current spec afresh) and one comment says so.
   */
  async specRevision(
    it: WorkItem,
    run: Run,
    feedback: string,
    fields: { tier?: Tier; token_cost?: number },
    from: "review" | "implement",
  ): Promise<Decision> {
    const limit = this.c.k.cfg.max_loops;
    const kept = feedback.slice(0, MAX_FEEDBACK_CHARS).trim();
    const detail = { run_id: run.id, from };
    const why = from === "review" ? "The review found that the spec needs a change" : "The implementer reported that the spec cannot be met as written";
    if (it.revision_count >= limit) {
      const patch = {
        ...fields, stage: "READY" as const, blocked_on: "human" as const, blocked_reason: "max_revisions",
        restart_count: it.restart_count + 1, failure_comment_url: null,
      };
      await this.c.unit("outbox").comment(it, `max-revisions:${run.id}`, [
        `${why}, but the spec was revised ${it.revision_count} times (limit \`max_loops\` = ${limit}), so the factory started no new triage run (\`max_revisions\`).`,
        "",
        "Reply `/approve` to implement the spec above as it is, or `/reject <reason>` to close.",
        "",
        footerAfter(it, patch),
      ].join("\n"));
      return { patch, actor: SYSTEM, reason: "max_revisions", detail, ack_run: run.id };
    }
    const n = it.revision_count + 1;
    return {
      patch: {
        ...fields, stage: "NEW", blocked_on: "none", blocked_reason: null, revision_count: n, restart_count: it.restart_count + 1,
        spec_feedback: kept, failure_comment_url: null,
      },
      actor: SYSTEM,
      reason: from === "review" ? "review_spec_revision" : "spec_conflict_revision",
      detail,
      ack_run: run.id,
      // The spec-gate revision key: differs from the intake key and from every earlier revision's key.
      enqueue: { kind: "triage", idempotency_key: `${runKey(it, "triage")}:v${n}` },
    };
  }

  /**
   * Finding text or a spec_conflict reason the egress scan flagged (issue #222): nothing of it is stored. The item
   * blocks on a human as a failed run of its kind (so `/retry` and `/revise` apply) and one comment names the rules.
   */
  async leakBlock(
    it: WorkItem,
    run: Run,
    rules: readonly string[],
    fields: { tier?: Tier; token_cost?: number },
    kind: "review" | "implement",
  ): Promise<Decision> {
    const names = [...new Set(rules)].map((r) => r.replace(/[^\w.:-]/g, "").slice(0, 60)).filter(Boolean);
    const patch = { ...fields, blocked_on: "human" as const, blocked_reason: `run_failed:${kind}:egress_blocked` };
    const what = kind === "review" ? "review findings" : "spec conflict the implementer reported";
    const url = await this.c.unit("outbox").comment(it, `leak-blocked:${run.id}`, [
      `The ${what} were blocked by the leak scanner (${names.map((n) => `\`${n}\``).join(", ") || "a rule"}), so nothing of them was stored or posted.`,
      "",
      `Comment \`/retry\` to run the ${kind} again, or \`/revise <feedback>\` to get a new spec written.`,
      "",
      footerAfter(it, patch),
    ].join("\n"), "failure_comment_url");
    return {
      patch: { ...patch, failure_comment_url: url },
      actor: SYSTEM,
      reason: "run_failed",
      detail: { run_id: run.id, error_code: "egress_blocked", rules: names.join(",") },
      ack_run: run.id,
    };
  }

  /**
   * A review that skipped its unchanged head (issue #223). Its last verdict was applied already, so pending or
   * passed checks change nothing. Failed checks after a passing verdict loop as any failed checks do: otherwise
   * nothing would look again, since only items blocked on CI are polled. A `bug` verdict stays as it was.
   */
  async unchangedHead(it: WorkItem, run: Run): Promise<Decision> {
    const ack: Decision = { patch: {}, actor: SYSTEM, reason: "review_unchanged_head", ack_run: run.id };
    if (!(await this.c.unit("checks-gate").lastVerdictPassed(it.id, run.id))) return ack;
    const checks = await this.c.unit("checks-gate").readChecks(it);
    return checks.state === "failed" ? this.c.unit("checks-gate").checksFailed(it, run, checks.failed, {}, { ack_run: run.id }) : ack;
  }

  /** The item's latest succeeded review run, the one the CI gate applies to. */
  async latestReview(id: WorkItemId): Promise<Run | undefined> {
    return (await this.c.k.reader.listRuns(id)).filter((r) => r.kind === "review" && r.outcome?.status === "succeeded").at(-1);
  }

  /**
   * A failed triage, implement or review run (design §5 Restarts). Counts come from the run history of
   * this step (the first run and its automatic retries): a rate limit is never an attempt; infra failures
   * count toward max_restart (and add one to restart_count); task failures toward max_attempts. `checks_env`
   * spends neither: it is counted over the item's whole run history, and the one after CHECKS_ENV_LIMIT blocks
   * the item on a human (`run_failed:<kind>:checks_env`) with no retry. Under both
   * limits, a new run is enqueued in the same transition with `not_before` = failure + backoff (rate limit:
   * its reset time). At a limit, the item blocks on a human with the last error posted. The retry key comes
   * from the failed run's key, and the ack fences the run, so applying it twice enqueues one retry.
   */
  async retryOrBlock(it: WorkItem, run: Run, cls: FailureClass, code: string): Promise<Decision> {
    const { max_restart, retry_base_ms, retry_max_ms } = this.c.k.cfg;
    const { max_attempts } = this.c.k.settings(it.project);
    const step = (await this.c.k.reader.listRuns(it.id)).filter(
      (r) => r.kind === run.kind && sameStep(r.idempotency_key, run.idempotency_key) && (r.id === run.id || r.acknowledged_at !== null),
    );
    const count = (c: FailureClass) => step.filter((r) => failureClass(r.outcome) === c).length;
    const task = count("task");
    const infra = count("infra");
    const failedAt = Date.parse(run.finished_at ?? this.c.k.d.clock.now().toISOString());
    const restart = cls === "infra" ? { restart_count: it.restart_count + 1 } : {};
    const detail = { run_id: run.id, error_code: code, failure: cls, task_failures: task, infra_failures: infra };

    if (cls === "checks_env") {
      const env = (await this.c.k.reader.listRuns(it.id)).filter(
        (r) => failureClass(r.outcome) === "checks_env" && (r.id === run.id || r.acknowledged_at !== null),
      ).length;
      if (env > CHECKS_ENV_LIMIT) {
        // The run_failed form, so `/retry` and the status page read it like any other failed run.
        const patch = { blocked_on: "human" as const, blocked_reason: `run_failed:${run.kind}:${CHECKS_ENV}` };
        const url = await this.lastAttemptComment(it, run, code, CHECKS_ENV, env, footerAfter(it, patch));
        return { patch: { ...patch, failure_comment_url: url }, actor: SYSTEM, reason: CHECKS_ENV, detail: { ...detail, checks_env_failures: env }, ack_run: run.id };
      }
    }
    const limit = task >= max_attempts ? "max_attempts" : infra >= max_restart ? "max_restart" : null;
    // Neither a rate limit, a stall nor a checks_env run is an attempt: they never reach a limit (design §5 Restarts).
    if (cls !== "rate_limited" && cls !== "stalled" && cls !== "checks_env" && limit) {
      const patch = { ...restart, blocked_on: "human" as const, blocked_reason: limit };
      const url = await this.lastAttemptComment(it, run, code, limit, limit === "max_attempts" ? task : infra, footerAfter(it, patch));
      return {
        patch: { ...patch, failure_comment_url: url },
        actor: SYSTEM,
        reason: limit,
        detail,
        ack_run: run.id,
      };
    }
    // The same task failure twice in a row (decided 2026-11-07): a third run would fail the same way.
    if (cls === "task" && this.c.k.d.repeated_failure_rule !== false && repeatsLastFailure(step, run)) return this.repeatedFailure(it, run, code, detail);
    // The same infra failure twice in a row, each within a minute of its start (issue #216): no passing hiccup.
    if (cls === "infra" && this.c.k.d.repeated_failure_rule !== false && repeatsFastInfraFailure(step, run)) {
      return this.repeatedInfraFailure(it, run, code, { ...detail, fast_repeat: true });
    }
    // A forge 401/403, a failed access check or a forge rate limit also waits for its claim pause to end; a stall
    // has no backoff, the stall pause holds every claim until a probe answers (design §5 Restarts).
    const notBefore = retryNotBefore({
      cls, code, failed_at: failedAt, backoff_at: failedAt + retryDelayMs(task + infra, retry_base_ms, retry_max_ms),
      reset: run.outcome?.status === "failed" ? run.outcome.reset_at : null, retry_max_ms,
    });
    // The run kept its commits on a wip branch: after a failed push or PR the retry pushes them with no agent run;
    // after a stop mid-work (rate limit, stall, timeout) the wip ref is marked `continue` by the worker, and the
    // retry runs the agent on it (design §5 Restarts).
    const wip = run.kind === "implement" && run.outcome?.status === "failed" ? run.outcome.wip : undefined;
    // A retried review keeps the CI results read when it was queued (issue #223).
    const input = wip ? { wip } : run.kind === "review" ? run.input : null;
    return {
      patch: restart,
      actor: SYSTEM,
      reason: cls === "rate_limited" ? "run_rate_limited" : cls === "stalled" ? "run_stalled" : "run_retry_scheduled",
      detail: { ...detail, not_before: notBefore },
      ack_run: run.id,
      enqueue: { kind: run.kind, idempotency_key: retryKey(run.idempotency_key), not_before: notBefore, ...(input ? { input } : {}) },
    };
  }

  /**
   * A conflict to resolve with no person (design §5 Merge conflict): an update run's (`ack_run`, 2026-11-02) or a local
   * item's (local-merge's startLocalResolve, no run to ack, 2026-11-12). Under AUTO_RESOLVE_LIMIT automatic resolve runs
   * per base commit, the item goes to RUNNING and a resolve run is enqueued in the same transition, keyed on (item, base
   * commit, attempt). At the limit, or with no base commit to key on, it waits for a person on merge_conflict_pending.
   * The ack (a local item: leaving merge_pending) fences a second apply, so applying it twice enqueues one resolve run.
   */
  async autoResolve(it: WorkItem, baseSha: string, cause: StateChangeDetail, ack_run: Run["id"] | null): Promise<Decision> {
    const keys = (await this.c.k.reader.listRuns(it.id)).filter((r) => r.kind === "resolve").map((r) => r.idempotency_key);
    const done = baseSha ? autoResolveAttempts(keys, it.id, baseSha) : AUTO_RESOLVE_LIMIT;
    const attempt = nextAutoResolveAttempt(done);
    const detail = { ...cause, base_sha: baseSha || null, auto_resolve_attempts: done };
    if (attempt === null) {
      const counts = await this.conflictCountsOf(it, 1);
      await this.c.unit("outbox").prComment(it, `auto-resolve-limit:${ack_run ?? `${it.id}:${baseSha}`}`, [
        `${this.c.unit("local-merge").changeName(it, true)} still conflicts with base \`${baseSha.slice(0, 8) || "unknown"}\`, and the factory already made ${done} automatic resolve attempts for it (limit ${AUTO_RESOLVE_LIMIT} per base commit), so it stopped. Nothing was ${it.change_ref === null ? "committed" : "pushed"}.`,
        "Comment `/resolve [notes]` to try again, or resolve it by hand.",
        "",
        conflictCountsLine(counts),
        "",
        footerAfter(it, CONFLICT_PATCH),
      ].join("\n"));
      return { patch: CONFLICT_PATCH, actor: SYSTEM, reason: "update_conflict", detail, ...(ack_run === null ? {} : { ack_run }) };
    }
    return {
      patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null },
      actor: SYSTEM,
      reason: "auto_resolve_started",
      detail: { ...detail, attempt },
      ...(ack_run === null ? {} : { ack_run }),
      enqueue: { kind: "resolve", idempotency_key: autoResolveKey(it.id, baseSha, attempt), input: { notes: "" } },
    };
  }

  /**
   * Any failed resolve run (agent, scope, tests, push, egress, rate limit, lease): nothing was pushed, so the
   * PR is as it was. An automatic run under the limit for its base commit enqueues the next attempt at once
   * (a rate limit waits for its reset), with no comment; the item stays RUNNING (decision changed 2026-11-02).
   * Otherwise (a human's `/resolve`, or the last automatic attempt) the item goes back to waiting on the
   * conflict, not to run_failed:*, so the next `/resolve` is accepted. One comment, keyed on the run, names
   * the code; for an automatic run it also states the conflict counts.
   */
  async resolveFailed(it: WorkItem, run: Run, code: string): Promise<Decision> {
    const auto = parseAutoResolveKey(run.idempotency_key);
    // provider_setup is never retried (design §5 Restarts): the item waits on a person, as after the last attempt.
    const next = auto && code !== PROVIDER_SETUP ? nextAutoResolveAttempt(auto.attempt) : null;
    if (auto && next !== null) {
      const failedAt = Date.parse(run.finished_at ?? this.c.k.d.clock.now().toISOString());
      const reset = run.outcome?.status === "failed" && code === "rate_limited" ? run.outcome.reset_at : null;
      const notBefore = code === "rate_limited" ? (reset ?? iso(failedAt + this.c.k.cfg.retry_max_ms)) : null;
      return {
        patch: {},
        actor: SYSTEM,
        reason: "auto_resolve_retry",
        detail: { run_id: run.id, error_code: code, base_sha: auto.base_sha, attempt: next },
        ack_run: run.id,
        enqueue: {
          kind: "resolve",
          idempotency_key: autoResolveKey(it.id, auto.base_sha, next),
          input: { notes: "" },
          ...(notBefore ? { not_before: notBefore } : {}),
        },
      };
    }
    const detail = run.outcome?.status === "failed" ? run.outcome.detail.trim() : "";
    const counts = auto ? await this.conflictCountsOf(it, 1) : null;
    const body = (withDetail: boolean) => [
      auto
        ? `The automatic resolve run failed (\`${code}\`): ${describeFailure(code)}.${withDetail && detail ? ` ${detail}` : ""} That was attempt ${auto.attempt} of ${AUTO_RESOLVE_LIMIT} for base \`${auto.base_sha.slice(0, 8)}\`, so the factory stopped.`
        : `The resolve run failed (\`${code}\`): ${describeFailure(code)}.${withDetail && detail ? ` ${detail}` : ""}`,
      "",
      `Nothing was ${it.change_ref === null ? "committed" : "pushed"}; ${this.c.unit("local-merge").changeName(it)} is unchanged and still has the merge conflict.`,
      "Comment `/resolve [notes]` to try again, or resolve it by hand.",
      ...(counts ? ["", conflictCountsLine(counts)] : []),
      "",
      footerAfter(it, CONFLICT_PATCH),
    ].join("\n");
    // The detail is run output (G5): post it only if the scan passes, else the comment without it.
    const scan = await this.c.k.d.scanner.scan("comment", body(true));
    if (auto) await this.c.unit("outbox").prComment(it, `run-failed:${run.id}`, body(scan.clean));
    else await this.c.unit("outbox").comment(it, `run-failed:${run.id}`, body(scan.clean));
    return {
      patch: CONFLICT_PATCH,
      actor: SYSTEM,
      reason: "resolve_failed",
      detail: { run_id: run.id, error_code: code, ...(auto ? { base_sha: auto.base_sha, attempt: auto.attempt } : {}) },
      ack_run: run.id,
    };
  }

  /**
   * The item's conflict counts from its run history and state changes. `pending`: 1 when the decision being
   * made sets merge_conflict_pending, which its own state change will record only after the comment.
   */
  async conflictCountsOf(it: WorkItem, pending: 0 | 1): Promise<{ automatic: number; person: number }> {
    const c = conflictCounts(await this.c.k.reader.listRuns(it.id), await this.c.k.reader.listStateChanges(it.id));
    return { automatic: c.automatic, person: c.person + pending };
  }

  /**
   * Two task failures in a row in one step with the same code and detail line (issue #167, decided
   * 2026-11-07): the item blocks on a human with `repeated_failure` and no third run is queued. One comment,
   * keyed on the run; the detail line is dropped if the egress scan flags it. `/retry` starts the step afresh.
   */
  async repeatedFailure(it: WorkItem, run: Run, code: string, detail: StateChangeDetail): Promise<Decision> {
    const line = run.outcome?.status === "failed" ? failureLine(run.outcome.detail) : "";
    const patch = { blocked_on: "human" as const, blocked_reason: REPEATED_FAILURE };
    const body = (withDetail: boolean) => [
      "## Factory check: the same failure twice",
      "",
      `The ${run.kind} run failed twice in a row the same way (\`${code}\`): ${describeFailure(code)}.${withDetail && line ? ` ${line}` : ""}`,
      "",
      "The factory stopped retrying it, since a third run would most likely fail the same way. Fix the cause, then comment `/retry` to run it again with a fresh attempt budget, `/revise <feedback>` to get a new spec written, or `/reject <reason>` to close.",
      "",
      footerAfter(it, patch),
    ].join("\n");
    const scan = await this.c.k.d.scanner.scan("comment", body(true));
    const url = await this.c.unit("outbox").comment(it, `run-failed:${run.id}`, body(scan.clean), "failure_comment_url");
    return {
      patch: { ...patch, failure_comment_url: url },
      actor: SYSTEM,
      reason: REPEATED_FAILURE,
      detail,
      ack_run: run.id,
    };
  }

  /**
   * An infra failure that repeats the step's previous run at once (issue #216, decided 2026-11-07): same infra
   * code and detail, both runs finished within FAST_FAILURE_MS of their start. The item blocks on a human with
   * `repeated_failure` (restart_count + 1, as for any infra failure) and no retry is queued. One comment, keyed on
   * the run, names the code, the detail and the tail of the last run's output, as the max_restart dead letter
   * does; the detail is dropped if the egress scan flags it, then the tail too. `/retry` starts the step afresh.
   */
  async repeatedInfraFailure(it: WorkItem, run: Run, code: string, detail: StateChangeDetail): Promise<Decision> {
    const out = run.outcome?.status === "failed" ? run.outcome : null;
    const patch = { restart_count: it.restart_count + 1, blocked_on: "human" as const, blocked_reason: REPEATED_FAILURE };
    const tail = stripAnsi(out?.output_tail || "").trim();
    const text = stripAnsi(out?.detail ?? "").trim();
    const body = (withDetail: boolean, withTail: boolean) => [
      "## Factory check: the same infrastructure failure twice",
      "",
      `The ${run.kind} run failed twice in a row the same way (\`${code}\`), each time within a minute of starting: ${describeFailure(code)}.${withDetail && text ? ` ${text}` : ""}`,
      "",
      ...(withTail && tail
        ? ["<details><summary>Output tail of the last run</summary>", "", fenced(tail), "", "</details>", ""]
        : []),
      "The factory stopped restarting it, since another run would most likely fail the same way at once. Fix the cause, then comment `/retry` to run it again with a fresh budget, `/revise <feedback>` to get a new spec written, or `/reject <reason>` to close.",
      "",
      footerAfter(it, patch),
    ].join("\n");
    let text0 = body(true, true);
    if (!(await this.c.k.d.scanner.scan("comment", text0)).clean) text0 = body(false, true);
    if (!(await this.c.k.d.scanner.scan("comment", text0)).clean) text0 = body(false, false);
    const url = await this.c.unit("outbox").comment(it, `run-failed:${run.id}`, text0, "failure_comment_url");
    return {
      patch: { ...patch, failure_comment_url: url },
      actor: SYSTEM,
      reason: REPEATED_FAILURE,
      detail,
      ack_run: run.id,
    };
  }

  /**
   * An implement, review or resolve run that returned needs_human (issue #167): nothing pushed or queued, blocked on `agent_needs_human`, one comment (keyed on
   * the run) with the reason and question unless the scan flags them, and the footer. An implement stop on an open dependency waits instead (dependency-stop.ts).
   */
  async needsHuman(it: WorkItem, run: Run, ask: NeedsHuman, tokens: number): Promise<Decision> {
    const waits = await dependencyStop(this.c, it, run, ask, tokens); if (waits) return waits;
    const patch = { blocked_on: "human" as const, blocked_reason: AGENT_NEEDS_HUMAN };
    const footer = commandFooter(commandState({ ...it, ...patch }, run.kind));
    const answer = run.kind === "resolve"
      ? "Reply `/resolve <your answer>` to run the resolve again with your answer as its notes, or `/retry` to run it again as it is."
      : `Fix what it needs, then reply \`/retry\` to run the ${run.kind} again, \`/revise <feedback>\` to get a new spec written with your answer, or \`/reject <reason>\` to close.`;
    // The paths an implementer names are shown as the exact reply only; they never change allowed_paths (issue #280).
    const reply = run.kind === "implement" ? retryPathsReply((ask.paths ?? []).filter((p) => !isCovered(p, it.allowed_paths))) : null;
    const body = (withText: boolean) => [
      "## Factory: the agent needs a human",
      "",
      `The ${run.kind} run stopped and asked for a human instead of going on. Nothing was pushed.`,
      "",
      ...(withText
        ? [
            "**Reason**", "", quote(ask.reason), "", "**Question**", "", quote(ask.question),
            ...(reply ? ["", "It names paths outside the allowed paths. To allow them and run the implementer again, reply:", "", "```", reply, "```"] : []),
          ]
        : ["The agent's reason and question were withheld by the leak scanner."]),
      "",
      answer,
      "",
      footer,
    ].join("\n");
    const scan = await this.c.k.d.scanner.scan("comment", body(true));
    const url = await this.c.unit("outbox").comment(it, `needs-human:${run.id}`, body(scan.clean), "failure_comment_url");
    return {
      patch: { ...patch, token_cost: tokens, failure_comment_url: url },
      actor: SYSTEM,
      reason: AGENT_NEEDS_HUMAN,
      detail: { run_id: run.id, run_kind: run.kind },
      ack_run: run.id,
    };
  }

  /**
   * An implement failure the factory never retries automatically (design §5 Restarts, decided 2026-11-02; before,
   * only `diff_too_large`): `no_commits`, `scope_violation`, `egress_blocked` and the pre-push size gate's
   * `diff_too_large` (design §4). The same spec would fail the same way. Blocks on a human with the usual
   * run_failed reason, so `/retry` reruns the implement and `/revise` asks for a new spec. One comment, keyed on
   * the run; its detail is dropped if the egress scan flags it.
   */
  async noAutoRetry(it: WorkItem, run: Run, code: string): Promise<Decision> {
    const detail = run.outcome?.status === "failed" ? run.outcome.detail.trim() : "";
    const patch = { blocked_on: "human" as const, blocked_reason: `run_failed:implement:${code}` };
    const body = (withDetail: boolean) => {
      if (code === DIFF_TOO_LARGE) {
        const { max_diff_lines, max_diff_files } = this.c.k.settings(it.project);
        return [
          "## Factory size check: push blocked",
          "",
          `The implement run's diff is too large to review (\`${DIFF_TOO_LARGE}\`), so nothing was pushed${withDetail && detail ? `: ${detail}` : ""}.`,
          "",
          `Limits: \`max_diff_lines\` = ${max_diff_lines} (added plus deleted lines), \`max_diff_files\` = ${max_diff_files}.`,
          "",
          "Comment `/revise <feedback>` to get a new, smaller spec written with your feedback, or `/retry` to run the implementer again on the same spec; it must make a smaller change.",
          "",
          ...suggestedSplit(detail, it.allowed_paths, { max_diff_lines, max_diff_files }),
          footerAfter(it, patch),
        ].join("\n");
      }
      return [
        "## Factory check: implement run stopped",
        "",
        `The implement run failed (\`${code}\`): ${describeFailure(code)}.${withDetail && detail ? ` ${detail}` : ""} Nothing was pushed.`,
        "",
        "The factory does not retry this automatically, since the same spec would most likely fail the same way. Comment `/revise <feedback>` to get a new spec written with your feedback, or `/retry` to run the implementer again on the same spec.",
        "",
        footerAfter(it, patch),
      ].join("\n");
    };
    const scan = await this.c.k.d.scanner.scan("comment", body(true));
    const url = await this.c.unit("outbox").comment(it, `run-failed:${run.id}`, body(scan.clean), "failure_comment_url");
    return {
      patch: { ...patch, failure_comment_url: url },
      actor: SYSTEM,
      reason: "run_failed",
      detail: { run_id: run.id, error_code: code },
      ack_run: run.id,
    };
  }

  /**
   * A run the model provider refused for its account or config (`provider_setup`, design §5 Restarts): the quota,
   * the API key or the model name. Any run kind; never retried, since waiting does not fix it, and no claim pause.
   * Blocks on a human with `run_failed:<kind>:provider_setup`, so `/retry` runs it again once fixed. One comment,
   * keyed on the run, says what to fix and quotes the provider's message, dropped if the egress scan flags it.
   */
  async providerSetup(it: WorkItem, run: Run): Promise<Decision> {
    const detail = run.outcome?.status === "failed" ? run.outcome.detail.trim() : "";
    const patch = { blocked_on: "human" as const, blocked_reason: `run_failed:${run.kind}:${PROVIDER_SETUP}` };
    const body = (withDetail: boolean) => [
      "## Factory check: the model provider needs setup",
      "",
      `The ${run.kind} run failed (\`${PROVIDER_SETUP}\`): ${describeFailure(PROVIDER_SETUP)}.${withDetail && detail ? ` ${detail}` : ""}`,
      "",
      "The factory does not retry this automatically, since waiting will not fix it. Check the provider account's quota or billing, the API key (`npm run setup`) and the model names in `factory.config.json`, then comment `/retry` to run it again.",
      "",
      footerAfter(it, patch),
    ].join("\n");
    const scan = await this.c.k.d.scanner.scan("comment", body(true));
    const url = await this.c.unit("outbox").comment(it, `run-failed:${run.id}`, body(scan.clean), "failure_comment_url");
    return {
      patch: { ...patch, failure_comment_url: url },
      actor: SYSTEM,
      reason: "run_failed",
      detail: { run_id: run.id, error_code: PROVIDER_SETUP },
      ack_run: run.id,
    };
  }

  /**
   * The owner comment for a forge-auth pause (design §5 Restarts): on the item whose run started the pause, once
   * per pause (the marker is keyed on the pause's end). It names the code and the time only, never the forge's
   * answer or a credential.
   */
  async forgeAuthComment(it: WorkItem, run: Run): Promise<void> {
    const until = run.outcome?.status === "failed" ? run.outcome.reset_at : null;
    if (!until) return;
    await this.c.unit("outbox").comment(it, `forge-auth:${until}`, [
      "## Factory forge check: implement runs paused",
      "",
      `The forge answered 401 or 403 to the factory's credentials during this item's ${run.kind} run (\`${FORGE_AUTH}\`), so implement and update runs are paused for every worker until ${until}. Triage and review runs go on.`,
      "",
      "Check the factory's forge credentials (the app installation or token): they need write access to contents and changes on this repository. The run is retried after the pause ends.",
    ].join("\n"));
  }

  /**
   * The owner comment for a preflight-access pause (issue #216): on the item whose run started it, once per pause
   * (keyed on the pause's end). It names the failed check and the time, never the forge's answer.
   */
  async preflightAccessComment(it: WorkItem, run: Run): Promise<void> {
    const out = run.outcome?.status === "failed" ? run.outcome : null;
    if (!out?.reset_at) return;
    const check = preflightCheck(out.detail) ?? "push_access or pr_api";
    await this.c.unit("outbox").comment(it, `preflight-access:${out.reset_at}`, [
      "## Factory forge check: implement runs paused",
      "",
      `The implement preflight's \`${check}\` check failed during this item's ${run.kind} run (\`${PREFLIGHT_ACCESS}\`), so implement and update runs are paused for every worker until ${out.reset_at}. Triage and review runs go on.`,
      "",
      "Check that the factory's forge app or token can still read this repository and its changes, and that the forge answers. The run is retried after the pause ends.",
    ].join("\n"));
  }

  /**
   * The pre-push floor check found changed files under a floor above the item's tier (design §4). Nothing was
   * pushed. The item stays RUNNING, blocked on a human; `/approve` raises the tier and runs implement again.
   */
  async floorBlock(it: WorkItem, run: Run, data: Record<string, unknown>, tokens: number): Promise<Decision> {
    const hits = parseFloorHits(data.floor_paths);
    const need = hits.reduce((m, h) => Math.max(m, h.tier), 0);
    if (hits.length === 0 || data.required_tier !== need) return this.retryOrBlock(it, run, "task", "invalid_output");
    const patch = { token_cost: tokens, blocked_on: "human" as const, blocked_reason: FLOOR_TIER };
    await this.c.unit("outbox").comment(it, `floor:${run.id}`, [
      "## Factory floor check: push blocked",
      "",
      `This item is tier ${it.tier ?? 1}, but the implementer changed files under a floor that needs a higher tier, so nothing was pushed:`,
      "",
      ...hits.map((h) => `- \`${h.path}\` needs tier ${h.tier}`),
      "",
      `Reply \`/approve\` to raise the item to tier ${need} and run the implementer again, or \`/reject <reason>\` to close it.`,
      "",
      footerAfter(it, patch),
    ].join("\n"));
    return {
      patch,
      actor: SYSTEM,
      reason: "floor_blocked",
      detail: { run_id: run.id, item_tier: it.tier, required_tier: need, paths: hits.map((h) => h.path).join(",").slice(0, 1000) },
      ack_run: run.id,
    };
  }

  /**
   * The dead-letter note: what failed, its code, and the tail of the last output. Posted only if G5 passes.
   * Returns the comment's URL, or null when the scan withheld it.
   */
  async lastAttemptComment(it: WorkItem, run: Run, code: string, limit: string, n: number, footer: string): Promise<string | null> {
    const out = run.outcome?.status === "failed" ? run.outcome : null;
    const what = limit === "max_attempts"
      ? `The ${run.kind} run failed ${n} times (limit \`max_attempts\` = ${this.c.k.settings(it.project).max_attempts}), so the factory stopped retrying it.`
      : limit === CHECKS_ENV
        ? `The ${run.kind} run's checks failed on the base branch too ${n} times (the factory requeues at most ${CHECKS_ENV_LIMIT}), so it stopped retrying it. Fix or skip the failing tests on the base branch first.`
        : `The ${run.kind} run hit ${n} infrastructure failures (limit \`max_restart\` = ${this.c.k.cfg.max_restart}), so the factory stopped restarting it.`;
    const tail = stripAnsi(out?.output_tail || out?.detail || "").trim();
    const first = firstErrorLine(tail);
    const tests = failingTests(tail);
    const body = [
      what,
      "",
      `Last error: \`${code}\`: ${describeFailure(code)}.${out?.detail ? ` ${stripAnsi(out.detail)}` : ""}`,
      "",
      ...(first ? ["First error line:", "", fenced(first), ""] : []),
      ...(tests.length ? ["Failing tests:", "", ...tests.map((t) => `- \`${t.replace(/`/g, "'")}\``), ""] : []),
      ...(tail
        ? ["<details><summary>Output tail of the last run</summary>", "", fenced(tail), "", "</details>", ""]
        : ["The last run left no output.", ""]),
      "Comment `/retry` to run it again.",
      "",
      footer,
    ].join("\n");
    const scan = await this.c.k.d.scanner.scan("comment", body);
    if (!scan.clean) {
      this.c.k.d.log.warn("last-attempt comment blocked by the egress scan; not posted", {
        work_item_id: it.id,
        run_id: run.id,
        rules: scan.findings.map((f) => f.rule).join(","),
      });
      return null;
    }
    return this.c.unit("outbox").comment(it, `run-failed:${run.id}`, body, "failure_comment_url");
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
