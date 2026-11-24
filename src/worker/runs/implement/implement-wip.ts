// The implement run's diff budget, WIP and bundle handling: the mid-run diff check, keeping a stopped or paused
// run's commits (wip branch, bundle), the preflight and a retry's resume from its wip branch. Split out of
// implement.run.ts so parallel items that change different parts of the run do not share one file.
import { type DiffStat, diffStat, overSizeLimit, sizeDetail, PREFLIGHT_FAILED, wipBranchFor, errorText, type Run, type RunResume, type WipRef, type WorkItem, type SandboxHandle, PREFLIGHT, type ToolCallContext } from "./legacy-imports.js";
import { type ContinueWip, DIFF_CHECK_MS, NO_HOOKS, PAUSE_NEXT_STEPS, RunFailure, RunPaused, WIP_TEXT_CHARS, baseRefspec, gitIdentity, hasTool } from "../../support.js";
import type { Worker } from "../../runner.js";
import { fetchBundle, saveBundle } from "../../bundle.js";

/** The mid-run diff check of one implement agent step: `over` is the diff that went over budget, once it did. */
export interface DiffBudget {
  limits: { max_diff_lines: number; max_diff_files: number };
  stop: AbortController;
  over: DiffStat | null;
}

/** The wip ref's next steps of a run the mid-run diff check stopped. */
const BUDGET_NEXT_STEPS = "the run stopped mid-way: its diff went over max_diff_lines or max_diff_files";
/** The wip ref's next steps of a run stopped mid-work. */
const STOPPED_NEXT_STEPS = "the run stopped mid-way (a usage limit, a stall or a timeout): continue the work item from the wip head";

/**
 * The context ceiling (design §5 Restarts): the implement main step's session stops once one model call's context
 * (input, cache read and cache write tokens) reaches this, and the run continues in a new session from its WIP
 * head. A constant, not a config key, until the owner asks to tune it.
 */
export const CONTEXT_CEILING_TOKENS = 150_000;
/** The code of a run whose new session reached the context ceiling before it made a commit: stopped, its work kept as WIP. */
export const CONTEXT_CEILING = "context_ceiling";
/** The wip ref's next steps of a run stopped at the context ceiling without progress. */
const CEILING_NEXT_STEPS = "the run stopped mid-way: a new session reached the context ceiling before it made a commit; continue the work item from the wip head in smaller steps";

/**
 * The mid-run diff check (design §4, issue #217): every DIFF_CHECK_MS on the worker's ticks while the implement
 * agent step runs, the committed branch diff against the base resolved before the run (three-dot, as the size
 * gate). Over max_diff_lines or max_diff_files: `over` is set and the agent step is aborted. Exactly at a limit
 * passes. A failed read is logged and tried again next interval; the post-sync size gate still runs.
 */
export async function watchDiff(w: Worker, run: Run, handle: SandboxHandle, baseSha: string, dirs: string, b: DiffBudget, stop: AbortSignal): Promise<void> {
  const ended = AbortSignal.any([stop, b.stop.signal]);
  await w.every("diff-watch", DIFF_CHECK_MS, ended, async (t) => {
    // The first tick is the agent step's start: the first check comes one DIFF_CHECK_MS later.
    if (!t.due) return;
    const stat = await branchDiff(w, handle, baseSha, dirs).catch((err: unknown) => {
      w.d.log.warn("mid-run diff check failed; trying again", { run_id: run.id, error: errorText(err) });
      return null;
    });
    if (ended.aborted) return;
    if (stat && overSizeLimit(stat, b.limits)) {
      b.over = stat;
      w.d.log.warn("diff over budget; stopping the agent", { run_id: run.id, lines: stat.lines, files: stat.files });
      b.stop.abort(new Error("diff_too_large"));
    }
  });
}

/**
 * The branch diff while the agent may still be writing its git folder: HEAD is read through the trusted env, then
 * the diff runs in an empty git folder the worker makes for it, reading only the run's objects. No repository,
 * global or system config is read there, and hooks are off, so nothing the agent wrote into its `.git` (diff
 * drivers, textconv, includes, hooks) changes the counts. The folder is removed after the read.
 */
