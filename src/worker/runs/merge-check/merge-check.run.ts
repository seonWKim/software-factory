// The merge-check run (RFC 0015 §7 Merge queue, M8): checks a merge queue entry as it will land. No agent, no push,
// no forge call. In a fresh run folder at the base it merges the branches of the entries ahead and then this
// change's branch, in queue order, and runs the install command (through the run-side install cache, design
// 05-sandbox) and then the checks on the result, then the UI check
// (`repo.ui_check`, design §4) when the merged result changes one of its paths. A conflict or a failing check is a
// result (`red`), not a run failure: the merge queue decides. Git and sandbox errors fail the run. A failing check's
// red result names the failing tests and keeps the output tail, as the implement run's `checks_failed` does.
// A failing check list whose output names failing test files reruns only those files once, with the same command
// (design §4); a passing rerun goes on, and the green result lists the flaky tests for the improve report (design §7).
// A failing UI check runs once more on the base alone, in a fresh checkout at the checked base: when the base fails
// it too, the result is `base_red` (red main, design 03-risk), not this change's failing checks. A UI check's
// failure always keeps an output tail: with no output, its reason (a command that could not run, its exit).
// A failing test file the item's selection before push skipped in enforce mode is a test selection miss (design §4):
// the red result names it (`selection_miss`) and the project's selection goes back to shadow mode.
// With `repo.check_tz` (design §4), every command here (install, checks, UI check, base UI rerun) runs with TZ set to
// that zone, so a test that passes only in the machine's zone fails before merge; absent, no TZ is set.
// Install and checks run on the project's Node major (.nvmrc, else package.json engines; node-version.ts); a project
// whose Node is not installed fails the run with checks_env rather than checking on another Node. A project naming a
// JDK major (.java-version, else the root Gradle toolchain; jdk-version.ts) fails the run with checks_env when the
// worker's JDK has another major or there is none, rather than checking on another JDK.

import { NO_HOOKS, RunFailure, failingTestNames, gitIdentity } from "../../support.js";
import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, defineRunKind, type RunCall } from "../../run-kind.js";
import { cachedInstall } from "../../install-cache.js";
import { type NodeChoice, chooseNode, offNode, onNode, projectNode } from "./node-version.js";
import { checkJdk, projectJdk } from "./jdk-version.js";

/** The check helpers the runner hands this run (core/checks.ts), so the run imports none of them. */
export interface MergeCheckTools {
  checkCommands(repo: Worker["cfg"]["repo"]): GateEntry[];
  /** The install step (design 04-gate-commands): `repo.install_commands`, else `repo.install_command` through `cache`. */
  installStep<R>(repo: Worker["cfg"]["repo"], run: (commands: GateEntry[]) => Promise<R>, cache: (install: () => Promise<R>) => Promise<R | null>): Promise<R | null>;
  failingTestFiles(text: string): string[];
  withTestFiles(cmd: GateEntry, files: readonly string[]): GateEntry;
  /** The entry a check result ran (its argv, in its folder when it had one). */
  ranEntry(r: Failed): GateEntry;
  /** A command as it is shown: its argv, then `(in <dir>/)` for a folder entry. */
  commandText(cmd: GateEntry): string;
  /** Test selection's revert (design §4): failing files the item's enforced selection left out switch it back to shadow. */
  mergeMiss(d: Worker["d"], item: RunCall["item"], failing: readonly string[], run_id: RunCall["run"]["id"]): Promise<{ selection_miss?: string[] }>;
}

type CheckRound = Awaited<ReturnType<Worker["runCheckList"]>>;
type GateEntry = NonNullable<Worker["cfg"]["repo"]["check_commands"]>[number];
type Failed = { command: string[]; dir?: string; how: string; tail: string };

