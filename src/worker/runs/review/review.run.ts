import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prNumber } from "../../../core/change-ref.js";
import type { ModelClass } from "../../../core/model-choice.js";
import {
  BUILT_DIFFERENTLY_FINDING, REVIEW_CONFIRM_SCHEMA, REVIEW_SCHEMA, type ReviewFinding, type ReviewOutput, builtDifferentlyOf, findingLine, parseReview,
  parseReviewConfirm, unverifiedOf,
} from "../../../core/outputs.js";
import { branchFor } from "../../../core/policy.js";
import type { Run, WorkItem } from "../../../core/types.js";
import type { SandboxHandle } from "../../../interfaces/sandbox.js";
import { PREFLIGHT, type ToolCallContext } from "../../../interfaces/tool-broker.js";
import { type ResumePlan, RunFailure, ciResults, fenced, gitIdentity, hasTool, lastVerdictHead, renderAdoptedPr, renderSessionResume, renderWorkItem, reviewComment, specQuery, tail } from "../../support.js";
import type { Worker } from "../../runner.js";
import { decisionsSection } from "../../../shared/command-notes.js";
import { DEFAULT_TIMEOUTS, type RunCall, defineRunKind } from "../../run-kind.js";
import {
  CHANGED_PAGES_SCHEMA, type Capture, SCREENSHOT_REVIEW, type ScreenshotReview, changedPagesOf, notCapturedLine, parseScreenshotOutcome, sectionNotShownLine,
} from "../../../shared/screenshots.js";

