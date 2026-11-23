// Sync before push for the implement run (design §4): the base merge, its conflict and resolve steps, and the
// `merge_conflict` failure. Split out of implement.run.ts so parallel items that change different parts of the
// run do not share one file.
import { type ModelClass, type CheckResult, commandText, failingTestFiles, IMPLEMENT_SCHEMA, NEEDS_HUMAN_MAX_CHARS, NEEDS_HUMAN_MAX_PATHS, type NeedsHuman, branchFor, isCovered, mergeAppendedConflicts, type ConflictFile, renderResolvePrompt, type Run, type WorkItem, type AgentRunSpec, type SandboxHandle } from "./legacy-imports.js";
import { MAX_CONFLICT_COMMITS, NO_HOOKS, RunFailure, baseRefspec, gitIdentity, renderWorkItem, tail } from "../../support.js";
import type { Worker } from "../../runner.js";
import { conflictAsk, conflictRetryLines } from "./conflict-ask.js";
import { differs, unmerged } from "./implement-checks.js";

/**
 * Sync before push (design §4, decided 2026-11-01): fetches origin/<base> after the implementer exited and
 * merges that commit into the branch with a merge commit (never a rebase, never a force push). A conflict
 * gets an agent step in the same run to resolve the files; the worker, not the agent, then decides: no
 * unmerged paths, a working tree that matches what will be committed, no conflict markers, a passing test
 * command and HEAD unmoved by it. A failed step is retried once in the same run as a resolve step
 * (decision changed 2026-11-02): the worker puts the branch back on the implementer's last commit, merges
 * again and runs the resolve prompt, under the same checks. A resumed run (design §5 Restarts) runs only that
 * resolve step. Not resolved: `merge_conflict`, with the branch back on the implementer's last commit, which `keep`
 * keeps on the wip branch (design §5 Restarts), or a needs_human ask when the retry's checks failed only on test files outside allowed_paths (conflict-ask.ts). Returns the merged-in base SHA, the one every pre-push check diffs against, and the
 * conflicting files, which the scope gate lets through. Git hooks are off for the merge and the commit: the agent's writable git dir could have planted one.
 */
