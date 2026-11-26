// The run-results unit's notices: a run that stops for a person (needs-human, floor block, empty diff), the forge and
// preflight pause comments, a spec revision the factory starts itself, and a review of an unchanged head. Split out
// of run-results.unit.ts (file budget). Values come through run-results.unit.ts, which already imports them: a new
// core/ or units/support import here would raise the dependency-direction and kinds counts (tests/architecture).

import type { Ctx } from "../context.js";
import type { Decision, Run, Tier, WorkItem } from "../support.js";
import { autoGrant } from "./auto-grant.js";
import { dependencyStop } from "./dependency-stop.js";
import { retryOrBlock } from "./retry.js";
import {
  type NeedsHuman, AGENT_NEEDS_HUMAN, FLOOR_TIER, FORGE_AUTH, MAX_FEEDBACK_CHARS, PREFLIGHT_ACCESS, SYSTEM, commandFooter, commandState, footerAfter,
  isCovered, preflightCheck, prNumber, quote, retryPathsReply, runKey, runKindLabel, withholdReplyLines,
} from "./run-results.unit.js";

/** A review with nothing to review: no commits ahead of the base, or an empty diff (issue #223). */
export const EMPTY_DIFF = "empty_diff";

function parseFloorHits(v: unknown): { path: string; tier: number }[] {
  if (!Array.isArray(v)) return [];
  const hits = v.filter(
    (h): h is { path: string; tier: number } =>
      typeof h === "object" && h !== null && typeof h.path === "string" && Number.isInteger(h.tier) && h.tier >= 1 && h.tier <= 5,
  );
  return hits.length === v.length ? hits : [];
}

/**
 * A review with nothing to review (issue #223): the PR branch has no commits ahead of the base (already merged)
 * or its diff is empty. No agent ran. The item blocks on a human with `empty_diff`; the one comment is keyed on
 * the item, so a repeated run posts nothing.
 */