async function review(
  w: Worker,
  run: Run,
  item: WorkItem,
  handle: SandboxHandle,
  ctx: ToolCallContext,
  signal: AbortSignal,
  model: ModelClass,
  plan: ResumePlan | null,
  step: RunCall["step"],
) {
  if (run.input?.[SCREENSHOT_REVIEW] === true) return screenshotReview(w, run, item, handle, signal, model, step);
  // A local item (no forge tool, design 05-sources) is reviewed from its local branch: the sandbox put the run folder
  // on it, and a missing one must not be reviewed as the empty diff of a fresh branch.
  const local = !hasTool(w.route(item).broker, PREFLIGHT);
  if (item.change_ref === null && !local) throw new RunFailure("no_pr", "work item has no PR");
  // The sandbox starts a missing branch from base; an adopted PR's review must read the person's branch.
  if (item.head_branch !== null || local) {
    await w.git(handle, ["rev-parse", "--verify", "--quiet", `origin/${branchFor(item, w.cfg.branch_prefix)}`]);
  }
  const base = `origin/${w.cfg.repo.base_branch}`;
  // Cheap checks before any agent call (decision changed 2026-11-08, issue #223): no commits ahead of the base
  // (already merged) or an empty diff blocks on a human; the head the last verdict was for keeps the item's state.
  // The PR head is its branch as pushed (what this folder checked out); one that cannot be read is unknown ("")
  // and never matches a review.
  const pushed = await w.gitRaw(handle, ["rev-parse", `origin/${branchFor(item, w.cfg.branch_prefix)}`]);
  const head_sha = pushed.exit_code === 0 ? pushed.stdout.trim() : "";
  const ahead = (await w.git(handle, ["rev-list", "--count", `${base}..HEAD`])).trim();
  const diff = ahead === "0" ? "" : await w.git(handle, ["diff", `${base}...HEAD`]);
  if (diff.trim() === "") return { no_agent: "empty_diff", head_sha };
  // A paused review resuming its own session is the same review, never a repeat of it; a rereview (a note or spec
  // newer than the last `bug` verdict, design 05-ci-gate) reviews that head again on purpose.
  if (!plan?.session && run.input?.rereview !== true && head_sha !== "" && lastVerdictHead(await w.d.store.listRuns(item.id), run.id) === head_sha) {
    return { no_agent: "unchanged_head", head_sha };
  }
  // The approver's notes, then the answers to the spec's decisions (issue #526).
  const notes = [await w.approverNotes(item), decisionsSection(await w.d.store.listStateChanges(item.id), fenced)].filter(Boolean).join("\n\n");
  const subject = item.origin === "adopted" ? renderAdoptedPr(item) : renderWorkItem(item, { includeSpec: true });
  // Blind pass: work item + diff only, no implementer transcript (design §4). A paused review resumes its own
  // session on the same host; anywhere else it reviews afresh (design §5 Pause).
  // The agent step's parsed verdict is journaled, so a takeover posts it without reviewing again.
  const review = await step("run-agent", async () => {
    const result = await w.agent(run, item, handle, signal, {
      prompt: plan?.session
        ? renderSessionResume(null)
        : await w.withIndex(
          [subject, notes, ciResults(run), `## Diff\n\n\`\`\`diff\n${diff}\n\`\`\``].filter(Boolean).join("\n\n"),
          specQuery(item),
        ),
      model_class: model,
      output_schema: REVIEW_SCHEMA,
      env_allowlist: gitIdentity(w.cfg.agent_git_identity),
    }, plan ? `resumed-${ctx.lease_token}` : undefined, { pausable: true, resume: plan?.session ?? null });
    const parsed = parseReview(result.output);
    if (!parsed.ok) throw new RunFailure("invalid_output", parsed.error, false, { output_tail: tail(result.transcript) });
    return parsed;
  });
  // The reviewer asked for a human: no review comment on the PR; the controller blocks the item.
  if (review.value.needs_human) return { needs_human: review.value.needs_human };

  // Finding, unverified and built-differently text is scanned before it is sent to a confirm run, posted or stored
  // (issue #222): a flagged text keeps only the rule names, and the controller blocks the item on a human.
  const built = builtDifferentlyOf(review.value).flatMap((d) => [d.line, d.reason]);
  const scan = await w.d.scanner.scan("comment", [...review.value.findings.map((f) => f.text), ...unverifiedOf(review.value), ...built].join("\n"));
  if (!scan.clean) return { egress_rules: [...new Set(scan.findings.map((f) => f.rule))] };
  // One confirm run per reviewer finding (design 04-agents), each a journaled step of this run, so none is a review
  // loop. The factory's own built-differently findings get none. An unconfirmed finding moves to `unconfirmed`.
  const confirmed: (boolean | null)[] = [];
  for (const [i, f] of review.value.findings.filter((x) => !isBuiltDifferentlyFinding(x)).entries()) {
    confirmed.push((await step(`confirm-finding-${i}`, async () => ({ confirmed: await confirm(w, run, item, handle, signal, model, f, diff, i) }))).confirmed);
  }
  const v = withConfirmations(review.value, confirmed);
  // A thread entry once per marker; outbound posts it on the PR (RFC 0015 M7).
  await step("post-review", async () => {
    await w.comment(item, { pr: prNumber(item), body: reviewComment(v), marker: `<!-- factory:review:${run.id} -->` });
    return true;
  });
  return { review: v, head_sha };
}

/** The screenshot review's answer: the review's, plus its result per changed page. */
const SCREENSHOT_REVIEW_SCHEMA = { ...REVIEW_SCHEMA, properties: { ...REVIEW_SCHEMA.properties, changed_pages: CHANGED_PAGES_SCHEMA } };

/** Where, inside the run folder, the screenshot review's images are copied for the reviewer to read. */
const SCREENSHOTS_DIR = ".factory-screenshots";

/**
 * The screenshot review (design 04-screenshots): a review run queued after the screenshot run, with its captures or
 * the reason it took none. The stored images are copied into the run folder and the reviewer checks each against
 * `design-system/patterns.md`; each broken rule is a finding of kind `code` naming the rule by its number. For each
 * page the change touches it says whether the changed section appeared (`changed_pages`, stored as `pages`); a section
 * that did not is the unverified line `changed section not in the screenshots: <page>: <section>`. A capture
 * that did not happen is the unverified line `screenshots not captured: <reason>` and starts no agent. Nothing here
 * changes the item: the controller posts the result as one comment. Its data is `screenshot_review`, never `review`,
 * so no verdict, unchanged-head check or merge gate reads it.
 */