export async function syncBase(
  w: Worker,
  run: Run,
  item: WorkItem,
  handle: SandboxHandle,
  signal: AbortSignal,
  gitDir: string,
  dirs: string,
  trustedBaseSha: string,
  model: ModelClass,
  resumed: boolean, // a resumed run (design §5 Restarts): one resolve step only
  keep: (err: RunFailure, head: string, conflicts: string[]) => Promise<RunFailure>, // keeps head on the wip branch
): Promise<{ baseSha: string; merged: boolean; conflicts: string[] } | { needs_human: NeedsHuman }> {
  const { repo } = w.cfg;
  const baseRef = `origin/${repo.base_branch}`;
  // From the factory repo, freshly fetched outside the clone; never the clone's own remote (design §5).
  const fresh = await w.route(item).sandbox.updateBase({ repo: repo.path, base_ref: repo.base_branch });
  await w.git(handle, ["fetch", "--quiet", "--no-tags", repo.path, baseRefspec(w.cfg, w.route(item).local)]);
  const baseSha = (await w.git(handle, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`])).trim();
  if (baseSha !== fresh) throw new RunFailure("untrusted_base", "the clone's base does not match the factory repo's");
  // The fetched base may only move forward from the base the sandbox resolved before any agent ran.
  if (baseSha !== trustedBaseSha) {
    const forward = await w.gitRaw(handle, ["merge-base", "--is-ancestor", trustedBaseSha, baseSha]);
    if (forward.exit_code !== 0) throw new RunFailure("untrusted_base", "the fetched base does not contain the base resolved before the run");
  }

  const ancestor = await w.gitRaw(handle, ["merge-base", "--is-ancestor", baseSha, "HEAD"]);
  if (ancestor.exit_code === 0) return { baseSha, merged: false, conflicts: [] };
  if (ancestor.exit_code !== 1) throw new RunFailure("git_failed", `git merge-base: ${ancestor.stderr.trim()}`, true);
  const fork = (await w.git(handle, ["merge-base", "HEAD", baseSha])).trim();
  // The implementer's last commit: a failed conflict step is retried from here.
  const tip = (await w.git(handle, ["rev-parse", "HEAD"])).trim();

  const identity = gitIdentity(w.cfg.agent_git_identity);
  const branch = branchFor(item, w.cfg.branch_prefix);
  const message = `Merge ${baseRef} (${baseSha.slice(0, 8)}) into ${branch}`;
  const merge = await w.gitRaw(handle, [...NO_HOOKS, "merge", "--no-ff", "--no-edit", "-m", message, baseSha], identity);
  if (merge.exit_code === 0) return { baseSha, merged: true, conflicts: [] };

  const conflicts = await unmerged(w, handle);
  if (conflicts.length === 0) throw new RunFailure("git_failed", `git merge: ${merge.stderr.trim()}`, true);
  // Only appended lines on both sides (issue #297): merged in code, base lines first. No agent step, and no
  // recorded conflict, so no learned weight. The pre-push gates and checks still run on the merged tree.
  if (await mergeAppendedConflicts(w.mergeIO(handle), conflicts)) {
    w.d.log.info("merge conflict merged in code: only appended lines", { run_id: run.id, files: conflicts.join(", ") });
    return commitSync(w, handle, baseSha, conflicts, true, identity);
  }
  await w.recordConflicts(item, baseSha, conflicts);
  const step = { run, item, handle, signal, gitDir, dirs, baseSha, conflicts, identity, model };
  const failed = async (files: string[], why: string, transcript: string) => {
    await restartMerge(w, handle, tip, branch);
    return mergeConflict(w, run, item, files, why, transcript, resumed, (e) => keep(e, tip, files));
  };
  const resolvable = await w.roleSpec("resolve").then(() => true, () => false);
  if (resumed) {
    if (!resolvable) return failed(conflicts, "no resolve prompt for a resumed run", "");
    const only = await resolveStep(w, step, baseRef, conflicts, "");
    if (only.failure !== null) return failed(conflicts, `the resolve step failed: ${only.failure}`, only.transcript);
    return commitSync(w, handle, baseSha, conflicts, only.pending, identity);
  }
  const touched = (await w.git(handle, [
    "log", "--no-merges", `--max-count=${MAX_CONFLICT_COMMITS}`, "--format=%H %s", `${fork}..${baseSha}`, "--", ...conflicts,
  ])).split("\n").filter(Boolean).map((l) => `- ${l.slice(0, 8)} ${l.slice(41)}`);
  const first = await conflictStep(w, step, "merge", {
    prompt: [
      renderWorkItem(item, { includeSpec: true }),
      "## Merge conflicts",
      "",
      `The factory merged \`${baseRef}\` (${baseSha.slice(0, 8)}) into this branch before pushing, and the merge conflicts. Your work is already committed. Resolve the conflicts so both the base's changes and this work item's changes are kept, then \`git add\` each resolved file. Do not commit, abort the merge, rebase or reset: the factory checks that no unmerged paths remain, runs the tests and commits the merge. Change nothing beyond what the resolution needs.`,
      "",
      "Conflicting files:",
      ...conflicts.map((f) => `- \`${f}\``),
      "",
      `Base commits since this branch forked that touched them${touched.length === MAX_CONFLICT_COMMITS ? ` (newest ${MAX_CONFLICT_COMMITS})` : ""}:`,
      ...(touched.length ? touched : ["- (none found)"]),
    ].join("\n"),
    output_schema: IMPLEMENT_SCHEMA,
  });
  if (first.failure === null) return commitSync(w, handle, baseSha, conflicts, first.pending, identity);

  // Retry as a resolve step (decision changed 2026-11-02): same run, nothing pushed in between.
  if (!resolvable) return failed(conflicts, `${first.failure} (no resolve prompt for a retry)`, first.transcript);
  await restartMerge(w, handle, tip, branch);
  const again = await w.gitRaw(handle, [...NO_HOOKS, "merge", "--no-ff", "--no-edit", "-m", message, baseSha], identity);
  if (again.exit_code === 0) return { baseSha, merged: true, conflicts: [] };
  const left = await unmerged(w, handle);
  if (left.length === 0) throw new RunFailure("git_failed", `git merge: ${again.stderr.trim()}`, true);
  const second = await resolveStep(w, { ...step, conflicts: left }, baseRef, left, ["", "## Earlier attempt in this run", "", `A first resolution step failed the factory's checks: ${first.failure}. The branch was put back on the work item's last commit and the base merged again, so the conflicts above are fresh. You do not need to stage or commit; the factory stages the conflicting files and tracked changes, then checks and commits the merge.`,
    ...(await conflictRetryLines(w, first.checks)),
  ].join("\n"));
  if (second.failure !== null) {
    const ask = conflictAsk(second.checks, { failingTestFiles, covered: (p) => isCovered(p, item.allowed_paths), grantable: (ps) => w.live.autoGrantable(item.project, ps), maxPaths: NEEDS_HUMAN_MAX_PATHS, maxChars: NEEDS_HUMAN_MAX_CHARS });
    if (ask) return { needs_human: ask };
    return failed(left, `${first.failure}; the retry as a resolve step failed too: ${second.failure}`, second.transcript);
  }
  return commitSync(w, handle, baseSha, left, second.pending, identity);
}

