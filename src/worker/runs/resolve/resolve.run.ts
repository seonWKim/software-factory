import type { ModelClass } from "../../../core/model-choice.js";
import { checkCommands, checkedLines, commandText, redact, runChecks } from "../../../core/checks.js";
import { IMPLEMENT_SCHEMA, parseImplement } from "../../../core/outputs.js";
import { branchFor } from "../../../core/policy.js";
import { MYSQL_STEPS_DIR, type Renumbering, mergeAppendedConflicts } from "../../../core/mechanical.js";
import { type ConflictFile, renderResolvePrompt, resolveScopeViolations } from "../../../core/resolve.js";
import type { Run, WorkItem } from "../../../core/types.js";
import type { SandboxHandle } from "../../../interfaces/sandbox.js";
import type { ToolCallContext } from "../../../interfaces/tool-broker.js";
import { NO_HOOKS, RunFailure, gitIdentity, specQuery, staleStepNote, tail } from "../../support.js";
import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, defineRunKind } from "../../run-kind.js";

/**
 * The resolve run (design §5 Merge conflict), started by a human's `/resolve`. In the PR branch's sandbox:
 * merge origin/<base> with --no-commit and leave the conflicts; stage any MySQL step renumbering (issue #297);
 * snapshot the merged tree; let the agent resolve;
 * snapshot again. The worker never trusts the agent's index, refs or commits: the post-agent snapshot is the
 * tree that is pushed. Gates before any push: the scope gate (every path that differs between the two
 * snapshots, tracked, untracked or tracked-but-ignored, is a conflicting file or under allowed_paths), no
 * conflict markers in that tree, then the worker commits that exact tree itself as a merge of the branch tip
 * and the base, checks it out clean, and runs the install and test commands on it. HEAD must still be that
 * commit afterwards. Only then push through the broker (same branch, same PR, never a force push). Any
 * failure throws: nothing is pushed and the controller re-blocks the item.
 */