async function branchDiff(w: Worker, handle: SandboxHandle, baseSha: string, dirs: string): Promise<DiffStat> {
  const head = (await w.git(handle, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).trim();
  const made = await w.d.sandbox.exec(handle, ["mktemp", "-d"], { env: w.d.toolEnv });
  const dir = made.stdout.trim();
  if (made.exit_code !== 0 || dir === "") throw new Error(`mktemp: ${made.stderr.trim()}`);
  const isolated = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  try {
    await w.gitWith(handle, ["init", "--bare", "--quiet", "--template=", dir], isolated);
    const numstat = await w.gitWith(handle, ["diff", "--numstat", "-z", "-M", `${baseSha}...${head}`], {
      ...isolated,
      GIT_DIR: dir,
      GIT_OBJECT_DIRECTORY: `${dirs.split("\n").at(-1)}/objects`,
    });
    return diffStat(numstat);
  } finally {
    await w.d.sandbox.exec(handle, ["rm", "-rf", "--", dir], { env: w.d.toolEnv }).catch(() => undefined);
  }
}

/**
 * A run the mid-run diff check stopped (design §4, issue #217): after the agent stopped, its git config is
 * distrusted as after any agent step, its commits since `start` go to the run's wip branch (no PR branch push,
 * no PR), and the run fails with `diff_too_large`, its detail giving both counts and both limits. No sync,
 * gate, check or later agent step runs. No commits: nothing is pushed.
 */
export async function overBudget(
  w: Worker,
  run: Run, item: WorkItem, handle: SandboxHandle, ctx: ToolCallContext, start: string, dirs: string, b: DiffBudget,
): Promise<RunFailure> {
  const failure = new RunFailure("diff_too_large", sizeDetail(b.over!, b.limits));
  await w.distrustAgentGit(handle, dirs);
  const head = (await w.git(handle, ["rev-parse", "HEAD"])).trim();
  const commits = (await w.git(handle, ["rev-list", `${start}..HEAD`])).split("\n").filter(Boolean).length;
  if (commits === 0) return failure;
  return keepWip(w, run, item, ctx, handle, failure, {
    branch: wipBranchFor(item, w.cfg.branch_prefix, run.id), head, commits, summary: "", next_steps: BUDGET_NEXT_STEPS, conflicts: [], missing: [], deviations: [],
  }, false);
}

/**
 * An implement run whose agent step stopped mid-work (design §5 Restarts: rate_limited, agent_stalled,
 * agent_timed_out). After the agent stopped, its git config is distrusted, the worktree's changes become one WIP
 * commit, and the commits since `start` go to the run's wip branch (no PR branch push, no PR), marked `continue`
 * so the retry runs the agent on them. When the sandbox can reattach and the runner stores sessions, the folder
 * and the agent session are kept on this host for a `--resume` there. No commits: nothing is pushed, the retry
 * starts fresh. A failed wip push keeps the original failure with no wip ref, and nothing is kept.
 */
export async function keepStopped(
  w: Worker,
  run: Run, item: WorkItem, handle: SandboxHandle, ctx: ToolCallContext, start: string, dirs: string, failure: RunFailure, next_steps = STOPPED_NEXT_STEPS,
  /** False: the session is not kept for a `--resume` (a session at the context ceiling has no room left). */
  resumable = true,
): Promise<RunFailure> {
  await w.distrustAgentGit(handle, dirs);
  await commitWorktree(w, handle, `wip: stopped run ${run.id} (${failure.code})`);
  const head = (await w.git(handle, ["rev-parse", "HEAD"])).trim();
  const commits = head === start ? 0 : (await w.git(handle, ["rev-list", `${start}..HEAD`])).split("\n").filter(Boolean).length;
  if (commits === 0) return failure;
  const s = w.scratch.get(run);
  const session = resumable && s?.step_session && w.d.sandbox.reattach && w.d.runner.hasSession
    ? { id: s.step_session, host: w.host, folder: handle.id, start, base_sha: handle.base_sha ?? null }
    : null;
  const wip: ContinueWip = {
    branch: wipBranchFor(item, w.cfg.branch_prefix, run.id),
    head,
    commits,
    summary: "",
    next_steps,
    conflicts: [],
    missing: [],
    deviations: [],
    continue: true,
    ...(session ? { session } : {}),
  };
  const kept = await keepWip(w, run, item, ctx, handle, failure, wip, false);
  if (session && kept.extra.wip && s) s.kept = { folder: handle.id, session: session.id };
  return kept;
}

/** The context ceiling of one agent session (design §5 Restarts): `on_context` aborts `stop` once one model call's context reaches CONTEXT_CEILING_TOKENS. */
export interface ContextCeiling {
  stop: AbortController;
  /** The context that reached the ceiling, once one did. */
  reached: number | null;
  on_context: (tokens: number) => void;
}

export function contextCeiling(w: Worker, run: Run): ContextCeiling {
  const c: ContextCeiling = {
    stop: new AbortController(),
    reached: null,
    on_context: (tokens) => {
      if (c.reached !== null || tokens < CONTEXT_CEILING_TOKENS) return;
      c.reached = tokens;
      w.d.log.info("context ceiling reached; continuing in a new session", { run_id: run.id, tokens });
      c.stop.abort(new Error(CONTEXT_CEILING));
    },
  };
  return c;
}

/**
 * Ends a session the context ceiling stopped (design §5 Restarts), with trusted git calls after the agent stopped:
 * its git config is distrusted, its uncommitted changes become one WIP commit, and the run's commits since `start`
 * are listed (`<sha> <subject>`, oldest first) for the next session's prompt. A session that made no progress since
 * `from` (its start: the first session counts its WIP commit, a later one only its own commits) fails the run as a
 * stopped run, `context_ceiling`, its work kept on the wip branch and not resumable, so a run never loops without progress.
 */
export async function endSession(
  w: Worker, run: Run, item: WorkItem, handle: SandboxHandle, ctx: ToolCallContext, start: string, from: string, dirs: string, first: boolean,
): Promise<{ head: string; commits: string[] }> {
  await w.distrustAgentGit(handle, dirs);
  const committed = (await w.git(handle, ["rev-parse", "HEAD"])).trim();
  await commitWorktree(w, handle, `wip: context ceiling of run ${run.id}`);
  const head = (await w.git(handle, ["rev-parse", "HEAD"])).trim();
  if ((first ? head : committed) === from) {
    const failure = new RunFailure(CONTEXT_CEILING, `a new session reached the context ceiling (${CONTEXT_CEILING_TOKENS} tokens in one model call) before it made a commit`);
    throw await keepStopped(w, run, item, handle, ctx, start, dirs, failure, CEILING_NEXT_STEPS, false);
  }
  const commits = (await w.git(handle, ["log", "--reverse", "--format=%h %s", `${start}..HEAD`])).split("\n").filter(Boolean);
  return { head, commits };
}

/**
 * Commits the worktree's changes under `paths` (all when none; tracked and untracked, not ignored) as one commit, with trusted git calls after the agent stopped. True when there were any.
 */
export async function commitWorktree(w: Worker, handle: SandboxHandle, message: string, paths: string[] = []): Promise<boolean> {
  const only = paths.length ? ["--", ...paths] : [];
  if ((await w.git(handle, ["status", "--porcelain", "-z", "--untracked-files=all", ...only])) === "") return false;
  await w.git(handle, [...NO_HOOKS, "add", "-A", ...only]);
  await w.gitWith(handle, [...NO_HOOKS, "commit", "--quiet", "--no-verify", "-m", message, ...only], gitIdentity(w.cfg.agent_git_identity));
  return true;
}

/**
 * An implement run's agent was paused (design §5 Pause). Trusted git calls only, after the agent stopped: the
 * agent's git config is distrusted as after any agent step, the worktree's changes (tracked and untracked, not
 * ignored) become one WIP commit when there are any, and a handoff row records it with text starting
 * `paused:` and the agent's last note (scanned, G5) as next steps. The run's commits since `start` go into a
 * git bundle in shared storage for a resume on another host, only when their patch text scans clean. Nothing
 * is pushed anywhere. Returns the pause, filled with its resume point.
 */
export async function pauseImplement(
  w: Worker,
  run: Run,
  item: WorkItem,
  handle: SandboxHandle,
  ctx: ToolCallContext,
  start: string,
  dirs: string,
  p: RunPaused,
): Promise<RunPaused> {
  await w.distrustAgentGit(handle, dirs);
  const dirty = await commitWorktree(w, handle, `wip: paused run ${run.id}`);
  const head = (await w.git(handle, ["rev-parse", "HEAD"])).trim();
  const commits = head === start ? 0 : (await w.git(handle, ["rev-list", `${start}..HEAD`])).split("\n").filter(Boolean).length;
  const bundle = head === start ? null : await saveRunBundle(w, run, item, handle, dirs, start);

  const worked_on = `paused: ${commits} commit${commits === 1 ? "" : "s"} of work in progress up to ${head.slice(0, 8)}${dirty ? ", uncommitted changes in one WIP commit" : ""}`;
  const note = p.last_note?.trim().slice(0, WIP_TEXT_CHARS) ?? "";
  const clean = note !== "" && (await w.d.scanner.scan("handoff", note)).clean;
  const h = await w.d.store.appendHandoff(
    { run_id: run.id, work_item_id: item.id, commit_sha: head, worked_on, next_steps: clean ? note : PAUSE_NEXT_STEPS },
    ctx.lease_token,
  );
  if (!h.ok) throw new RunFailure("lease_lost", "lease lost while writing the pause handoff", true);
  p.resume = { host: w.host, folder: handle.id, base_sha: handle.base_sha ?? null, start_sha: start, head, bundle };
  return p;
}

/**
 * The run's commits since `start` as a git bundle in shared storage, for a resume on another host (`saveBundle`):
 * kept only when their patch text scans clean (G5); otherwise such a resume starts from the branch and the handoff note. Returns the key.
 */
export async function saveRunBundle(w: Worker, run: Run, item: WorkItem, handle: SandboxHandle, dirs: string, start: string): Promise<string | null> {
  const patch = await w.git(handle, ["log", "-p", "--binary", "--format=%H%n%B", `${start}..HEAD`]);
  return saveBundle(w, run, item, handle, dirs, { revs: [`${start}..HEAD`], patch, what: "pause" });
}

/**
 * A paused run resumed in a new folder (another host, or its folder gone): fetches the WIP commit from the
 * pause's bundle and puts the branch on it. The commit must be the head the store recorded, so a changed
 * bundle is never trusted. False (logged) when there is no bundle or it does not restore: the run then starts
 * from the branch as it is, with the handoff note in its prompt.
 */
export async function restoreWip(w: Worker, run: Run, handle: SandboxHandle, branch: string, gitDir: string, state: RunResume): Promise<boolean> {
  const got = await fetchBundle(w, handle, gitDir, state.bundle, state.head);
  if (got === "missing") {
    w.d.log.warn("paused run: no WIP bundle to restore; starting from the branch", { run_id: run.id });
    return false;
  }
  if (got === "failed") {
    w.d.log.warn("paused run: the WIP bundle did not restore; starting from the branch", { run_id: run.id });
    return false;
  }
  await checkoutClean(w, handle, branch, state.head!);
  return true;
}

/**
 * The implement preflight (design §5 Restarts), before any agent step, in order: push access and the PR API
 * (the broker's read-only `forge.preflight`), then the base fetch from the factory repo into the run folder.
 * A failed check fails the run with the broker's code (`github_rate_limited` on a forge rate limit, which pauses
 * claims until its reset; `forge_auth` on another 401/403, else `preflight_access` for
 * push_access and pr_api, both pausing implement claims) or, for the base fetch, `preflight_failed`; its detail
 * starts with the check's name. A task failure, so max_attempts bounds it; it spends no agent tokens.
 */
export async function preflight(w: Worker, item: WorkItem, handle: SandboxHandle, ctx: ToolCallContext, branch: string): Promise<void> {
  const { repo } = w.cfg;
  const { broker, sandbox } = w.route(item);
  // A broker with no forge (the local one) has no preflight: only the base fetch below is checked.
  if (hasTool(broker, PREFLIGHT)) {
    const forge = await broker.call(ctx, PREFLIGHT, { branch, base_ref: repo.base_branch });
    if (!forge.ok) throw new RunFailure(forge.error_code, forge.message.slice(0, 500), forge.error_code === "lease_lost");
  }
  try {
    await sandbox.updateBase({ repo: repo.path, base_ref: repo.base_branch });
  } catch (err) {
    throw new RunFailure(PREFLIGHT_FAILED, `base_fetch: ${err instanceof Error ? err.message : "unknown"}`.slice(0, 500));
  }
  const fetched = await w.gitRaw(handle, ["fetch", "--quiet", "--no-tags", repo.path, baseRefspec(w.cfg, w.route(item).local)]);
  if (fetched.exit_code !== 0) throw new RunFailure(PREFLIGHT_FAILED, `base_fetch: ${fetched.stderr.trim()}`.slice(0, 500));
}

/**
 * A retry of an implement run whose push, PR, checks or base merge failed, or that stopped mid-work (design §5 Restarts): its input
 * names the wip branch and head. The head comes from the store, not the forge: if `origin/<wip branch>` is gone
 * or not that commit, the branch is not trusted and the run goes on as a fresh agent run. Otherwise the run's
 * branch is put on that commit: a push retry runs no agent, a `continue` one runs it there. Null: run the agent from the branch as it is.
 */
export async function resumeWip(w: Worker, run: Run, handle: SandboxHandle, branch: string): Promise<WipRef | null> {
  const wip = run.input?.wip;
  if (!wip) return null;
  const ref = wip.branch.startsWith(w.cfg.branch_prefix)
    ? await w.gitRaw(handle, ["rev-parse", "--verify", "--end-of-options", `origin/${wip.branch}^{commit}`])
    : null;
  if (!ref || ref.exit_code !== 0 || ref.stdout.trim() !== wip.head) {
    w.d.log.warn("wip branch missing or moved; running the agent again", { run_id: run.id, wip_branch: wip.branch });
    return null;
  }
  await checkoutClean(w, handle, branch, wip.head);
  return wip;
}

/**
 * Puts `branch` on `head` with a fresh index and no untracked files (ignored ones, such as node_modules, stay).
 * The clone starts on the base: after read-tree, files the base added since `head` are no longer tracked, so
 * checkout leaves them on disk, and the sync's `git merge` of the base then aborts on them ("untracked working
 * tree files would be overwritten"), with no unmerged path, as `git_failed` on every retry.
 */
async function checkoutClean(w: Worker, handle: SandboxHandle, branch: string, head: string): Promise<void> {
  await w.git(handle, ["read-tree", head]);
  await w.git(handle, [...NO_HOOKS, "checkout", "--quiet", "-f", "-B", branch, head]);
  await w.git(handle, [...NO_HOOKS, "clean", "-ffdq"]);
}

/**
 * A push or PR failure after the agent step (design §5 Restarts): keeps the commits on the forge before the run
 * fails, so the retry needs no agent. A run that resumed from a wip branch names it again and pushes nothing. A
 * failed wip push is only logged: the run fails with its original code, without a wip ref, and is retried as before (a new agent run). Returns the failure to throw.
 */
export async function keepWip(w: Worker, run: Run, item: WorkItem, ctx: ToolCallContext, handle: SandboxHandle, err: unknown, wip: WipRef, resumed: boolean): Promise<RunFailure> {
  const failure = err instanceof RunFailure
    ? err
    : new RunFailure("exception", err instanceof Error ? err.message.slice(0, 500) : "", true);
  if (failure.code === "lease_lost") return failure;
  let kept = resumed;
  if (!resumed) {
    // Stored in the factory repo, then a keyed push intent outbound delivers (RFC 0015 M7), as the PR branch's.
    kept = await w.storeBranch(item, ctx, handle.workdir, wip.branch, wip.head)
      .then(async (s) => {
        if (s.forge) await w.recordPush(item, run, { branch: wip.branch, sha: s.sha }, null);
        return true;
      })
      .catch((e: unknown) => {
        w.d.log.warn("wip push failed; the retry runs the agent again", { run_id: run.id, error_code: e instanceof RunFailure ? e.code : "exception" });
        return false;
      });
  }
  return kept ? new RunFailure(failure.code, failure.message, failure.infra, { ...failure.extra, wip }) : failure;
}