async function screenshotReview(w: Worker, run: Run, item: WorkItem, handle: SandboxHandle, signal: AbortSignal, model: ModelClass, step: RunCall["step"]) {
  const shots = parseScreenshotOutcome(run.input?.screenshots) ?? { captures: [], reason: "the screenshot run stored nothing" };
  const notCaptured = shots.reason ? [notCapturedLine(shots.reason)] : [];
  const looked = await step("run-agent", async () => {
    const attached = await attachScreenshots(w, handle, shots.captures);
    const missing = shots.captures.length - attached.length;
    const unread = missing > 0 ? [notCapturedLine(`${missing} stored screenshot(s) could not be read`)] : [];
    if (attached.length === 0) return { review: null, unread, pages: [] };
    const result = await w.agent(run, item, handle, signal, {
      prompt: [renderWorkItem(item, { includeSpec: true }), screenshotsSection(attached, [...notCaptured, ...unread])].join("\n\n"),
      model_class: model,
      output_schema: SCREENSHOT_REVIEW_SCHEMA,
      env_allowlist: gitIdentity(w.cfg.agent_git_identity),
    });
    const parsed = parseReview(result.output);
    if (!parsed.ok) throw new RunFailure("invalid_output", parsed.error, false, { output_tail: tail(result.transcript) });
    return { review: parsed.value, unread, pages: changedPagesOf((result.output as { changed_pages?: unknown } | null)?.changed_pages) };
  });
  const r = looked.review;
  const pages = looked.pages ?? [];
  const notShown = pages.filter((p) => !p.shown).map(sectionNotShownLine);
  const own = (u: string) => u.startsWith("screenshots not captured") || notShown.includes(u);
  const out: ScreenshotReview = {
    findings: (r?.findings ?? []).map((f) => ({ kind: "code", text: f.text })),
    unverified: [...notCaptured, ...looked.unread, ...notShown, ...(r ? unverifiedOf(r).filter((u) => !own(u)) : [])],
    summary: r?.summary ?? "",
    pages,
  };
  // Scanned before it is stored or posted (issue #222): a flagged text is withheld whole, with only the rule names.
  const scan = await w.d.scanner.scan("comment", [...out.findings.map((f) => f.text), ...out.unverified, ...pages.map((p) => `${p.page}: ${p.section}`), out.summary].join("\n"));
  if (!scan.clean) return { screenshot_review: { findings: [], unverified: [], pages: [], summary: `The screenshot review's text was withheld (${[...new Set(scan.findings.map((f) => f.rule))].join(", ")}).` } };
  return { screenshot_review: { ...out, verdict: r?.verdict ?? null } };
}