export async function emptyDiff(c: Ctx, it: WorkItem, run: Run, tokens: number): Promise<Decision> {
  const patch = { token_cost: tokens, blocked_on: "human" as const, blocked_reason: EMPTY_DIFF };
  await c.unit("outbox").comment(it, EMPTY_DIFF, [
    `PR #${it.change_ref} has no changes against \`${c.k.cfg.repo.base_branch}\`: its branch has no commits ahead of the base, or its diff is empty. The factory ran no review (\`${EMPTY_DIFF}\`).`,
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
export async function specRevision(
  c: Ctx,
  it: WorkItem,
  run: Run,
  feedback: string,
  fields: { tier?: Tier; token_cost?: number },
  from: "review" | "implement",
): Promise<Decision> {
  const limit = c.k.cfg.max_loops;
  const kept = feedback.slice(0, MAX_FEEDBACK_CHARS).trim();
  const detail = { run_id: run.id, from };
  const why = from === "review" ? "The review found that the spec needs a change" : "The implementer reported that the spec cannot be met as written";
  if (it.revision_count >= limit) {
    const patch = {
      ...fields, stage: "READY" as const, blocked_on: "human" as const, blocked_reason: "max_revisions",
      restart_count: it.restart_count + 1, failure_comment_url: null,
    };
    await c.unit("outbox").comment(it, `max-revisions:${run.id}`, [
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
 * A review that skipped its unchanged head (issue #223). After a passing verdict, pending or passed checks change
 * nothing; failed checks loop as any failed checks do, since only items blocked on CI are polled. After a `bug`
 * verdict on a factory branch (design 05-ci-gate, 2026-11-23): a note or spec newer than it queues a review at that
 * head (`rereview`, the newest note in its input); nothing newer sends the item back as the verdict did (reviewBug).
 */
export async function unchangedHead(c: Ctx, it: WorkItem, run: Run): Promise<Decision> {
  const gate = c.unit("checks-gate"), last = await gate.lastVerdict(it.id, run.id), ack: Decision = { patch: {}, actor: SYSTEM, reason: "review_unchanged_head", ack_run: run.id };
  if (last?.verdict === "bug" && it.origin !== "adopted") {
    const newer = await gate.newerThanVerdict(it, last.run), detail = { run_id: run.id, review_run_id: last.run.id, unchanged_head: true };
    if (!newer) return gate.reviewBug(it, run, {}, detail);
    const input = { ...(await gate.reviewInput(prNumber(it), it.id)), rereview: true as const, ...(newer.note ? { notes: newer.note } : {}) };
    return { ...ack, detail: { ...detail, rerun: true, newer: newer.what }, enqueue: { kind: "review", idempotency_key: `${it.id}:review:rereview:${run.id}`, input } };
  }
  if (last?.verdict !== "pass") return ack;
  const checks = await gate.readChecks(it);
  return checks.state === "failed" ? gate.checksFailed(it, run, checks, {}, { ack_run: run.id }) : ack;
}

/**
 * An implement, review or resolve run that returned needs_human (issue #167): nothing pushed or queued, blocked on `agent_needs_human`, one comment (keyed on
 * the run) with the reason and question unless the scan flags them, and the footer. An implement stop on an open dependency waits instead (dependency-stop.ts).
 */
export async function needsHuman(c: Ctx, it: WorkItem, run: Run, ask: NeedsHuman, tokens: number): Promise<Decision> {
  const waits = await dependencyStop(c, it, run, ask, tokens); if (waits) return waits;
  const patch = { blocked_on: "human" as const, blocked_reason: AGENT_NEEDS_HUMAN };
  const footer = commandFooter(commandState({ ...it, ...patch }, run.kind), run.kind === "implement" && (await c.unit("coordination").namesUnmerged(it, ask.reason)) ? [] : ["hold"]);
  const answer = run.kind === "resolve"
    ? "Reply `/resolve <your answer>` to run the resolve again with your answer as its notes, or `/retry` to run it again as it is."
    : `Fix what it needs, then reply \`/retry\` to run the ${runKindLabel(run.kind)} again, \`/revise <feedback>\` to get a new spec written with your answer, or \`/reject <reason>\` to close.`;
  const named = [...new Set(ask.paths ?? [])], asked = named.filter((p) => !isCovered(p, it.allowed_paths)), reply = run.kind === "implement" ? retryPathsReply(asked) : null;
  const granted = run.kind === "implement" ? await autoGrant(c, { ...it, ...patch }, run, { named, asked, reply }, tokens) : undefined; if (granted !== undefined) return granted; // test paths or allowed paths only: once (design 05-restarts)
  const body = (withText: boolean) => [
    "## Factory: the agent needs a human",
    "",
    `The ${runKindLabel(run.kind)} run stopped and asked for a human instead of going on. Nothing was pushed.`,
    "",
    ...(withText
      ? [
          "**Reason**", "", quote(withholdReplyLines(ask.reason)), "", "**Question**", "", quote(withholdReplyLines(ask.question)),
          ...(reply ? ["", "It names paths outside the allowed paths. To allow them and run the implementer again, reply:", "", "```", reply, "```"] : []),
        ]
      : ["The agent's reason and question were withheld by the leak scanner."]),
    "",
    answer,
    "",
    footer,
  ].join("\n");
  const scan = await c.k.d.scanner.scan("comment", body(true));
  const url = await c.unit("outbox").comment(it, `needs-human:${run.id}`, body(scan.clean), "failure_comment_url");
  return {
    patch: { ...patch, token_cost: tokens, failure_comment_url: url },
    actor: SYSTEM,
    reason: AGENT_NEEDS_HUMAN,
    detail: { run_id: run.id, run_kind: run.kind },
    ack_run: run.id,
  };
}

/**
 * The owner comment for a forge-auth pause (design §5 Restarts): on the item whose run started the pause, once
 * per pause (the marker is keyed on the pause's end). It names the code and the time only, never the forge's
 * answer or a credential.
 */
export async function forgeAuthComment(c: Ctx, it: WorkItem, run: Run): Promise<void> {
  const until = run.outcome?.status === "failed" ? run.outcome.reset_at : null;
  if (!until) return;
  await c.unit("outbox").comment(it, `forge-auth:${until}`, [
    "## Factory forge check: implement runs paused",
    "",
    `The forge answered 401 or 403 to the factory's credentials during this item's ${runKindLabel(run.kind)} run (\`${FORGE_AUTH}\`), so implement and update runs are paused for every worker until ${until}. Triage and review runs go on.`,
    "",
    "Check the factory's forge credentials (the app installation or token): they need write access to contents and changes on this repository. The run is retried after the pause ends.",
  ].join("\n"));
}

/**
 * The owner comment for a preflight-access pause (issue #216): on the item whose run started it, once per pause
 * (keyed on the pause's end). It names the failed check and the time, never the forge's answer.
 */
export async function preflightAccessComment(c: Ctx, it: WorkItem, run: Run): Promise<void> {
  const out = run.outcome?.status === "failed" ? run.outcome : null;
  if (!out?.reset_at) return;
  const check = preflightCheck(out.detail) ?? "push_access or pr_api";
  await c.unit("outbox").comment(it, `preflight-access:${out.reset_at}`, [
    "## Factory forge check: implement runs paused",
    "",
    `The implement preflight's \`${check}\` check failed during this item's ${runKindLabel(run.kind)} run (\`${PREFLIGHT_ACCESS}\`), so implement and update runs are paused for every worker until ${out.reset_at}. Triage and review runs go on.`,
    "",
    "Check that the factory's forge app or token can still read this repository and its changes, and that the forge answers. The run is retried after the pause ends.",
  ].join("\n"));
}

/**
 * The pre-push floor check found changed files under a floor above the item's tier (design §4). Nothing was
 * pushed. The item stays RUNNING, blocked on a human; `/approve` raises the tier and runs implement again.
 */
export async function floorBlock(c: Ctx, it: WorkItem, run: Run, data: Record<string, unknown>, tokens: number): Promise<Decision> {
  const hits = parseFloorHits(data.floor_paths);
  const need = hits.reduce((m, h) => Math.max(m, h.tier), 0);
  if (hits.length === 0 || data.required_tier !== need) return retryOrBlock(c, it, run, "task", "invalid_output");
  const patch = { token_cost: tokens, blocked_on: "human" as const, blocked_reason: FLOOR_TIER };
  await c.unit("outbox").comment(it, `floor:${run.id}`, [
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
