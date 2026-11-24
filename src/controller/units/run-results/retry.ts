// The run-results unit's retry and block decisions: a failed run's retry under its limits, the blocks at a limit or
// on a repeated failure, and the failed-run comments with their codes. Split out of run-results.unit.ts (file budget).
// Values come through run-results.unit.ts, which already imports them: a new core/ or units/support import here would
// raise the dependency-direction and kinds counts (tests/architecture).

import type { Ctx } from "../context.js";
import type { Decision, Run, Tier, WorkItem } from "../support.js";
import {
  type FailureClass, type StateChangeDetail, SYSTEM, footerAfter, fenced, CHECKS_ENV, CHECKS_ENV_LIMIT, PROVIDER_SETUP, RECURRING_FAILURE,
  REPEATED_FAILURE, SESSION_RELEASED, STALL_STREAK_HOLD, doneChecksDetail, failingTests, failureClass, failureLine, firstErrorLine,
  repeatsFastInfraFailure, repeatsLastFailure, retryDelayMs, retryKey, retryNotBefore, runKindLabel, sameStep, itemSizeCaps, stallStreak, stripAnsi,
  suggestedSplit, takenOver,
} from "./run-results.unit.js";

/** error_code of an implement run whose diff is over max_diff_lines or max_diff_files (design §4). */
const DIFF_TOO_LARGE = "diff_too_large";
/** A failed run's error code (`unknown` when the stored outcome has none), or `cancelled`. */
export const failedCode = (run: Run): string => (run.outcome?.status === "failed" ? run.outcome.error_code || "unknown" : "cancelled");

/**
 * A session that ended without a PR (abandoned, lease lost), design §5, 2026-11-01: never retried. The item is released:
 * RUNNING, blocked on a human with `session_released`, nothing queued, for the next `session start`. A pushed branch stays.
 */
