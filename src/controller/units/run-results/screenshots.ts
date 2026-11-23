// Screenshots of changed pages before merge (design 04-screenshots), on the controller's side. Kept out of
// run-results.unit.ts, which may not grow (file budget). Three steps, none of which changes a stage, blocked_on or
// blocked_reason, holds the item or touches the merge gate:
// - a passing review of a change whose pr_files touch a `repo.ui_check` path queues one screenshot run;
// - a finished screenshot run, captured or not, queues one screenshot review on what it stored, or its reason;
// - a finished screenshot review posts one comment with its findings and unverified lines.
// The runs are queued by a plain transition (no stage or blocked change; only the acked run's tokens), not through `decide`: a screenshot review is a short
// look at stored images, never the budget checkpoint or the Rule of Two's hold, which would block the item.

import {
  SCREENSHOT_REVIEW, notCapturedLine, parseScreenshotOutcome, parseScreenshotReview, screenshotReviewKey, screenshotRunKey, touchesUi,
} from "../../../shared/screenshots.js";
import { runTokenCount } from "../../../core/types.js";
import type { Ctx } from "../context.js";
import { SYSTEM } from "../support.js";
import type { RunResultsUnit } from "./run-results.unit.js";

type Run = Parameters<RunResultsUnit["apply"]>[0];
type Item = NonNullable<Awaited<ReturnType<Ctx["k"]["reader"]["getWorkItem"]>>>;
type Queued = NonNullable<Extract<Parameters<Ctx["k"]["commitItem"]>[1], { kind: "transition" }>["input"]["enqueue"]>;

/** State-change reasons of the three steps. */
const SCREENSHOTS_QUEUED = "screenshots_queued";
const SCREENSHOT_REVIEW_QUEUED = "screenshot_review_queued";
const SCREENSHOT_REVIEWED = "screenshot_reviewed";

/** How many times a plain transition is tried again on a version conflict. */
const CONFLICT_RETRIES = 5;

/** Whether `run` is a screenshot run or a screenshot review: `apply` hands both here before any outcome path. */
export const isScreenshotStep = (run: Run): boolean => run.kind === "screenshot" || run.input?.[SCREENSHOT_REVIEW] === true;

/** A succeeded review whose verdict passes with no spec finding (the one the item goes on from), not a screenshot review. */
function passingReview(run: Run): boolean {
  if (run.kind !== "review" || run.outcome?.status !== "succeeded" || run.input?.[SCREENSHOT_REVIEW] === true) return false;
  const r = run.outcome.data.review as { verdict?: unknown; findings?: unknown } | null | undefined;
  return r?.verdict === "pass" && Array.isArray(r.findings) && r.findings.every((f: { kind?: unknown }) => f?.kind !== "spec");
}

/**
 * One plain transition on the item: no stage or blocked change, `ack` acknowledged when given with its tokens added to
 * token_cost (design §6 Measurement; the ack fences the add, so a second apply adds nothing), `enqueue` queued (a no-op
 * when its key is stored, so a second apply queues nothing). Re-read and tried again on a version conflict.
 */
async function plain(c: Ctx, id: Item["id"], reason: string, o: { ack?: Run; enqueue?: Queued; detail?: Record<string, string> }): Promise<void> {
  const { ack, ...rest } = o;
  const spent = ack ? runTokenCount(ack) : 0;
  for (let i = 0; i < CONFLICT_RETRIES; i++) {
    const item = await c.k.reader.getWorkItem(id);
    if (!item) return;
    const patch = spent > 0 ? { token_cost: item.token_cost + spent } : {};
    const input = { id, expected_version: item.version, patch, actor: SYSTEM, reason, ...rest, ...(ack ? { ack_run: ack.id } : {}) };
    const r = await c.k.commitItem([], { kind: "transition", input });
    if (r.ok || r.reason !== "version_conflict") return;
  }
  c.k.d.log.warn("screenshot step gave up after conflicts", { work_item_id: id, reason });
}