/** The env every merge-check command runs with: TZ from `repo.check_tz`, else nothing added. */
const checkEnv = (w: Worker): Record<string, string> => (w.cfg.repo.check_tz ? { TZ: w.cfg.repo.check_tz } : {});

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
    const uiCheck = ui && changed.some((f) => ui.paths.some((p) => f.startsWith(p))) ? [ui.command] : null;
    const want = await projectNode(w, handle, merged_sha);
    const node: NodeChoice = want ? await chooseNode(w, handle, want) : { bin: null, version: "" };
    // Which Node ran the checks, in the worker log and the run's result: no version named is said, never silent.
    const nodeUsed = want ? `Node ${node.version} (${want.from})` : "the worker's Node: no version in .nvmrc or package.json engines";
    w.d.log.info(`merge check runs on ${nodeUsed}`, { run_id: run.id, node_bin: node.bin ?? "worker" });
    const jdk = await projectJdk(w, handle, merged_sha);
    if (jdk) w.d.log.info(`merge check runs on JDK ${await checkJdk(w, handle, jdk)} (${jdk.from})`, { run_id: run.id });
    const red = async (failed: Failed, ui = false) => ({ result: "red", why: "checks", ...(await failure(w, failed, ui)), base_sha, merged_sha, node: nodeUsed });
    const runOn = async (commands: readonly GateEntry[]) => {
      // The full test command runs under the run's host test slot (design 04-pre-push-gates), matched off its Node wrapper.
      const r = await w.runCheckList(run, handle, signal, { commands: commands.map((c) => viaNode(node, c)), env: checkEnv(w), slot: offNodeEntry });
      return { ...r, failed: r.failed && { ...r.failed, command: offNode(r.failed.command) } };
    };
    const install = await w.checkTools.installStep(w.cfg.repo, runOn, (go) => cachedInstall(w, handle, go));
    if (install?.failed) return red(install.failed);
    const list = await checkList(w, runOn);
    // The list stays whole in every selection mode; a failing file the item's enforced selection skipped is a miss.
    if (list.failed) return { ...(await red(list.failed)), ...(await w.checkTools.mergeMiss(w.d, item, w.checkTools.failingTestFiles(list.failed.tail), run.id)) };
    const uiFailed = uiCheck ? (await runOn(uiCheck)).failed : null;
    if (uiFailed) {
      const onBase = await baseUiCheck(w, c, base_ref, base_sha, uiCheck!, node);
      if (onBase) return { result: "red", why: "base_red", ...(await failure(w, onBase, true)), base_sha, node: nodeUsed };
      return red(uiFailed, true);
    }
    const flaky = list.flaky.length > 0 ? { flaky_tests: list.flaky } : {};
    return { result: "green", base_sha, merged_sha, heads, node: nodeUsed, ...flaky };
  } finally {
    await w.d.sandbox.destroy(handle);
  }
}

/**
 * The UI check once more on the base alone (red main, design 03-risk): a fresh checkout of `base_ref`, pinned to the
 * checked `base_sha`, the install command, then the UI check, on the same Node as the change. Returns its failure, or
 * null when the base passes.
 */
async function baseUiCheck(w: Worker, { run, item, signal }: RunCall, base_ref: string, base_sha: string, uiCheck: readonly GateEntry[], node: NodeChoice): Promise<Failed | null> {
  const handle = await w.route(item).sandbox.create({ repo: w.cfg.repo.path, branch: null, base_ref }).catch((err: unknown) => {
    throw new RunFailure("git_failed", `worktree: ${err instanceof Error ? err.message : "unknown"}`, true);
  });
  try {
    await w.git(handle, [...NO_HOOKS, "checkout", "--quiet", "--detach", base_sha]);
    const runOn = async (commands: readonly GateEntry[]) => (await w.runCheckList(run, handle, signal, { commands: commands.map((cmd) => viaNode(node, cmd)), env: checkEnv(w) })).failed;
    const failed = (await w.checkTools.installStep(w.cfg.repo, async (install) => ({ failed: await runOn(install) }), (go) => cachedInstall(w, handle, go)))?.failed ?? (await runOn(uiCheck));
    return failed && { ...failed, command: offNode(failed.command) };
  } finally {
    await w.d.sandbox.destroy(handle);
  }
}

/**
 * The check list (`repo.check_commands`, else the test command), with one rerun of a failing command on the test
 * files its output names: a passing rerun counts those tests as flaky (`file > name`) and the list goes on after
 * that command; a failing rerun, one that cannot start, or a failure naming no test file returns the first failure.
 */
async function checkList(w: Worker, runOn: (commands: readonly GateEntry[]) => Promise<CheckRound>): Promise<{ failed: Failed | null; flaky: string[] }> {
  const tools: MergeCheckTools = w.checkTools;
  let rest = tools.checkCommands(w.cfg.repo);
  const flaky: string[] = [];
  while (rest.length > 0) {
    const r = await runOn(rest);
    if (!r.failed) break;
    const files = tools.failingTestFiles(r.failed.tail);
    if (files.length === 0) return { failed: r.failed, flaky };
    const again = await runOn([tools.withTestFiles(tools.ranEntry(r.failed), files)]);
    if (again.failed) return { failed: r.failed, flaky };
    flaky.push(...failingTestNames(r.failed.tail).filter((t) => !flaky.includes(t)));
    rest = rest.slice(r.results.length);
  }
  return { failed: null, flaky };
}

/** A gate entry on the chosen Node (onNode), its folder kept. */
function viaNode(node: NodeChoice, e: GateEntry): GateEntry {
  return "argv" in e ? { dir: e.dir, argv: onNode(node, e.argv) } : onNode(node, e);
}

/** A gate entry as the project names it, without the Node wrapper `viaNode` adds. */
function offNodeEntry(e: GateEntry): GateEntry {
  return "argv" in e ? { dir: e.dir, argv: offNode(e.argv) } : offNode(e);
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
    command: w.checkTools.commandText(w.checkTools.ranEntry(failed)),
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
