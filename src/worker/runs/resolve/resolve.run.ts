import type { ModelClass } from "../../../core/model-choice.js";
import { type CheckResult, checkCommands, checkedLines, commandText, failingTestFiles, installStep, ranEntry, ranFields, runChecks } from "../../../core/checks.js";
import { IMPLEMENT_SCHEMA, NEEDS_HUMAN_MAX_CHARS, NEEDS_HUMAN_MAX_PATHS, type NeedsHuman, parseImplement } from "../../../core/outputs.js";
import { branchFor, isCovered, parseAutoResolveKey } from "../../../core/policy.js";
import { mergeAppendedConflicts } from "../../../core/mechanical.js";
import { type ConflictFile, RESOLVE_TESTS_FAILED, lastResolveFailure, renderResolvePrompt, resolveScopeViolations } from "../../../core/resolve.js";
import type { Run, WorkItem } from "../../../core/types.js";
import { type Sandbox, type SandboxHandle, reconcileOf } from "../../../interfaces/sandbox.js";
import type { ToolCallContext } from "../../../interfaces/tool-broker.js";
import { NO_HOOKS, RunFailure, failingTestNames, gitIdentity, resolveScopeDetail, specQuery, tail } from "../../support.js";
import { conflictAsk } from "../implement/conflict-ask.js";
import type { Worker } from "../../runner.js";
import { cachedInstall } from "../../install-cache.js";
import { DEFAULT_TIMEOUTS, type RunCall, defineRunKind } from "../../run-kind.js";
import { RESUME_LOST, fetchBundle, saveBundle } from "../../bundle.js";

/** A gate entry (design 04-gate-commands): a plain argv, or `{ dir, argv }` run in that folder. */
type GateEntry = ReturnType<typeof checkCommands>[number];

/**
 * The resolve run (design §5 Merge conflict), started by a human's `/resolve` or automatically. In the PR branch's
 * sandbox, or a local item's (no PR: the local route, whose `origin/<base>` and `origin/<branch>` are the factory
 * repo's local base and branch, and whose store commits to the local branch with nothing pushed to a remote):
 * merge origin/<base> with --no-commit and leave the conflicts; snapshot the merged tree; let the agent resolve;
 * snapshot again. The worker never trusts the agent's index, refs or commits: the post-agent snapshot is the
 * tree that is pushed. Gates before any push: the scope gate (every path that differs between the two
 * snapshots, tracked, untracked or tracked-but-ignored, is a conflicting file or under allowed_paths), no
 * conflict markers in that tree, then the worker commits that exact tree itself as a merge of the branch tip
 * and the base, checks it out clean, and runs the install and test commands on it. HEAD must still be that
 * commit afterwards. Only then push through the broker (same branch, same PR, never a force push). Any
 * failure throws: nothing is pushed and the controller re-blocks the item. A failed check stores its failing
 * tests and output tail; one that fails only in test files the run could not edit asks for them instead.
 */
