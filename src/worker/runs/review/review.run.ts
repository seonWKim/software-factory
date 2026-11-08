import { prNumber } from "../../../core/change-ref.js";
import type { ModelClass } from "../../../core/model-choice.js";
import { REVIEW_SCHEMA, parseReview, unverifiedOf } from "../../../core/outputs.js";
import { branchFor } from "../../../core/policy.js";
import type { Run, WorkItem } from "../../../core/types.js";
import type { SandboxHandle } from "../../../interfaces/sandbox.js";
import type { ToolCallContext } from "../../../interfaces/tool-broker.js";
import { type ResumePlan, RunFailure, ciResults, gitIdentity, hasTool, lastVerdictHead, renderAdoptedPr, renderSessionResume, renderWorkItem, reviewComment, specQuery, tail } from "../../support.js";
import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, type RunCall, defineRunKind } from "../../run-kind.js";

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
  // A local item (no PR tool, design 05-sources) is reviewed from its local branch: the sandbox put the run folder
  // on it, and a missing one must not be reviewed as the empty diff of a fresh branch.
  const local = !hasTool(w.route(item).broker, "github.open_pr");
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
  // A paused review resuming its own session is the same review, never a repeat of it.
  if (!plan?.session && head_sha !== "" && lastVerdictHead(await w.d.store.listRuns(item.id), run.id) === head_sha) {
    return { no_agent: "unchanged_head", head_sha };
  }
  const notes = await w.approverNotes(item);
  const subject = item.origin === "adopted" ? renderAdoptedPr(item) : renderWorkItem(item, { includeSpec: true });
  // Blind pass: work item + diff only, no implementer transcript (design §4). A paused review resumes its own
  // session on the same host; anywhere else it reviews afresh (design §5 Pause).
  // The agent step's parsed verdict is journaled, so a takeover posts it without reviewing again.
  const review = await step("run-agent", async (s) => {
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
    }, plan ? `resumed-${ctx.lease_token}` : undefined, { pausable: true, resume: plan?.session ?? null, onSession: (id) => s.savePartial(id) });
    const parsed = parseReview(result.output);
    if (!parsed.ok) throw new RunFailure("invalid_output", parsed.error, false, { output_tail: tail(result.transcript) });
    return parsed;
  });
  // The reviewer asked for a human: no review comment on the PR; the controller blocks the item.
  if (review.value.needs_human) return { needs_human: review.value.needs_human };

  const v = review.value;
  // Finding and unverified text is scanned before it is posted or stored (issue #222): a flagged text keeps
  // only the rule names, and the controller blocks the item on a human.
  const scan = await w.d.scanner.scan("comment", [...v.findings.map((f) => f.text), ...unverifiedOf(v)].join("\n"));
  if (!scan.clean) return { egress_rules: [...new Set(scan.findings.map((f) => f.rule))] };
  // The comment write stays in the worker until outbound takes it (RFC 0015 M7).
  await step("post-review", async () => {
    const posted = await w.forgeComment(item, ctx, {
      number: prNumber(item),
      body: reviewComment(v),
      marker: `<!-- factory:review:${run.id} -->`,
    });
    if (!posted.ok) throw new RunFailure(posted.error_code, posted.message);
    return true;
  });
  return { review: v, head_sha };
}

export default defineRunKind({
  name: "review",
  folder: true,
  timeouts: DEFAULT_TIMEOUTS,
  execute: (w, c) => review(w, c.run, c.item, c.handle!, c.ctx, c.signal, c.model, c.plan ?? null, c.step),
});
