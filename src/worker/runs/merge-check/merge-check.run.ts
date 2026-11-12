// The merge-check run (RFC 0015 §7 Merge queue, M8): checks a merge queue entry as it will land. No agent, no push,
// no forge call. In a fresh run folder at the base it merges the branches of the entries ahead and then this
// change's branch, in queue order, and runs the install command and then the checks on the result, then the UI check
// (`repo.ui_check`, design §4) when the merged result changes one of its paths. A conflict or a failing check is a
// result (`red`), not a run failure: the merge queue decides. Git and sandbox errors fail the run.

import { NO_HOOKS, RunFailure, gitIdentity } from "../../support.js";
import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, defineRunKind, type RunCall } from "../../run-kind.js";

/** What the merge queue put in the run's input: the base, and the branches to merge onto it in order (this one last). */
function inputOf(run: RunCall["run"]): { base_ref: string; branches: string[] } {
  const i = run.input?.merge_check;
  if (!i || typeof i.base_ref !== "string" || !Array.isArray(i.branches) || i.branches.length === 0 || !i.branches.every((b) => typeof b === "string")) {
    throw new RunFailure("invalid_input", "a merge-check run needs base_ref and branches");
  }
  return i;
}

async function mergeCheck(w: Worker, { run, item, signal }: RunCall): Promise<Record<string, unknown>> {
  const { base_ref, branches } = inputOf(run);
  const handle = await w.route(item).sandbox.create({ repo: w.cfg.repo.path, branch: null, base_ref }).catch((err: unknown) => {
    throw new RunFailure("git_failed", `worktree: ${err instanceof Error ? err.message : "unknown"}`, true);
  });
  try {
    const base_sha = (await w.git(handle, ["rev-parse", "HEAD"])).trim();
    // Each branch's head as merged here: the landing merges only these commits (one made meanwhile is checked again).
    const heads: Record<string, string> = {};
    for (const branch of branches) {
      heads[branch] = (await w.git(handle, ["rev-parse", "--verify", "--end-of-options", `origin/${branch}^{commit}`])).trim();
      const merge = await w.gitRaw(
        handle,
        [...NO_HOOKS, "merge", "--no-ff", "--no-edit", "-m", `Merge ${branch} (merge check)`, `origin/${branch}`],
        gitIdentity(w.cfg.agent_git_identity),
      );
      if (merge.exit_code === 0) continue;
      const conflicts = (await w.git(handle, ["diff", "--name-only", "-z", "--diff-filter=U"])).split("\0").filter(Boolean);
      if (conflicts.length === 0) throw new RunFailure("git_failed", `git merge: ${merge.stderr.trim()}`, true);
      return { result: "red", why: "conflict", branch, conflicts, base_sha };
    }
    const merged_sha = (await w.git(handle, ["rev-parse", "HEAD"])).trim();
    // The install command first, then the configured checks (runCheckList's default list), as the local merge ran them,
    // then the UI check where Chrome can start (not in the agent sandbox) when the merged result changes its paths.
    const ui = w.cfg.repo.ui_check;
    const changed = ui ? (await w.git(handle, ["diff", "--name-only", "-z", "--no-renames", base_sha, merged_sha])).split("\0").filter(Boolean) : [];
    const uiRound = ui && changed.some((f) => ui.paths.some((p) => f.startsWith(p))) ? [{ commands: [[...ui.command]] }] : [];
    for (const round of [{ commands: [[...w.cfg.repo.install_command]] }, {}, ...uiRound]) {
      const r = await w.runCheckList(run, handle, signal, round);
      if (r.failed) return { result: "red", why: "checks", command: r.failed.command.join(" "), how: r.failed.how, base_sha, merged_sha };
    }
    return { result: "green", base_sha, merged_sha, heads };
  } finally {
    await w.d.sandbox.destroy(handle);
  }
}

export default defineRunKind({
  name: "merge-check",
  folder: false,
  timeouts: DEFAULT_TIMEOUTS,
  execute: (w, c) => mergeCheck(w, c),
});