/** The resolve step on a conflicted merge: the resolve prompt with each conflicting file's text, then `earlier`. */
async function resolveStep(w: Worker, step: Parameters<typeof conflictStep>[1], baseRef: string, conflicts: string[], earlier: string) {
  const files: ConflictFile[] = [];
  for (const path of conflicts) {
    const r = await w.d.sandbox.exec(step.handle, ["cat", "--", path], { env: w.d.toolEnv });
    files.push({ path, text: r.exit_code === 0 ? r.stdout : "" });
  }
  return conflictStep(w, step, "resolve", {
    prompt: [renderResolvePrompt(step.item, baseRef, files, ""), earlier].filter(Boolean).join("\n"),
    output_schema: IMPLEMENT_SCHEMA,
  });
}

/** Commits a resolved, checked merge that is still pending (the agent may have committed it already). */
async function commitSync(
  w: Worker,
  handle: SandboxHandle,
  baseSha: string,
  conflicts: string[],
  pending: boolean,
  identity: Record<string, string>,
): Promise<{ baseSha: string; merged: boolean; conflicts: string[] }> {
  if (pending) await w.gitWith(handle, [...NO_HOOKS, "commit", "--no-edit"], identity);
  return { baseSha, merged: true, conflicts };
}

/**
 * Puts the branch back on the implementer's last commit with a clean index and working tree, whatever the
 * failed conflict step did (staged, committed, aborted, switched branch, set index bits). Ignored files stay.
 */
async function restartMerge(w: Worker, handle: SandboxHandle, tip: string, branch: string): Promise<void> {
  await w.git(handle, ["read-tree", tip]);
  await w.git(handle, [...NO_HOOKS, "checkout", "--quiet", "-f", "-B", branch, tip]);
  await w.git(handle, [...NO_HOOKS, "reset", "--quiet", "--hard", tip]);
  await w.git(handle, [...NO_HOOKS, "clean", "-ffdq"]);
}

/**
 * One agent step on a conflicted merge, then the worker's checks. `merge` (the implement prompt): the agent
 * stages its resolution. `resolve` (the retry): the worker stages the conflicting files and tracked changes.
 * Checks: no unmerged paths, the merge not aborted, nothing unstaged or uncommitted, no conflict markers in the
 * conflicting files, the test command passes and HEAD did not move during it. Returns the first failed
 * check in words, or null; `pending` says whether the merge still needs its commit.
 */
