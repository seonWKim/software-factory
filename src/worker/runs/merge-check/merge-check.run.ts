// The merge-check run (RFC 0015 §7 Merge queue, M8): checks a merge queue entry as it will land. No agent, no push,
// no forge call. In a fresh run folder at the base it merges the branches of the entries ahead and then this
// change's branch, in queue order, and runs the install command and then the checks on the result, then the UI check
// (`repo.ui_check`, design §4) when the merged result changes one of its paths. A conflict or a failing check is a
// result (`red`), not a run failure: the merge queue decides. Git and sandbox errors fail the run. A failing check's
// red result names the failing tests and keeps the output tail, as the implement run's `checks_failed` does.
// A failing check list whose output names failing test files reruns only those files once, with the same command
// (design §4); a passing rerun goes on, and the green result lists the flaky tests for the improve report (design §7).
// A failing UI check runs once more on the base alone, in a fresh checkout at the checked base: when the base fails
// it too, the result is `base_red` (red main, design 03-risk), not this change's failing checks. A UI check's
// failure always keeps an output tail: with no output, its reason (a command that could not run, its exit).

import { NO_HOOKS, RunFailure, failingTestNames, gitIdentity } from "../../support.js";
import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, defineRunKind, type RunCall } from "../../run-kind.js";

/** The check helpers the runner hands this run (core/checks.ts), so the run imports none of them. */
export interface MergeCheckTools {
  checkCommands(repo: Worker["cfg"]["repo"]): string[][];
  failingTestFiles(text: string): string[];
  withTestFiles(cmd: readonly string[], files: readonly string[]): string[];
}

type Failed = { command: readonly string[]; how: string; tail: string };

/** What the merge queue put in the run's input: the base, and the branches to merge onto it in order (this one last). */
function inputOf(run: RunCall["run"]): { base_ref: string; branches: string[] } {
  const i = run.input?.merge_check;
  if (!i || typeof i.base_ref !== "string" || !Array.isArray(i.branches) || i.branches.length === 0 || !i.branches.every((b) => typeof b === "string")) {
    throw new RunFailure("invalid_input", "a merge-check run needs base_ref and branches");
  }
  return i;
}

async function mergeCheck(w: Worker, c: RunCall): Promise<Record<string, unknown>> {
  const { run, item, signal } = c;
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
    // The install command first, then the configured checks (checkList: its failing test files get one rerun), as the
    // local merge ran them, then the UI check where Chrome can start (not in the agent sandbox) when the merged result
    // changes its paths. The install command and the UI check are not rerun.
    const ui = w.cfg.repo.ui_check;
    const changed = ui ? (await w.git(handle, ["diff", "--name-only", "-z", "--no-renames", base_sha, merged_sha])).split("\0").filter(Boolean) : [];
    const uiCheck = ui && changed.some((f) => ui.paths.some((p) => f.startsWith(p))) ? [[...ui.command]] : null;
    const red = async (failed: Failed, ui = false) => ({ result: "red", why: "checks", ...(await failure(w, failed, ui)), base_sha, merged_sha });
    const install = await w.runCheckList(run, handle, signal, { commands: [[...w.cfg.repo.install_command]] });
    if (install.failed) return red(install.failed);
    const list = await checkList(w, run, handle, signal);
    if (list.failed) return red(list.failed);
    const uiFailed = uiCheck ? (await w.runCheckList(run, handle, signal, { commands: uiCheck })).failed : null;
    if (uiFailed) {
      const onBase = await baseUiCheck(w, c, base_ref, base_sha, uiCheck!);
      if (onBase) return { result: "red", why: "base_red", ...(await failure(w, onBase, true)), base_sha };
      return red(uiFailed, true);
    }
    const flaky = list.flaky.length > 0 ? { flaky_tests: list.flaky } : {};
    return { result: "green", base_sha, merged_sha, heads, ...flaky };
  } finally {
    await w.d.sandbox.destroy(handle);
  }
}

/**
 * The UI check once more on the base alone (red main, design 03-risk): a fresh checkout of `base_ref`, pinned to the
 * checked `base_sha`, the install command, then the UI check. Returns its failure, or null when the base passes.
 */
async function baseUiCheck(w: Worker, { run, item, signal }: RunCall, base_ref: string, base_sha: string, uiCheck: string[][]): Promise<Failed | null> {
  const handle = await w.route(item).sandbox.create({ repo: w.cfg.repo.path, branch: null, base_ref }).catch((err: unknown) => {
    throw new RunFailure("git_failed", `worktree: ${err instanceof Error ? err.message : "unknown"}`, true);
  });
  try {
    await w.git(handle, [...NO_HOOKS, "checkout", "--quiet", "--detach", base_sha]);
    return (await w.runCheckList(run, handle, signal, { commands: [[...w.cfg.repo.install_command], ...uiCheck] })).failed;
  } finally {
    await w.d.sandbox.destroy(handle);
  }
}

/**
 * The check list (`repo.check_commands`, else the test command), with one rerun of a failing command on the test
 * files its output names: a passing rerun counts those tests as flaky (`file > name`) and the list goes on after
 * that command; a failing rerun, one that cannot start, or a failure naming no test file returns the first failure.
 */
async function checkList(w: Worker, run: RunCall["run"], handle: NonNullable<RunCall["handle"]>, signal: AbortSignal): Promise<{ failed: Failed | null; flaky: string[] }> {
  const tools: MergeCheckTools = w.checkTools;
  let rest = tools.checkCommands(w.cfg.repo);
  const flaky: string[] = [];
  while (rest.length > 0) {
    const r = await w.runCheckList(run, handle, signal, { commands: rest });
    if (!r.failed) break;
    const files = tools.failingTestFiles(r.failed.tail);
    if (files.length === 0) return { failed: r.failed, flaky };
    const again = await w.runCheckList(run, handle, signal, { commands: [tools.withTestFiles(r.failed.command, files)] });
    if (again.failed) return { failed: r.failed, flaky };
    flaky.push(...failingTestNames(r.failed.tail).filter((t) => !flaky.includes(t)));
    rest = rest.slice(r.results.length);
  }
  return { failed: null, flaky };
}

/**
 * What a failed check says: its command and exit text, the failing tests by name (`file > name`, at most 10, as
 * the implement run names them) and its output tail (at most CHECK_TAIL_CHARS, 2000). A UI check's empty tail is
 * its reason (`how`: could not run, or its exit), so every UI-check failure keeps one. The tail goes through the
 * egress scan first; a flagged tail is withheld whole (null), and the names are kept.
 */
async function failure(w: Worker, failed: Failed, ui = false): Promise<Record<string, unknown>> {
  const tail = ui && failed.tail === "" ? failed.how : failed.tail;
  const clean = tail === "" || (await w.d.scanner.scan("run_outcome", tail)).clean;
  return {
    command: failed.command.join(" "),
    how: failed.how,
    failing_tests: failingTestNames(failed.tail),
    output_tail: clean ? tail : null,
  };
}

export default defineRunKind({
  name: "merge-check",
  folder: false,
  timeouts: DEFAULT_TIMEOUTS,
  execute: (w, c) => mergeCheck(w, c),
});