export function sessionReleased(_it: WorkItem, run: Run, code: string): Decision {
  const detail = { run_id: run.id, error_code: code, ...(run.actor_id ? { actor_id: run.actor_id } : {}) };
  return { patch: { blocked_on: "human", blocked_reason: SESSION_RELEASED }, actor: SYSTEM, reason: SESSION_RELEASED, detail, ack_run: run.id };
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
export const describeFailure = (code: string): string => FAILURES[code] ?? "the run failed";
/** A run-failed comment's error code, in a Details fold after its plain sentence (issue #758), never in the sentence. */
export const codeDetails = (code: string): string[] => ["", "<details><summary>Details</summary>", "", `Error code \`${code}\`: ${describeFailure(code)}.`, "", "</details>", ""];

/** The plain failed-run block: blocked on a human with `run_failed:<kind>:<code>`, one comment offering `/retry`. */
export async function failedBlock(c: Ctx, it: WorkItem, run: Run, code: string): Promise<Decision> {
  const patch = { blocked_on: "human" as const, blocked_reason: `run_failed:${run.kind}:${code}` };
  const url = await c.unit("outbox").comment(it, `run-failed:${run.id}`,
    `The ${runKindLabel(run.kind)} run failed (\`${code}\`). Comment \`/retry\` to run it again.\n\n${footerAfter(it, patch)}`, "failure_comment_url");
  return {
    patch: { ...patch, failure_comment_url: url },
    actor: SYSTEM,
    reason: "run_failed",
    detail: { run_id: run.id, error_code: code },
    ack_run: run.id,
  };
}

/**
 * Finding text or a spec_conflict reason the egress scan flagged (issue #222): nothing of it is stored. The item
 * blocks on a human as a failed run of its kind (so `/retry` and `/revise` apply) and one comment names the rules.
 */
export async function leakBlock(
  c: Ctx,
  it: WorkItem,
  run: Run,
  rules: readonly string[],
  fields: { tier?: Tier; token_cost?: number },
  kind: "review" | "implement",
): Promise<Decision> {
  const names = [...new Set(rules)].map((r) => r.replace(/[^\w.:-]/g, "").slice(0, 60)).filter(Boolean);
  const patch = { ...fields, blocked_on: "human" as const, blocked_reason: `run_failed:${kind}:egress_blocked` };
  const what = kind === "review" ? "review findings" : "spec conflict the implementer reported";
  const url = await c.unit("outbox").comment(it, `leak-blocked:${run.id}`, [
    `The ${what} were blocked by the leak scanner (${names.map((n) => `\`${n}\``).join(", ") || "a rule"}), so nothing of them was stored or posted.`,
    "",
    `Comment \`/retry\` to run the ${runKindLabel(kind)} again, or \`/revise <feedback>\` to get a new spec written.`,
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
 * A failed triage, implement or review run (design §5 Restarts). Counts come from the run history of
 * this step (the first run and its automatic retries): a rate limit or a run a takeover cancelled is never an attempt; infra failures
 * (stalls too; 3 in a row hold the item) count toward max_restart (and add one to restart_count); task failures toward max_attempts. `checks_env`
 * spends neither: it is counted over the item's whole run history, and the one after CHECKS_ENV_LIMIT blocks
 * the item on a human (`run_failed:<kind>:checks_env`) with no retry. Under both limits, a new run is enqueued in
 * the same transition with `not_before` = failure + backoff (rate limit: its reset time). At a limit, the item blocks on a human with the last error posted (with `stop`: `stop`'s decision,
 * no comment, as a goal's judge, 04-split-specs). The retry key is the failed run's; the ack fences a second apply.
 */
export async function retryOrBlock(c: Ctx, it: WorkItem, run: Run, cls: FailureClass, code: string, stop?: (limit: string, detail: StateChangeDetail) => Promise<Decision>): Promise<Decision> {
  const { max_restart, retry_base_ms, retry_max_ms } = c.k.cfg;
  const { max_attempts } = c.k.settings(it.project);
  const step = (await c.k.reader.listRuns(it.id)).filter(
    (r) => r.kind === run.kind && sameStep(r.idempotency_key, run.idempotency_key) && (r.id === run.id || r.acknowledged_at !== null) && !takenOver(r),
  );
  const count = (fc: FailureClass) => step.filter((r) => failureClass(r.outcome) === fc).length;
  const task = count("task");
  const infra = count("infra");
  const failedAt = Date.parse(run.finished_at ?? c.k.d.clock.now().toISOString());
  const restart = cls === "infra" ? { restart_count: it.restart_count + 1 } : {};
  const detail = { run_id: run.id, error_code: code, failure: cls, task_failures: task, infra_failures: infra, ...doneChecksDetail(run.outcome) };

  if (cls === "checks_env") {
    const env = (await c.k.reader.listRuns(it.id)).filter(
      (r) => failureClass(r.outcome) === "checks_env" && (r.id === run.id || r.acknowledged_at !== null),
    ).length;
    if (env > CHECKS_ENV_LIMIT) {
      // The run_failed form, so `/retry` and the status page read it like any other failed run.
      const patch = { blocked_on: "human" as const, blocked_reason: `run_failed:${run.kind}:${CHECKS_ENV}` };
      const url = await lastAttemptComment(c, it, run, code, CHECKS_ENV, env, footerAfter(it, patch));
      return { patch: { ...patch, failure_comment_url: url }, actor: SYSTEM, reason: CHECKS_ENV, detail: { ...detail, checks_env_failures: env }, ack_run: run.id };
    }
  }
  const streak = stallStreak(step), held = streak >= STALL_STREAK_HOLD; // its runs keep stalling (05-restarts): its retry waits for /retry
  const limit = task >= max_attempts ? "max_attempts" : infra >= max_restart ? "max_restart" : null;
  // Neither a rate limit, a checks_env run nor a missing model credential is an attempt: they never reach a limit (design §5 Restarts).
  if (!held && cls !== "rate_limited" && cls !== "checks_env" && cls !== "setup_missing" && limit) {
    if (stop) return stop(limit, detail);
    const patch = { ...restart, blocked_on: "human" as const, blocked_reason: limit };
    const url = await lastAttemptComment(c, it, run, code, limit, limit === "max_attempts" ? task : infra, footerAfter(it, patch));
    return {
      patch: { ...patch, failure_comment_url: url },
      actor: SYSTEM,
      reason: limit,
      detail,
      ack_run: run.id,
    };
  }
  // The same task failure twice in a row (decided 2026-11-07): a third run would fail the same way.
  if (cls === "task" && c.k.d.repeated_failure_rule !== false && repeatsLastFailure(step, run)) return stop ? stop(REPEATED_FAILURE, detail) : repeatedFailure(c, it, run, code, detail);
  // The same infra failure twice in a row, each within a minute of its start (issue #216): no passing hiccup.
  const fast = cls === "infra" && c.k.d.repeated_failure_rule !== false && repeatsFastInfraFailure(step, run) ? { ...detail, fast_repeat: true } : null;
  if (fast) return stop ? stop(REPEATED_FAILURE, fast) : repeatedInfraFailure(c, it, run, code, fast);
  if (held && stop) return stop(RECURRING_FAILURE, { ...detail, stall_streak: streak });
  // A forge 401/403, a failed access check or a forge rate limit also waits for its claim pause to end (design §5 Restarts).
  const notBefore = retryNotBefore({
    cls, code, failed_at: failedAt, backoff_at: failedAt + retryDelayMs(task + infra, retry_base_ms, retry_max_ms),
    reset: run.outcome?.status === "failed" ? run.outcome.reset_at : null, retry_max_ms,
  });
  // The run kept its commits on a wip branch: after a failed push or PR the retry pushes them with no agent run;
  // after a stop mid-work (rate limit, stall, timeout) the wip ref is marked `continue` by the worker, and the
  // retry runs the agent on it (design §5 Restarts).
  const wip = run.kind === "implement" && run.outcome?.status === "failed" ? run.outcome.wip : undefined;
  // A retried review keeps the CI results read when it was queued (issue #223); a retried judge its phase (design 04-split-specs).
  const input = wip ? { wip } : run.kind === "review" || run.kind === "judge" ? run.input : null;
  return {
    patch: held ? { ...restart, blocked_on: "human", blocked_reason: RECURRING_FAILURE } : restart,
    actor: SYSTEM,
    reason: held ? RECURRING_FAILURE : cls === "rate_limited" ? "run_rate_limited" : "run_retry_scheduled",
    detail: { ...detail, ...(held ? { stall_streak: streak } : {}), not_before: notBefore },
    ack_run: run.id,
    enqueue: { kind: run.kind, idempotency_key: retryKey(run.idempotency_key), not_before: notBefore, ...(input ? { input } : {}) },
  };
}

/** The repeated-failure comment above its footer: the run by its label, the failure in words, its code under Details. */
export const repeatedFailureLines = (kind: Run["kind"], code: string, line: string): string[] => [
  "## Factory check: the same failure twice",
  "",
  `The ${runKindLabel(kind)} run failed twice in a row the same way: ${describeFailure(code)}.${line ? ` ${line}` : ""}`,
  ...codeDetails(code),
  "The factory stopped retrying it, since a third run would most likely fail the same way. Fix the cause, then comment `/retry` to run it again with a fresh attempt budget, `/revise <feedback>` to get a new spec written, or `/reject <reason>` to close.",
];

/**
 * Two task failures in a row in one step with the same code and detail line (issue #167, decided
 * 2026-11-07): the item blocks on a human with `repeated_failure` and no third run is queued. One comment,
 * keyed on the run; the detail line is dropped if the egress scan flags it. `/retry` starts the step afresh.
 */
async function repeatedFailure(c: Ctx, it: WorkItem, run: Run, code: string, detail: StateChangeDetail): Promise<Decision> {
  const line = run.outcome?.status === "failed" ? failureLine(run.outcome.detail) : "";
  const patch = { blocked_on: "human" as const, blocked_reason: REPEATED_FAILURE };
  const body = (withDetail: boolean) => [...repeatedFailureLines(run.kind, code, withDetail ? line : ""), "", footerAfter(it, patch)].join("\n");
  const scan = await c.k.d.scanner.scan("comment", body(true));
  const url = await c.unit("outbox").comment(it, `run-failed:${run.id}`, body(scan.clean), "failure_comment_url");
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
async function repeatedInfraFailure(c: Ctx, it: WorkItem, run: Run, code: string, detail: StateChangeDetail): Promise<Decision> {
  const out = run.outcome?.status === "failed" ? run.outcome : null;
  const patch = { restart_count: it.restart_count + 1, blocked_on: "human" as const, blocked_reason: REPEATED_FAILURE };
  const tail = stripAnsi(out?.output_tail || "").trim();
  const text = stripAnsi(out?.detail ?? "").trim();
  const body = (withDetail: boolean, withTail: boolean) => [
    "## Factory check: the same infrastructure failure twice",
    "",
    `The ${runKindLabel(run.kind)} run failed twice in a row the same way, each time within a minute of starting: ${describeFailure(code)}.${withDetail && text ? ` ${text}` : ""}`,
    ...codeDetails(code),
    ...(withTail && tail
      ? ["<details><summary>Output tail of the last run</summary>", "", fenced(tail), "", "</details>", ""]
      : []),
    "The factory stopped restarting it, since another run would most likely fail the same way at once. Fix the cause, then comment `/retry` to run it again with a fresh budget, `/revise <feedback>` to get a new spec written, or `/reject <reason>` to close.",
    "",
    footerAfter(it, patch),
  ].join("\n");
  let text0 = body(true, true);
  if (!(await c.k.d.scanner.scan("comment", text0)).clean) text0 = body(false, true);
  if (!(await c.k.d.scanner.scan("comment", text0)).clean) text0 = body(false, false);
  const url = await c.unit("outbox").comment(it, `run-failed:${run.id}`, text0, "failure_comment_url");
  return {
    patch: { ...patch, failure_comment_url: url },
    actor: SYSTEM,
    reason: REPEATED_FAILURE,
    detail,
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
export async function noAutoRetry(c: Ctx, it: WorkItem, run: Run, code: string): Promise<Decision> {
  const detail = run.outcome?.status === "failed" ? run.outcome.detail.trim() : "";
  const patch = { blocked_on: "human" as const, blocked_reason: `run_failed:implement:${code}` };
  const caps = code === DIFF_TOO_LARGE ? await itemSizeCaps(c.k.reader, it.id, c.k.settings(it.project)) : null; // the item's (src/core/size-cap.ts)
  const body = (withDetail: boolean) => {
    if (caps) {
      const { max_diff_lines, max_diff_files } = caps;
      return [
        "## Factory size check: push blocked",
        "",
        `The implement run's diff is too large to review, so nothing was pushed${withDetail && detail ? `: ${detail}` : ""}.`,
        ...codeDetails(DIFF_TOO_LARGE),
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
      `The implement run failed: ${describeFailure(code)}.${withDetail && detail ? ` ${detail}` : ""} Nothing was pushed.`,
      ...codeDetails(code),
      "The factory does not retry this automatically, since the same spec would most likely fail the same way. Comment `/revise <feedback>` to get a new spec written with your feedback, or `/retry` to run the implementer again on the same spec.",
      "",
      footerAfter(it, patch),
    ].join("\n");
  };
  const scan = await c.k.d.scanner.scan("comment", body(true));
  const url = await c.unit("outbox").comment(it, `run-failed:${run.id}`, body(scan.clean), "failure_comment_url");
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
export async function providerSetup(c: Ctx, it: WorkItem, run: Run): Promise<Decision> {
  const detail = run.outcome?.status === "failed" ? run.outcome.detail.trim() : "";
  const patch = { blocked_on: "human" as const, blocked_reason: `run_failed:${run.kind}:${PROVIDER_SETUP}` };
  const body = (withDetail: boolean) => [
    "## Factory check: the model provider needs setup",
    "",
    `The ${runKindLabel(run.kind)} run failed: ${describeFailure(PROVIDER_SETUP)}.${withDetail && detail ? ` ${detail}` : ""}`,
    ...codeDetails(PROVIDER_SETUP),
    "The factory does not retry this automatically, since waiting will not fix it. Check the provider account's quota or billing, the API key (`npm run setup`) and the model names in `factory.config.json`, then comment `/retry` to run it again.",
    "",
    footerAfter(it, patch),
  ].join("\n");
  const scan = await c.k.d.scanner.scan("comment", body(true));
  const url = await c.unit("outbox").comment(it, `run-failed:${run.id}`, body(scan.clean), "failure_comment_url");
  return {
    patch: { ...patch, failure_comment_url: url },
    actor: SYSTEM,
    reason: "run_failed",
    detail: { run_id: run.id, error_code: PROVIDER_SETUP },
    ack_run: run.id,
  };
}

/**
 * The dead-letter note: what failed, its code, and the tail of the last output. Posted only if G5 passes.
 * Returns the comment's URL, or null when the scan withheld it.
 */
async function lastAttemptComment(c: Ctx, it: WorkItem, run: Run, code: string, limit: string, n: number, footer: string): Promise<string | null> {
  const out = run.outcome?.status === "failed" ? run.outcome : null;
  const label = runKindLabel(run.kind);
  const what = limit === "max_attempts"
    ? `The ${label} run failed ${n} times (limit \`max_attempts\` = ${c.k.settings(it.project).max_attempts}), so the factory stopped retrying it.`
    : limit === CHECKS_ENV
      ? `The ${label} run's checks failed on the base branch too ${n} times (the factory requeues at most ${CHECKS_ENV_LIMIT}), so it stopped retrying it. Fix or skip the failing tests on the base branch first.`
      : `The ${label} run hit ${n} infrastructure failures (limit \`max_restart\` = ${c.k.cfg.max_restart}), so the factory stopped restarting it.`;
  const tail = stripAnsi(out?.output_tail || out?.detail || "").trim();
  const first = firstErrorLine(tail);
  const tests = failingTests(tail);
  const body = [
    what,
    "",
    `Last error: ${describeFailure(code)}.${out?.detail ? ` ${stripAnsi(out.detail)}` : ""}`,
    ...codeDetails(code),
    ...(first ? ["First error line:", "", fenced(first), ""] : []),
    ...(tests.length ? ["Failing tests:", "", ...tests.map((t) => `- \`${t.replace(/`/g, "'")}\``), ""] : []),
    ...(tail
      ? ["<details><summary>Output tail of the last run</summary>", "", fenced(tail), "", "</details>", ""]
      : ["The last run left no output.", ""]),
    "Comment `/retry` to run it again.",
    "",
    footer,
  ].join("\n");
  const scan = await c.k.d.scanner.scan("comment", body);
  if (!scan.clean) {
    c.k.d.log.warn("last-attempt comment blocked by the egress scan; not posted", {
      work_item_id: it.id,
      run_id: run.id,
      rules: scan.findings.map((f) => f.rule).join(","),
    });
    return null;
  }
  return c.unit("outbox").comment(it, `run-failed:${run.id}`, body, "failure_comment_url");
}