/** The stored captures copied into the run folder under SCREENSHOTS_DIR, through a temp folder; the ones it could read. */
async function attachScreenshots(w: Worker, handle: SandboxHandle, captures: readonly Capture[]): Promise<{ file: string; capture: Capture }[]> {
  const dir = await mkdtemp(join(tmpdir(), "sf-screenshots-"));
  try {
    const attached: { file: string; capture: Capture }[] = [];
    for (const capture of captures) {
      const bytes = await w.d.storage.get(capture.key).catch(() => null);
      if (!bytes) continue;
      const name = `${capture.page}-${capture.width}-${capture.theme}.png`;
      await writeFile(join(dir, name), bytes);
      attached.push({ file: `${SCREENSHOTS_DIR}/${name}`, capture });
    }
    if (attached.length > 0) await w.d.sandbox.copyIn(handle, dir, SCREENSHOTS_DIR);
    return attached;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The screenshot review's input section: each image's file, page, width and theme, then what was not captured. */
function screenshotsSection(attached: readonly { file: string; capture: Capture }[], notCaptured: readonly string[]): string {
  return [
    "## Screenshots",
    "",
    "This is the screenshot review (step 7): the factory captured these dashboard pages, each as the full page, from the seeded fixture store after the review passed. Open each image file and check it against `design-system/patterns.md`. Each broken rule is a finding of kind `code` that names the rule by its number and the page, width and theme. In `changed_pages`, list each page the change touches once, with the section it changes and `shown`: whether that section appears in at least one of its images. Your verdict and findings change no state: they are posted on the item.",
    "",
    ...attached.map((a) => `- \`${a.file}\`: page ${a.capture.page}, ${a.capture.width}px, ${a.capture.theme}`),
    ...(notCaptured.length > 0 ? ["", "Not captured (list each under `unverified` as it is written):", ...notCaptured.map((l) => `- ${l}`)] : []),
  ].join("\n");
}

/** Whether `f` is the factory's own built-differently finding (parseReview adds it): it gets no confirm run and stays. */
const isBuiltDifferentlyFinding = (f: ReviewFinding): boolean => f.kind === "code" && f.text.startsWith(BUILT_DIFFERENTLY_FINDING);

/**
 * The review after its confirm runs (design 04-agents): `confirmed[i]` answers the i-th of `r.findings` that is not a
 * built-differently finding; false moves it to `unconfirmed`, true or null (the run failed or gave no valid answer)
 * keeps it. When every finding moved to `unconfirmed` the verdict is "pass"; a verdict with no findings at all stays.
 */
function withConfirmations(r: ReviewOutput, confirmed: readonly (boolean | null)[]): ReviewOutput {
  const findings: ReviewFinding[] = [], unconfirmed: ReviewFinding[] = [];
  let i = 0;
  for (const f of r.findings) (isBuiltDifferentlyFinding(f) || confirmed[i++] !== false ? findings : unconfirmed).push(f);
  const { unconfirmed: _fromAgent, ...rest } = r;
  return { ...rest, verdict: unconfirmed.length > 0 && findings.length === 0 ? "pass" : r.verdict, findings, ...(unconfirmed.length > 0 ? { unconfirmed } : {}) };
}

/**
 * One finding's confirm run (role review-confirm): a fresh context holding only the finding and the diff, on the
 * review's model class. True or false is its answer; null when it failed or gave no valid answer, which keeps the
 * finding. A lost lease still ends the review.
 */
async function confirm(w: Worker, run: Run, item: WorkItem, handle: SandboxHandle, signal: AbortSignal, model: ModelClass, f: ReviewFinding, diff: string, i: number): Promise<boolean | null> {
  try {
    const result = await w.agent(run, item, handle, signal, {
      role: "review-confirm",
      prompt: `## Finding\n\n${findingLine(f)}\n\n## Diff\n\n\`\`\`diff\n${diff}\n\`\`\``,
      model_class: model,
      output_schema: REVIEW_CONFIRM_SCHEMA,
    }, `confirm-${i}`);
    const parsed = parseReviewConfirm(result.output);
    if (parsed.ok) return parsed.value.confirmed;
    w.d.log.warn("review confirm run gave no valid answer; the finding stays", { run_id: run.id, finding: i, error: parsed.error });
  } catch (err) {
    if (signal.aborted || (err instanceof RunFailure && err.code === "lease_lost")) throw err;
    w.d.log.warn("review confirm run failed; the finding stays", { run_id: run.id, finding: i, error: err instanceof RunFailure ? err.code : "exception" });
  }
  return null;
}

export default defineRunKind({
  name: "review",
  folder: true,
  timeouts: DEFAULT_TIMEOUTS,
  execute: (w, c) => review(w, c.run, c.item, c.handle!, c.ctx, c.signal, c.model, c.plan ?? null, c.step),
});