async function resolve(w: Worker, run: Run, item: WorkItem, ctx: ToolCallContext, signal: AbortSignal, model: ModelClass, step: RunCall["step"]) {
  if (item.change_ref === null && !w.route(item).local) throw new RunFailure("no_pr", "work item has no PR");
  // Its role's prompt and tools (src/worker/roles/resolve.role.ts), checked before anything is merged.
  await w.roleSpec("resolve");
  const { repo, branch_prefix } = w.cfg;
  const branch = branchFor(item, branch_prefix);
  const baseRef = `origin/${repo.base_branch}`;
  const identity = gitIdentity(w.cfg.agent_git_identity);
  // A local item's sandbox reads the factory repo's local base and branch, also with a forge selected (its route).
  const { sandbox } = w.route(item);
  // A base reconcile (design 05-sources): origin's base as fetched is merged into the item's branch, made from local main.
  const origin = reconcileOf(item) === null ? null : await startReconcile(w, sandbox, branch);
  const handle = await sandbox.create({ repo: repo.path, branch, base_ref: repo.base_branch }).catch((err: unknown) => {
    throw new RunFailure("git_failed", `worktree: ${err instanceof Error ? err.message : "unknown"}`, true);
  });
  try {
    // The sandbox starts a missing branch from base; a resolve must only ever touch the item's own branch.
    await w.git(handle, ["rev-parse", "--verify", "--quiet", `origin/${branch}`]);
    // The merge, the agent, the gates and the merge commit are one journaled step whose result carries a bundle of
    // that commit: a run taken over before its push restores the checked commit and runs no agent and no gate again.
    let ran = false;
    const done = await step("resolve", async (): Promise<Resolved> => {
      ran = true;
      return mergeAndResolve(w, run, item, handle, signal, model, { branch, baseRef, identity, origin });
    });
    if ("needs_human" in done) return { needs_human: done.needs_human };
    const { conflicts, head, base_sha: baseSha } = done;
    if (!ran) await restoreResolution(w, run, handle, branch, done);

    // Stored and recorded as keyed intents (RFC 0015 M7): outbound pushes it and refreshes the PR body behind it. A
    // local item's store is the commit on its local branch: no intent, nothing pushed.
    const passed = checkCommands(repo).map((e) => ({ ...ranFields(e), ok: true, how: "passed", tail: "" }));
    const push_intent = await w.pushBranch({ run, item, ctx, step }, handle.workdir, branch, head, () =>
      w.prRefresh(item, checkedLines(passed, { fixed: false })));
    return { result: "pushed", conflicts, head_sha: head, base_sha: baseSha, ...(push_intent ? { push_intent } : {}) };
  } finally {
    await sandbox.destroy(handle);
  }
}

/**
 * A reconcile item's start (design 05-sources, Base reconcile): the sandbox fetches origin's base and makes the item's
 * branch from local main when it is missing; returns origin's commit, which the run merges. A sandbox that cannot is
 * `no_reconcile`; a failed fetch is infra, retried.
 */
async function startReconcile(w: Worker, sandbox: Sandbox, branch: string): Promise<string> {
  const { repo } = w.cfg;
  if (!sandbox.startReconcile) throw new RunFailure("no_reconcile", "this sandbox cannot start a base reconcile");
  const r = await sandbox.startReconcile({ repo: repo.path, base_ref: repo.base_branch, branch }).catch((err: unknown) => {
    throw new RunFailure("git_failed", `reconcile: ${err instanceof Error ? err.message : "unknown"}`, true);
  });
  return r.origin;
}

/** The journaled result of the resolve step: a human was asked for, or the checked merge commit and its bundle. */
type Resolved =
  | { readonly needs_human: NeedsHuman }
  | {
    readonly conflicts: string[];
    readonly head: string;
    readonly base_sha: string;
    /** Shared-storage key of the bundle of the merge commit; null when it did not scan clean (G5) or is the tip. */
    readonly bundle: string | null;
  };

/**
 * The resolve step, in the run's folder: merge the base, let the agent resolve what does not merge in code, gate
 * the snapshot, commit it as the merge, run the install and check commands on it, and bundle the commit.
 */
