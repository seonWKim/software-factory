import { prNumber } from "../../../core/change-ref.js";
import { checkedLines, commandText } from "../../../core/checks.js";
import { AUTO_RESOLVE_LIMIT, branchFor } from "../../../core/policy.js";
import { mergeAppendedConflicts } from "../../../core/mechanical.js";
import type { Run, WorkItem } from "../../../core/types.js";
import type { ToolCallContext } from "../../../interfaces/tool-broker.js";
import { NO_HOOKS, RunFailure, gitIdentity } from "../../support.js";
import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, defineRunKind } from "../../run-kind.js";

/**
 * Merges origin/<base> into the PR branch in a fresh run folder (its own clone), runs the test command, and pushes only a clean,
 * passing merge (never a force push). No agent. Conflicts and failing tests are reported on the PR and in
 * `result`; the controller decides the state. Git and push errors fail the run.
 */
async function update(w: Worker, run: Run, item: WorkItem, ctx: ToolCallContext, signal: AbortSignal) {
  if (item.change_ref === null) throw new RunFailure("no_pr", "work item has no PR");
  const { repo, branch_prefix } = w.cfg;
  const branch = branchFor(item, branch_prefix);
  const baseRef = `origin/${repo.base_branch}`;
  const handle = await w.route(item).sandbox.create({ repo: repo.path, branch, base_ref: repo.base_branch }).catch((err: unknown) => {
    throw new RunFailure("git_failed", `worktree: ${err instanceof Error ? err.message : "unknown"}`, true);
  });
  const comment = (body: string) => w.comment(item, { pr: prNumber(item), body, marker: `<!-- factory:update:${run.id} -->` });
  try {
    // The sandbox starts a missing branch from base; an update must only ever touch the PR's own branch.
    await w.git(handle, ["rev-parse", "--verify", "--quiet", `origin/${branch}`]);
    const head_sha = (await w.git(handle, ["rev-parse", "HEAD"])).trim();
    const base_sha = (await w.git(handle, ["rev-parse", baseRef])).trim();

    const ancestor = await w.gitRaw(handle, ["merge-base", "--is-ancestor", baseRef, "HEAD"]);
    if (ancestor.exit_code === 0) return { result: "up_to_date", head_sha, base_sha };
    if (ancestor.exit_code !== 1) throw new RunFailure("git_failed", `git merge-base: ${ancestor.stderr.trim()}`, true);

    const merge = await w.gitRaw(
      handle,
      ["merge", "--no-ff", "--no-edit", "-m", `Merge ${baseRef} into ${branch}`, baseRef],
      gitIdentity(w.cfg.agent_git_identity),
    );
    let mechanical: string[] | null = null;
    let conflicts: string[] = [];
    if (merge.exit_code !== 0) {
      conflicts = (await w.git(handle, ["diff", "--name-only", "-z", "--diff-filter=U"])).split("\0").filter(Boolean);
      if (conflicts.length === 0) throw new RunFailure("git_failed", `git merge: ${merge.stderr.trim()}`, true);
      // Only appended lines on both sides (issue #297): merged in code and committed, with no recorded conflict;
      // the checks below decide whether it is pushed.
      if (await mergeAppendedConflicts(w.mergeIO(handle), conflicts)) {
        mechanical = conflicts;
        await w.gitWith(handle, [...NO_HOOKS, "commit", "--no-edit"], gitIdentity(w.cfg.agent_git_identity));
      }
    }
    if (merge.exit_code !== 0 && !mechanical) {
      await w.recordConflicts(item, base_sha, conflicts);
      await comment([
        `PR #${item.change_ref} could not be updated with ${repo.base_branch}: merging \`${baseRef}\` conflicts in these files.`,
        `Nothing was pushed. The factory starts an automatic resolve run (at most ${AUTO_RESOLVE_LIMIT} per base commit); past that, a human needs to resolve them or comment \`/resolve\`.`,
        "",
        ...conflicts.map((f) => `- \`${f}\``),
      ].join("\n"));
      return { result: "conflict", conflicts, head_sha, base_sha };
    }
    // A new MySQL step whose number the base took moves to the next free number (issue #297), before the checks.
    await w.renumberSteps(run, handle, base_sha);

    // The check list in place of the test command (design §4), stopping at the first failure.
    const checks = await w.runCheckList(run, handle, signal);
    if (checks.failed) {
      const f = checks.failed;
      await comment([
        `PR #${item.change_ref} was not updated with ${repo.base_branch}: \`${baseRef}\` merged cleanly, but the tests failed on the updated branch (\`${commandText(f.command)}\` ${f.how}).`,
        "Nothing was pushed. A human needs to look.",
      ].join("\n"));
      const exit = f.how.match(/^exited (\d+)$/);
      return {
        result: "tests_failed", command: commandText(f.command), exit_code: exit ? Number(exit[1]) : null,
        timed_out: f.how === "timed out", head_sha, base_sha,
      };
    }
    const passed = checks.results.map((r) => `\`${commandText(r.command)}\``).join(", ");

    const merge_sha = (await w.git(handle, ["rev-parse", "HEAD"])).trim();
    const pushed = await w.route(item).broker.call(ctx, "github.push_branch", {
      workdir: handle.workdir,
      branch,
      base_ref: repo.base_branch,
    });
    if (!pushed.ok) throw new RunFailure(pushed.error_code, pushed.message);
    await w.recordPushedHead(run, ctx, merge_sha);
    await w.refreshPr(run, item, ctx, branch, checkedLines(checks.results, { fixed: false, skipped: null }));
    const how = mechanical
      ? `with only appended lines on both sides in ${mechanical.map((f) => `\`${f}\``).join(", ")}, merged in code (base lines first),`
      : "cleanly";
    await comment(
      `PR #${item.change_ref} updated with ${repo.base_branch}: merged \`${baseRef}\` (${base_sha.slice(0, 8)}) ${how} and ${passed} passed. A human merge is still required.`,
    );
    return { result: "pushed", merge_sha, head_sha, base_sha };
  } finally {
    await w.d.sandbox.destroy(handle);
  }
}

export default defineRunKind({
  name: "update",
  folder: false,
  timeouts: DEFAULT_TIMEOUTS,
  execute: (w, c) => update(w, c.run, c.item, c.ctx, c.signal),
});