/**
 * Before a review's outcome is applied: a passing review on an item still in review, whose pr_files touch a
 * `repo.ui_check` path, queues one screenshot run keyed on the item and the review run. A bug verdict, a spec finding,
 * no `repo.ui_check`, no pr_files or no UI path queues none.
 */
export async function queueScreenshots(c: Ctx, run: Run): Promise<void> {
  const ui = c.k.cfg.repo.ui_check;
  if (!ui || !passingReview(run)) return;
  const it = await c.k.reader.getWorkItem(run.work_item_id);
  if (!it || !c.unit("transitions").expects(it, "review") || !touchesUi(it.pr_files, ui.paths)) return;
  await plain(c, it.id, SCREENSHOTS_QUEUED, {
    detail: { run_id: run.id },
    enqueue: { kind: "screenshot", idempotency_key: screenshotRunKey(it.id, run.id), input: { review_run_id: run.id } },
  });
}

/** A screenshot run's or a screenshot review's result, acknowledged. */
export async function screenshotStep(c: Ctx, run: Run): Promise<void> {
  if (run.kind === "screenshot") return screenshotsTaken(c, run);
  const item = await c.k.reader.getWorkItem(run.work_item_id);
  if (item) await c.unit("outbox").post(item, item.source, screenshotReviewComment(run), `<!-- factory:screenshot-review:${run.id} -->`);
  await plain(c, run.work_item_id, SCREENSHOT_REVIEWED, { ack: run });
}

/** What a screenshot run stored, or why it stored nothing: a failed or cancelled run names its error code. */
function screenshotsOf(run: Run): { captures: { page: string; width: number; theme: string; key: string }[]; reason: string | null } {
  if (run.outcome?.status !== "succeeded") {
    return { captures: [], reason: `the screenshot run ${run.outcome?.status === "failed" ? `failed (${run.outcome.error_code || "unknown"})` : "was cancelled"}` };
  }
  const o = parseScreenshotOutcome(run.outcome.data);
  return o ? { captures: [...o.captures], reason: o.reason } : { captures: [], reason: "the screenshot run stored no capture and no reason" };
}

/** A finished screenshot run: one screenshot review queued on its captures or its reason (an open item only), and the run acknowledged. */
async function screenshotsTaken(c: Ctx, run: Run): Promise<void> {
  const it = await c.k.reader.getWorkItem(run.work_item_id);
  const open = it !== null && it.stage !== "CLOSED";
  await plain(c, run.work_item_id, SCREENSHOT_REVIEW_QUEUED, {
    ack: run,
    detail: { run_id: run.id },
    ...(open ? { enqueue: { kind: "review", idempotency_key: screenshotReviewKey(run.work_item_id, run.id), input: { screenshot_review: true, screenshot_run_id: run.id, screenshots: screenshotsOf(run) } } } : {}),
  });
}

/** The screenshot review's one comment: its findings, then what it could not verify; a failed review says so. */
function screenshotReviewComment(run: Run): string {
  const head = "**Screenshot review** of the changed pages against `design-system/patterns.md` (390px and 1280px, light and dark; the seeded fixture store). It changes no state: the screenshots are on the item page's Changes tab.";
  const r = run.outcome?.status === "succeeded" ? parseScreenshotReview(run.outcome.data.screenshot_review) : null;
  if (!r) {
    const input = parseScreenshotOutcome(run.input?.screenshots);
    const why = run.outcome?.status === "failed" ? `The screenshot review run failed (${run.outcome.error_code || "unknown"}).` : "The screenshot review gave no result.";
    return [head, "", why, ...(input?.reason ? ["", "Not verified:", `- ${notCapturedLine(input.reason)}`] : [])].join("\n");
  }
  return [
    head,
    "",
    r.findings.length === 0 ? "No broken layout rule found." : ["Findings:", ...r.findings.map((f) => `- ${f.text}`)].join("\n"),
    ...(r.unverified.length > 0 ? ["", "Not verified:", ...r.unverified.map((u) => `- ${u}`)] : []),
    ...(r.summary ? ["", r.summary] : []),
  ].join("\n");
}