async function mergeAndResolve(
  w: Worker, run: Run, item: WorkItem, handle: SandboxHandle, signal: AbortSignal, model: ModelClass,
  o: { branch: string; baseRef: string; identity: Record<string, string>; origin: string | null },
): Promise<Resolved> {
  const { repo } = w.cfg;
  const { branch, baseRef, identity } = o;
  // A reconcile merges origin's commit (its objects are the factory repo's, which the run folder borrows), not local main.
  const baseSha = o.origin ?? (await w.trustedBase(handle));
  // The run's own git folder, inside its workdir: the clone has no other.
  const gitDir = (await w.git(handle, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const dirs = await w.gitDirs(handle);
  const tipSha = (await w.git(handle, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).trim();
  const realIndex = (await w.git(handle, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
  const index = (await w.git(handle, ["rev-parse", "--path-format=absolute", "--git-path", "sf-resolve-index"])).trim();
  // The toolchain warms the branch tip, before the merge: the merged tree may not build until the agent fixes its
  // conflicts (design 05-sandbox.md). The run is marked warmed, so its agent step does not warm again.
  await w.warmOnce(run, handle, signal);

  const merge = await w.gitRaw(
    handle,
    ["merge", "--no-ff", "--no-commit", "-m", `Merge ${baseRef} into ${branch}`, o.origin ?? baseRef],
    identity,
  );
  const conflicts = (await w.git(handle, ["diff", "--name-only", "-z", "--diff-filter=U"])).split("\0").filter(Boolean);
  if (merge.exit_code !== 0 && conflicts.length === 0) throw new RunFailure("git_failed", `git merge: ${merge.stderr.trim()}`, true);
  // Only appended lines on both sides (issue #297): merged in code, no agent and no recorded conflict. The
  // scope gate has nothing to check (no agent changed the tree); markers, the commit and the gates still run.
  const mechanical = conflicts.length > 0 && (await mergeAppendedConflicts(w.mergeIO(handle), conflicts));
  if (conflicts.length > 0 && !mechanical) await w.recordConflicts(item, baseSha, conflicts);

  // A failure from here on names the conflicting files as outcome `conflicts` (the improver's hotspot count, design §7).
  try {
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
      // An automatic attempt after a failed one gets that run's failing tests and output tail (design 05-merge-conflict).
      const earlier = parseAutoResolveKey(run.idempotency_key) ? lastResolveFailure(await w.d.store.listRuns(item.id), run.id) : null;
      const result = await w.agent(run, item, handle, signal, {
        prompt: await w.withIndex(renderResolvePrompt(item, baseRef, files, notes, earlier), specQuery(item)),
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
        throw new RunFailure("out_of_scope", resolveScopeDetail(outside).slice(0, 500));
      }
    }
    if (conflicts.length > 0) {
      const markers = await w.gitRaw(handle, ["grep", "-l", "-E", "^(<<<<<<<|>>>>>>>)( |$)", tree, "--", ...conflicts]);
      if (markers.exit_code === 0) throw new RunFailure("unresolved_conflicts", `conflict markers left in: ${markers.stdout.trim()}`.slice(0, 500));
    }

    const head = await commitResolution(w, handle, { tree, tipSha, baseSha, branch, message: `Merge ${baseRef} into ${branch}` }, identity);
    // The install step first (installStep: install_commands, else install_command through the run-side install cache), then the check list (design §4).
    const installed = await installStep(repo, async (install) => ({ failed: await gates(w, handle, install, signal) }), (go) => cachedInstall(w, handle, go));
    const failed = installed?.failed ?? (await gates(w, handle, checkCommands(repo), signal));
    if (failed) {
      const ask = testPathsAsk(w, item, conflicts, failed);
      if (ask) return { needs_human: ask };
      throw await testsFailed(w, failed);
    }
    // The gate commands run repo code: they must not have moved HEAD off the commit they checked.
    const now = (await w.git(handle, ["rev-parse", "HEAD"])).trim();
    if (now !== head) throw new RunFailure("head_moved", `HEAD moved from ${head.slice(0, 8)} to ${now.slice(0, 8)} during the gates`);

    // Only the merge commit goes in the bundle: the other side has the tip and the base.
    const bundle = head === tipSha ? null : await saveBundle(w, run, item, handle, dirs, {
      revs: ["HEAD", `^${tipSha}`, `^${baseSha}`], patch: await w.git(handle, ["diff", "--binary", tipSha, "HEAD"]), what: "resolve", suffix: ".resolve",
    });
    return { conflicts, head, base_sha: baseSha, bundle };
  } catch (err) {
    throw withConflicts(err, conflicts);
  }
}

/** `err` with `conflicts` in its failed outcome when it is a RunFailure and the merge conflicted; else `err` as it was. */
function withConflicts(err: unknown, conflicts: string[]): unknown {
  if (!(err instanceof RunFailure) || conflicts.length === 0) return err;
  const extra = { ...err.extra, conflicts };
  return new RunFailure(err.code, err.message, err.infra, extra);
}

/**
 * A resolve run taken over after its resolve step: the checked merge commit comes back from the step's bundle (or
 * is already the branch tip) and is checked out clean; no agent and no gate runs again. No bundle to restore:
 * `resume_lost` (infra), retried afresh.
 */
async function restoreResolution(w: Worker, run: Run, handle: SandboxHandle, branch: string, done: Exclude<Resolved, { needs_human: NeedsHuman }>): Promise<void> {
  const present = await w.gitRaw(handle, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${done.head}^{commit}`]);
  if (present.exit_code !== 0) {
    const gitDir = (await w.git(handle, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    if ((await fetchBundle(w, handle, gitDir, done.bundle, done.head)) !== "restored") {
      throw new RunFailure(RESUME_LOST, "the finished resolve step's merge commit could not be restored", true);
    }
  }
  await w.git(handle, ["read-tree", done.head]);
  await w.git(handle, [...NO_HOOKS, "checkout", "--quiet", "-f", "-B", branch, done.head]);
  await w.git(handle, [...NO_HOOKS, "clean", "-ffdxq"]);
  w.d.log.info("run resumes after its resolve step", { run_id: run.id, attempt: run.attempt });
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

/** The gate commands (install, then each check) in order in the sandbox with the worker's tool env and slot env; the first failure, or null. */
async function gates(w: Worker, handle: SandboxHandle, commands: readonly GateEntry[], signal: AbortSignal): Promise<CheckResult | null> {
  const round = await runChecks({
    sandbox: w.d.sandbox,
    handle,
    commands,
    env: { ...w.d.toolEnv, ...w.slotEnv() },
    timeout_ms: w.cfg.run_timeout_ms,
    signal,
    redact: [],
  });
  if (signal.aborted) throw new RunFailure("lease_lost", "run aborted", true);
  return round.failed;
}

/**
 * The ask for a resolution whose checks failed only in test files it could not edit (neither a conflicting file nor
 * under allowed_paths), by the implement run's rules (conflictAsk); null when it stays `tests_failed`.
 */
function testPathsAsk(w: Worker, item: WorkItem, conflicts: readonly string[], failed: CheckResult): NeedsHuman | null {
  const ask = conflictAsk(failed, {
    failingTestFiles,
    covered: (p) => conflicts.includes(p) || isCovered(p, item.allowed_paths),
    grantable: (ps) => w.live.autoGrantable(item.project, ps),
    maxPaths: NEEDS_HUMAN_MAX_PATHS,
    maxChars: NEEDS_HUMAN_MAX_CHARS,
  });
  if (!ask) return null;
  const reason = `The resolve run merged the base, but the checks failed (\`${commandText(ranEntry(failed))}\` ${failed.how}) only in test files outside the allowed paths: ${ask.paths.join(", ")}. Nothing was pushed.`;
  return {
    reason: reason.length > NEEDS_HUMAN_MAX_CHARS ? `${reason.slice(0, NEEDS_HUMAN_MAX_CHARS - 1)}…` : reason,
    question: "Allow these test files (`/resolve` with a `+paths` line naming them), so the resolve run can run again and update them with the merge?",
    paths: ask.paths,
  };
}

/**
 * `tests_failed`: the command and exit text, then the failing tests by name (at most 10, as the merge check names
 * them) in the detail and in `failing_tests`, and the output tail in `output_tail` after the egress scan; a flagged
 * tail is withheld (null) as the merge check withholds it, and the names are kept.
 */
async function testsFailed(w: Worker, failed: CheckResult): Promise<RunFailure> {
  const failing_tests = failingTestNames(failed.tail);
  const clean = failed.tail === "" || (await w.d.scanner.scan("run_outcome", failed.tail)).clean;
  const named = failing_tests.length > 0 ? `; failing tests: ${failing_tests.join(", ")}` : "";
  // output_tail is null when withheld, as in the merge check's outcome; RunFailure's extra types only a string.
  const extra = { failing_tests, output_tail: clean ? failed.tail : null } as RunFailure["extra"];
  return new RunFailure(RESOLVE_TESTS_FAILED, `\`${commandText(ranEntry(failed))}\` ${failed.how}${named}`.slice(0, 500), false, extra);
}

export default defineRunKind({
  name: "resolve",
  folder: false,
  // The resolve step holds the agent (run_timeout_ms), the install command and every check: three hours.
  timeouts: { ...DEFAULT_TIMEOUTS, steps: { resolve: { start_to_close_ms: 3 * 3_600_000 } } },
  execute: (w, c) => resolve(w, c.run, c.item, c.ctx, c.signal, c.model, c.step),
});