async function conflictStep(
  w: Worker,
  s: {
    run: Run; item: WorkItem; handle: SandboxHandle; signal: AbortSignal; gitDir: string; dirs: string;
    baseSha: string; conflicts: string[]; identity: Record<string, string>; model: ModelClass;
  },
  name: "merge" | "resolve",
  spec: Pick<AgentRunSpec, "prompt" | "output_schema">,
): Promise<{ failure: string | null; pending: boolean; transcript: string; checks: CheckResult | undefined }> {
  const { run, item, handle, signal, conflicts } = s;
  const result = await w.agent(run, item, handle, signal, {
    ...spec,
    ...(name === "resolve" ? { role: "resolve" as const } : {}),
    model_class: s.model,
    writable_paths: [s.gitDir],
    env_allowlist: s.identity,
  }, name);
  await w.distrustAgentGit(handle, s.dirs);
  const done = (failure: string | null, pending = false, checks?: CheckResult) => ({ failure, pending, transcript: result.transcript, checks });

  const pending = (await w.gitRaw(handle, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).exit_code === 0;
  if (name === "resolve" && pending) {
    await w.git(handle, ["add", "-u"]);
    // A conflicting file the resolution deleted (modify/delete) is staged by `add -u` and matches no path any
    // more, which `add` rejects: pass only the conflicting paths still in the index or the working tree.
    const kept = (await w.git(handle, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...conflicts])).split("\0").filter(Boolean);
    if (kept.length > 0) await w.git(handle, ["add", "-A", "--", ...kept]);
  }
  const left = await unmerged(w, handle);
  if (left.length > 0) return done(`unmerged paths remain after the resolution step: ${left.join(", ")}`);
  if (!pending) {
    // The agent committed or aborted the merge itself; only a branch that contains the base may go on.
    const has = await w.gitRaw(handle, ["merge-base", "--is-ancestor", s.baseSha, "HEAD"]);
    if (has.exit_code !== 0) return done("the merge was aborted during the resolution step");
  }
  // The tests run on the working tree but the commit takes the index (or the agent already committed): both
  // must match the working tree for tracked files, or the push could carry content the tests never saw.
  const unstaged = await differs(w, handle, ["diff", "--quiet"]);
  const uncommitted = !pending && (await differs(w, handle, ["diff", "--cached", "--quiet"]));
  if (unstaged || uncommitted) {
    return done(`the resolution left changes ${unstaged ? "not staged" : "not committed"}, so the tests would not see what is pushed`);
  }
  const markers = await w.gitRaw(handle, ["grep", "--cached", "-l", "-E", "^(<<<<<<<|>>>>>>>)( |$)", "--", ...conflicts]);
  if (markers.exit_code === 0) return done(`conflict markers left in: ${markers.stdout.trim().split("\n").join(", ")}`);
  if (markers.exit_code !== 1) throw new RunFailure("git_failed", `git grep: ${markers.stderr.trim()}`, true);

  // The check list (design §4): one list everywhere, stopping at the first failure.
  const head = (await w.git(handle, ["rev-parse", "HEAD"])).trim();
  const checks = await w.runCheckList(run, handle, signal);
  if (checks.failed) {
    return done(`tests failed after the resolution (\`${commandText(checks.failed.command)}\` ${checks.failed.how})`, false, checks.failed);
  }
  // The checks run repo code: they must not have moved HEAD or finished the merge itself.
  const now = (await w.git(handle, ["rev-parse", "HEAD"])).trim();
  if (now !== head) return done(`HEAD moved from ${head.slice(0, 8)} to ${now.slice(0, 8)} during the tests`);
  return done(null, pending);
}

/** The `merge_conflict` failure: `keep` keeps the commits on the wip branch, then a comment names the files and that branch. */
async function mergeConflict(
  w: Worker, run: Run, item: WorkItem, conflicts: string[], why: string, transcript: string, resumed: boolean, keep: (err: RunFailure) => Promise<RunFailure>,
): Promise<never> {
  // The files go into the failed outcome as `conflicts` too: the improver's hotspot count reads only that (design §7).
  const extra = { output_tail: tail(transcript), conflicts };
  const failure = new RunFailure("merge_conflict", `${why}; conflicting files: ${conflicts.join(", ")}`.slice(0, 500), false, extra);
  const kept = await keep(failure);
  const base = w.cfg.repo.base_branch;
  const body = [
    "## Factory sync check: push blocked",
    "",
    `Before pushing, the implement run merged \`origin/${base}\` into the branch and the merge conflicted. ${resumed ? "The run resumed from its wip branch and its resolve step could not resolve the conflict" : "The conflict could not be resolved, also after a retry as a resolve step"}: ${why}.`,
    "",
    kept.extra.wip ? `Nothing was pushed to the change's branch. The commits are kept on the wip branch \`${kept.extra.wip.branch}\`; the retry resolves the conflict on them. Conflicting files:` : "Nothing was pushed. Conflicting files:",
    "",
    ...conflicts.map((f) => `- \`${f}\``),
  ].join("\n");
  await w.comment(item, { pr: null, body, marker: `<!-- factory:merge-conflict:${run.id} -->` });
  throw kept;
}