async function resolve(w: Worker, run: Run, item: WorkItem, ctx: ToolCallContext, signal: AbortSignal, model: ModelClass) {
  if (item.change_ref === null) throw new RunFailure("no_pr", "work item has no PR");
  // Its role's prompt and tools (src/worker/roles/resolve.role.ts), checked before anything is merged.
  await w.roleSpec("resolve");
  const { repo, branch_prefix } = w.cfg;
  const branch = branchFor(item, branch_prefix);
  const baseRef = `origin/${repo.base_branch}`;
  const identity = gitIdentity(w.cfg.agent_git_identity);
  const handle = await w.route(item).sandbox.create({ repo: repo.path, branch, base_ref: repo.base_branch }).catch((err: unknown) => {
    throw new RunFailure("git_failed", `worktree: ${err instanceof Error ? err.message : "unknown"}`, true);
  });
  try {
    // The sandbox starts a missing branch from base; a resolve must only ever touch the PR's own branch.
    await w.git(handle, ["rev-parse", "--verify", "--quiet", `origin/${branch}`]);
    const baseSha = await w.trustedBase(handle);
    // The run's own git folder, inside its workdir: the clone has no other.
    const gitDir = (await w.git(handle, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const dirs = await w.gitDirs(handle);
    const tipSha = (await w.git(handle, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).trim();
    const realIndex = (await w.git(handle, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
    const index = (await w.git(handle, ["rev-parse", "--path-format=absolute", "--git-path", "sf-resolve-index"])).trim();

    const merge = await w.gitRaw(
      handle,
      ["merge", "--no-ff", "--no-commit", "-m", `Merge ${baseRef} into ${branch}`, baseRef],
      identity,
    );
    const conflicts = (await w.git(handle, ["diff", "--name-only", "-z", "--diff-filter=U"])).split("\0").filter(Boolean);
    if (merge.exit_code !== 0 && conflicts.length === 0) throw new RunFailure("git_failed", `git merge: ${merge.stderr.trim()}`, true);
    // Only appended lines on both sides (issue #297): merged in code, no agent and no recorded conflict. The
    // scope gate has nothing to check (no agent changed the tree); markers, the commit and the gates still run.
    const mechanical = conflicts.length > 0 && (await mergeAppendedConflicts(w.mergeIO(handle), conflicts));
    if (conflicts.length > 0 && !mechanical) await w.recordConflicts(item, baseSha, conflicts);
    // A new MySQL step whose number the base took moves to the next free number (issue #297), staged before the
    // snapshot on the clean and the conflict path alike.
    const renumbered = await renumberPendingMerge(w, run, handle, baseSha, realIndex);

    // Seeded from the merge's own index (written by the worker, before the agent): every tracked path, ignored or not.
    const cp = await w.d.sandbox.exec(handle, ["cp", "--", realIndex, index], { env: w.d.toolEnv });
    if (cp.exit_code !== 0) throw new RunFailure("git_failed", `copy index: ${cp.stderr.trim()}`, true);
    const before = await snapshot(w, handle, index);
    let tree = before;
    if (conflicts.length > 0 && !mechanical) {
      const files: ConflictFile[] = [];
      for (const path of conflicts) {
        const r = await w.d.sandbox.exec(handle, ["cat", "--", path], { env: w.d.toolEnv });
        files.push({ path, text: r.exit_code === 0 ? r.stdout : "" });
      }
      const notes = run.input?.notes ?? "";
      const result = await w.agent(run, item, handle, signal, {
        prompt: await w.withIndex(renderResolvePrompt(item, baseRef, files, notes) + staleStepNote(renumbered, files), specQuery(item)),
        model_class: model,
        output_schema: IMPLEMENT_SCHEMA,
        writable_paths: [gitDir],
        env_allowlist: identity,
      });
      const out = parseImplement(result.output);
      if (!out.ok) throw new RunFailure("invalid_output", out.error, false, { output_tail: tail(result.transcript) });
      await w.distrustAgentGit(handle, dirs);
      // The agent asked for a human: nothing is committed or pushed; the PR is as it was.
      if (out.value.needs_human) return { needs_human: out.value.needs_human };

      // Re-seeded from the pre-agent tree, not the agent's index: no skip-worktree or assume-unchanged bits survive.
      await w.gitWith(handle, ["read-tree", before], { GIT_INDEX_FILE: index });
      tree = await snapshot(w, handle, index);
      const changed = await w.git(handle, ["diff", "--name-only", "-z", "--no-renames", before, tree]);
      const outside = resolveScopeViolations(changed, conflicts, item.allowed_paths);
      if (outside.length > 0) {
        throw new RunFailure("out_of_scope", `changed files outside the conflicts and allowed_paths: ${outside.join(", ")}`.slice(0, 500));
      }
    }
    if (conflicts.length > 0) {
      const markers = await w.gitRaw(handle, ["grep", "-l", "-E", "^(<<<<<<<|>>>>>>>)( |$)", tree, "--", ...conflicts]);
      if (markers.exit_code === 0) throw new RunFailure("unresolved_conflicts", `conflict markers left in: ${markers.stdout.trim()}`.slice(0, 500));
    }

    const head = await commitResolution(w, handle, { tree, tipSha, baseSha, branch, message: `Merge ${baseRef} into ${branch}` }, identity);
    // install_command first, then the check list (design §4); only the checks get the test database.
    await gate(w, run, handle, repo.install_command, signal, false);
    for (const cmd of checkCommands(repo)) await gate(w, run, handle, cmd, signal, true);
    // The gate commands run repo code: they must not have moved HEAD off the commit they checked.
    const now = (await w.git(handle, ["rev-parse", "HEAD"])).trim();
    if (now !== head) throw new RunFailure("head_moved", `HEAD moved from ${head.slice(0, 8)} to ${now.slice(0, 8)} during the gates`);

    const pushed = await w.route(item).broker.call(ctx, "github.push_branch", { workdir: handle.workdir, branch, base_ref: repo.base_branch });
    if (!pushed.ok) throw new RunFailure(pushed.error_code, pushed.message);
    await w.recordPushedHead(run, ctx, head);
    const passed = checkCommands(repo).map((command) => ({ command, ok: true, how: "passed", tail: "" }));
    await w.refreshPr(run, item, ctx, branch, checkedLines(passed, { fixed: false, skipped: null }));
    return { result: "pushed", conflicts, head_sha: head, base_sha: baseSha };
  } finally {
    await w.d.sandbox.destroy(handle);
  }
}

/**
 * The resolve run's renumbering (design §5 Merge conflict), after its merge and before its snapshot, so the
 * moves are part of the merge and never the agent's changes. Staged, not committed: the run commits the checked
 * tree itself. A failure restores the index and the tracked files from before it, removes any moved step file,
 * logs, and lets the run go on as if nothing moved.
 */
async function renumberPendingMerge(w: Worker, run: Run, handle: SandboxHandle, baseSha: string, realIndex: string): Promise<Renumbering[]> {
  const saved = `${realIndex}.sf-renumber`;
  const cp = (from: string, to: string) => w.d.sandbox.exec(handle, ["cp", "--", from, to], { env: w.d.toolEnv });
  const copied = await cp(realIndex, saved);
  if (copied.exit_code !== 0) throw new RunFailure("git_failed", `copy index: ${copied.stderr.trim()}`, true);
  try {
    return await w.stageRenumbering(run, handle, ["--cached", baseSha]);
  } catch (err) {
    const restored = await cp(saved, realIndex);
    if (restored.exit_code !== 0) throw new RunFailure("git_failed", `restore index: ${restored.stderr.trim()}`, true);
    await w.git(handle, [...NO_HOOKS, "checkout-index", "-a", "-f"]);
    await w.git(handle, [...NO_HOOKS, "clean", "-fdq", "--", MYSQL_STEPS_DIR]);
    w.d.log.warn("migration renumbering failed: the index is restored and the run goes on", {
      run_id: run.id,
      error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
    });
    return [];
  }
}

/**
 * The working tree as a tree object, staged through the worker's own index file (seeded by the caller) so
 * the merge's index, with its conflict stages, is untouched. `add -A` updates every path the seed tracks,
 * including ones .gitignore matches, and adds untracked files that are not ignored. Hooks are off.
 */
async function snapshot(w: Worker, handle: SandboxHandle, index: string): Promise<string> {
  const env = { GIT_INDEX_FILE: index };
  await w.gitWith(handle, [...NO_HOOKS, "add", "-A"], env);
  return (await w.gitWith(handle, ["write-tree"], env)).trim();
}

/**
 * Commits exactly the checked `tree` as the merge of the branch tip and the base (commit-tree: no index, no
 * hooks, none of the agent's commits), puts the branch on it and makes the working tree match it, so the
 * gate commands test what is pushed. If the base was already in the branch and nothing changed, the tip is kept.
 */
async function commitResolution(
  w: Worker,
  handle: SandboxHandle,
  c: { tree: string; tipSha: string; baseSha: string; branch: string; message: string },
  identity: Record<string, string>,
): Promise<string> {
  const already = await w.gitRaw(handle, ["merge-base", "--is-ancestor", c.baseSha, c.tipSha]);
  const tipTree = already.exit_code === 0 ? (await w.git(handle, ["rev-parse", `${c.tipSha}^{tree}`])).trim() : null;
  const head =
    tipTree === c.tree
      ? c.tipSha
      : (await w.gitWith(handle, ["commit-tree", c.tree, "-p", c.tipSha, "-p", c.baseSha, "-m", c.message], identity)).trim();
  await w.git(handle, [...NO_HOOKS, "merge", "--quit"]);
  // A fresh real index first: the agent's skip-worktree or assume-unchanged bits would make checkout refuse or lie.
  await w.git(handle, ["read-tree", head]);
  await w.git(handle, [...NO_HOOKS, "checkout", "--quiet", "-f", "-B", c.branch, head]);
  await w.git(handle, [...NO_HOOKS, "clean", "-ffdxq"]);
  return head;
}

/**
 * One gate command (install, or a check) in the sandbox with the worker's tool env and slot env; a check also gets the
 * run's test database env, and its output is redacted. Non-zero: `tests_failed`.
 */
async function gate(w: Worker, run: Run, handle: SandboxHandle, cmd: readonly string[], signal: AbortSignal, check: boolean): Promise<void> {
  const db = check ? await w.database(run) : null;
  const round = await runChecks({
    sandbox: w.d.sandbox,
    handle,
    commands: [cmd],
    env: { ...w.d.toolEnv, ...w.slotEnv(), ...db?.env },
    timeout_ms: w.cfg.run_timeout_ms,
    signal,
    redact: db?.redact ?? [],
  });
  if (signal.aborted) throw new RunFailure("lease_lost", "run aborted", true);
  const f = round.failed;
  if (f) throw new RunFailure("tests_failed", `\`${commandText(f.command)}\` ${f.how}`, false, f.tail ? { output_tail: f.tail } : {});
}

export default defineRunKind({
  name: "resolve",
  folder: false,
  timeouts: DEFAULT_TIMEOUTS,
  execute: (w, c) => resolve(w, c.run, c.item, c.ctx, c.signal, c.model),
});
