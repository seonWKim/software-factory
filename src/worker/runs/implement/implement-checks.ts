// The implement run's pre-push checks and gates (design §4): the check rounds and their fix step, the base rerun,
// the agent's gate hooks, and the scope, size and floor gates. Split out of implement.run.ts so parallel items
// that change different parts of the run do not share one file.
import { AGENT_STOP_CHECKS_DEFAULT, settingValues, type FloorHit, NumstatError, diffGates, scopeGate, BASE_CHECKOUT_DIR, CHECKS_FAILED_RUN, type CheckResult, type DoneCheckResult, TOOLCHAIN_MISSING, PrePushSelection, checkCommands, checkedLinesText, commandText, doneCheckRound, failingTestFiles, toolchainMissing, withTestFiles, IMPLEMENT_SCHEMA, parseImplement, removedPins, isCovered, sizeCaps, CHECKS_ENV, CHECKS_ENV_LIMIT, type Run, type WorkItem, type GateHooks, type PackRefusal, type StopSelection, type SandboxHandle } from "./legacy-imports.js";
import { type FixContext, NO_HOOKS, RunFailure, failingTestNames, gitIdentity, renderWorkItem, scopeReply, tail } from "../../support.js";
import type { Worker } from "../../runner.js";
import { outputLines } from "./conflict-ask.js";

/**
 * The pre-push checks of an implement run (design §4, decided 2026-11-03): `repo.check_commands` in order on
 * the committed branch, stopping at the first failure. A failure gets one fix step in the same run (the
 * implement prompt with the failing command and its output tail; the agent commits the fix), then the whole
 * list runs again. On a second failure the failing test files run again on the base commit (failsOnBase):
 * when they fail there too, the run fails with `checks_env`; otherwise one comment names the command and the
 * run fails with `checks_failed`. Both rounds run in ratchet shrink mode (SHRINK_ENV). Returns the passing round's results and whether a
 * fix step ran; the caller commits the lowered lists, then runs the scope, size and floor gates again on the final diff.
 */
export async function checksBeforePush(w: Worker, run: Run, item: WorkItem, handle: SandboxHandle, signal: AbortSignal, s: FixContext, sel: PrePushSelection): Promise<{ results: CheckResult[]; fixed: boolean; done: DoneCheckResult[] | undefined }> {
  // Each round selects the test files its own diff reaches; enforce mode runs only those, shadow mode notes misses (design §4).
  // The item's done checks run in the same round, after the check list (doneCheckRound); their failure is a failed check.
  const done = doneCheckRound(w.cfg.repo, item.done_checks);
  const round = async () => {
    const r = done.mark(sel.saw(await w.runCheckList(run, handle, signal, { ...SHRINK_ENV, commands: await sel.commands(done.commands, (a) => w.git(handle, a), s.baseSha) })));
    // A failed test file check whose file the branch does not have says so, not its exit code (design 04-pre-push-gates).
    return done.testFile(r) ? done.missing(r, (await w.git(handle, ["ls-files", "-z", "--", "tests"])).split("\0").filter(Boolean)) : r;
  };
  await cleanTree(w, handle);
  const first = await round();
  if (!first.failed) return { results: first.results, fixed: false, done: done.results(first) };
  // A missing install is the host's, not the branch's: no fix step, and an infra failure (issue #229).
  const missing = toolchainMissing(first.failed.tail);
  if (missing) throw new RunFailure(TOOLCHAIN_MISSING, `\`${ranText(w, first.failed)}\` could not start its tools: ${missing}`.slice(0, 500), true, { output_tail: first.failed.tail });
  await fixStep(w, run, item, handle, signal, s, first.failed);
  await cleanTree(w, handle);
  const second = await round();
  if (!second.failed) return { results: second.results, fixed: true, done: done.results(second) };
  const onBase = second.failed.missing ? null : await failsOnBase(w, run, handle, signal, s.baseSha, second.failed);
  if (onBase) return checksEnv(w, run, item, second.failed, onBase);
  return checksFailed(w, run, item, first.failed, second.failed, done.results(second), await grantTests(w, handle, s.baseSha, item, second.failed));
}

/**
 * The base rerun (design §4, decided 2026-11-07): the test files `failed` names run again with the same
 * command and env, on a temporary detached worktree of `baseSha` inside the run folder (BASE_CHECKOUT_DIR),
 * removed afterwards. Returns the files when every one fails on the base too; null when the output names no
 * test file (no base run), when one of them passes or is missing on the base, or when the base run cannot start (logged): those stay `checks_failed`.
 */
async function failsOnBase(w: Worker, run: Run, handle: SandboxHandle, signal: AbortSignal, baseSha: string, failed: CheckResult): Promise<string[] | null> {
  const files = failingTestFiles(failed.tail);
  if (files.length === 0) return null;
  const cannotStart = (why: string) => {
    w.d.log.warn("base rerun could not start; the run fails with checks_failed", { run_id: run.id, error: why.slice(0, 300) });
    return null;
  };
  try {
    await removeBaseCheckout(w, handle);
    await w.git(handle, [...NO_HOOKS, "worktree", "add", "--quiet", "--detach", BASE_CHECKOUT_DIR, baseSha]);
  } catch (err) {
    await removeBaseCheckout(w, handle);
    return cannotStart(err instanceof Error ? err.message : "unknown");
  }
  try {
    const round = await w.runCheckList(run, handle, signal, { commands: [withTestFiles(w.checkTools.ranEntry(failed), files)], cwd: BASE_CHECKOUT_DIR });
    if (!round.failed) return null;
    const missing = round.failed.how.startsWith("could not run") ? round.failed.how : toolchainMissing(round.failed.tail);
    if (missing) return cannotStart(missing);
    const alsoFailing = new Set(failingTestFiles(round.failed.tail));
    return files.every((f) => alsoFailing.has(f)) ? files : null;
  } finally {
    await removeBaseCheckout(w, handle);
  }
}

/** Removes the base rerun's worktree, if there is one; best effort, a failure leaves it for the next add to refuse. */
async function removeBaseCheckout(w: Worker, handle: SandboxHandle): Promise<void> {
  await w.gitRaw(handle, [...NO_HOOKS, "worktree", "remove", "--force", BASE_CHECKOUT_DIR]);
  await w.gitRaw(handle, ["worktree", "prune"]);
}

/**
 * The fix step: one agent call with the implement prompt, write tools and the run's own git folder writable (as the merge step), for a failed
 * check or a before_finish pack check's refusal. The output tail goes through the egress scan first; a finding drops it from the prompt.
 */
export async function fixStep(
  w: Worker,
  run: Run,
  item: WorkItem,
  handle: SandboxHandle,
  signal: AbortSignal,
  s: FixContext,
  failed: CheckResult | PackRefusal,
): Promise<void> {
  const output = await outputLines(w, "check" in failed ? failed.reason : failed.tail);
  const cmd = "check" in failed ? failed.check : ranText(w, failed);
  const result = await w.agent(run, item, handle, signal, {
    prompt: [
      renderWorkItem(item, { includeSpec: true }),
      "check" in failed ? "## A pack check refused before push" : "## Checks failed before push",
      "",
      "check" in failed
        ? `Before its gates, the factory ran the pack check \`${cmd}\` on this branch and it refused. Your work is already committed. Find the cause, fix it and commit the fix. Do not rebase, reset, amend or push: the factory runs the pack checks again (refusals past the check's retries fail the run), then its checks and the scope, size and floor gates, and pushes only if all pass. Change only files under the allowed paths.`
        : `Before pushing, the factory ran its checks on this branch and \`${cmd}\` failed (${failed.how})${checkedLinesText(failed)}. Your work is already committed. Its output below is what to fix: find the cause, fix it, run \`${cmd}\` yourself to confirm, and commit the fix. Do not rebase, reset, amend or push: the factory runs every check again, then the scope, size and floor gates, and pushes only if all pass. This is the only fix step in this run. Change only files under the allowed paths.`,
      ...("missing" in failed && failed.missing ? ["", missingNote(failed.missing)] : []),
      "",
      ...output,
    ].join("\n"),
    model_class: s.model,
    output_schema: IMPLEMENT_SCHEMA,
    writable_paths: [s.gitDir],
    env_allowlist: gitIdentity(w.cfg.agent_git_identity),
    gate_hooks: await gateHooks(w, run, item, s.start, s.baseSha, (await PrePushSelection.open(w.d.store, w.cfg.repo, item.project, () => {})).mode),
  }, "check" in failed ? `pack-${failed.check}` : "fix");
  const out = parseImplement(result.output);
  if (!out.ok) throw new RunFailure("invalid_output", out.error, false, { output_tail: tail(result.transcript) });
  await w.distrustAgentGit(handle, s.dirs);
}

/** The fix step's note on a test file check whose file does not exist: the closest existing test file by name, when there is one. */
function missingNote(m: NonNullable<CheckResult["missing"]>): string {
  const closest = m.closest ? ` The closest existing test file by name is \`${m.closest}\`: if it holds the tests this check means, say so in your answer.` : "";
  return `The test file \`${m.file}\` does not exist on this branch, so the check found no tests to run.${closest} Otherwise create \`${m.file}\` with the tests for its done-when line.`;
}

/** A check result's command as it is shown: its argv, then `(in <dir>/)` for a folder entry (design 04-gate-commands). */
const ranText = (w: Worker, r: CheckResult) => commandText(w.checkTools.ranEntry(r));

/** A failed check as the outcome says it: a missing test file's text with its command, else the command and how it failed. */
const failedText = (w: Worker, r: CheckResult) => (r.missing ? `${r.how} (\`${ranText(w, r)}\`)` : `\`${ranText(w, r)}\` ${r.how}`);

/** The architecture ratchet lists, and the env under which the pre-push checks lower (never raise) them (design §4). */
export const RATCHET_LISTS = "tests/architecture/known-violations/";
const SHRINK_ENV = { env: { SF_RATCHET_SHRINK: "1" } };

/** A failing test file the controller may grant on `checks_failed`, with the quoted strings of it that the branch diff removed. */
type GrantTest = { file: string; quotes: string[] };

/**
 * The failing test files the controller may grant once (design 04-pre-push-gates, 2026-11-25): every test file the
 * output names is outside allowed_paths, and each one's text at HEAD quotes a string (the triage pin rule) that a
 * removed line of the branch diff contains. undefined: no file named, one is covered or quotes nothing removed.
 */
async function grantTests(w: Worker, handle: SandboxHandle, baseSha: string, item: WorkItem, failed: CheckResult): Promise<GrantTest[] | undefined> {
  const files = failingTestFiles(failed.tail);
  if (files.length === 0 || files.some((f) => isCovered(f, item.allowed_paths))) return undefined;
  const diff = await w.gitRaw(handle, ["diff", "-U0", "--no-renames", `${baseSha}...HEAD`]);
  if (diff.exit_code !== 0) return undefined;
  const grants: GrantTest[] = [];
  for (const file of files) {
    const text = await w.gitRaw(handle, ["show", `HEAD:${file}`]);
    const quotes = text.exit_code === 0 ? removedPins(text.stdout, diff.stdout) : [];
    if (quotes.length === 0) return undefined;
    grants.push({ file, quotes });
  }
  return grants;
}

/** `checks_failed` (a task failure): one comment naming the command, keyed on the run; nothing is pushed. */
async function checksFailed(w: Worker, run: Run, item: WorkItem, first: CheckResult, second: CheckResult, done: DoneCheckResult[] | undefined, grant: GrantTest[] | undefined): Promise<never> {
  const cmd = ranText(w, second);
  const before = ranText(w, first);
  const body = [
    "## Factory pre-push checks: push blocked",
    "",
    `Before pushing, the implement run ran the checks (\`repo.check_commands\`). \`${before}\` failed (${first.how}); after one fix step, \`${cmd}\` failed (${second.how})${checkedLinesText(second)}.`,
    "",
    "Nothing was pushed to the change's branch. The run failed with `checks_failed`; the factory retries it from the kept commits until `max_attempts`.",
  ].join("\n");
  await w.comment(item, { pr: null, body, marker: `<!-- factory:checks:${run.id} -->` });
  // The failing tests by name (design §5 Restarts), so the detail says what broke, not only the exit code.
  const tests = failingTestNames(second.tail);
  const named = tests.length > 0 ? `; failing tests: ${tests.join(", ")}` : "";
  throw new RunFailure(CHECKS_FAILED_RUN, `${failedText(w, second)} after one fix step${checkedLinesText(second)} (before it: ${failedText(w, first)})${named}`.slice(0, 500), false, {
    output_tail: second.tail, ...(done ? { done_checks: done } : {}), // each done-when line's result, on the failed outcome
    ...(grant ? { grant_tests: grant } : {}), // the test files the controller may grant once (auto-grant.ts checksGrant)
  } as RunFailure["extra"]);
}

/**
 * `checks_env` (design §5 Restarts): one comment, keyed on the run, names the test files that fail on the base
 * too; a failed post is logged. Nothing is pushed. The controller requeues the run without spending an attempt
 * or a restart, at most CHECKS_ENV_LIMIT times per item.
 */
async function checksEnv(w: Worker, run: Run, item: WorkItem, failed: CheckResult, files: string[]): Promise<never> {
  const cmd = ranText(w, failed);
  const body = [
    "## Factory pre-push checks: failing on the base branch too",
    "",
    `Before pushing, the implement run ran the checks (\`repo.check_commands\`), and \`${cmd}\` failed (${failed.how}), also after one fix step. The failing test files fail the same way on a clean checkout of the base commit, so the factory reads them as flaky or broken on the base, not as a fault of this branch:`,
    "",
    ...files.map((f) => `- \`${f.replace(/`/g, "'")}\``),
    "",
    `Nothing was pushed to the change's branch. The run failed with \`${CHECKS_ENV}\`; the factory retries it from the kept commits without spending an attempt, at most ${CHECKS_ENV_LIMIT} times per item, then waits for a person.`,
  ].join("\n");
  await w.comment(item, { pr: null, body, marker: `<!-- factory:checks:${run.id} -->` });
  throw new RunFailure(CHECKS_ENV, `\`${cmd}\` ${failed.how} after one fix step, and on the base commit too; failing tests: ${files.join(", ")}`.slice(0, 500), false, {
    output_tail: failed.tail,
  });
}

/** The item's size caps: its one-time cap, else its project's settings (src/core/size-cap.ts). The worker's copy of `itemSizeCaps`: it reaches core/ only through legacy-imports.ts. */
export const itemCaps = async (w: Worker, item: WorkItem) => sizeCaps(await w.d.store.listStateChanges(item.id), settingValues(item.project, w.cfg.settings, w.d.learned));

/**
 * The gate hooks for an implement agent step (design §4, issue #302): the values the worker's gates use, the check list
 * with the check env (no test database), the Stop hook's cap with what earlier steps used, and the test selection.
 */
export async function gateHooks(w: Worker, run: Run, item: WorkItem, start: string, baseSha: string, mode: StopSelection["mode"]): Promise<GateHooks> {
  return {
    allowed_paths: [...item.allowed_paths], start_sha: start, base_sha: baseSha,
    limits: await itemCaps(w, item),
    check_commands: checkCommands(w.cfg.repo),
    check_env: { ...w.d.toolEnv, ...w.slotEnv() },
    stop_checks: w.cfg.agent_stop_checks ?? AGENT_STOP_CHECKS_DEFAULT,
    stop_blocks_used: w.scratch.get(run)?.stop_blocks ?? 0,
    ...(w.cfg.repo.test_selection ? { selection: { mode, test_command: [...w.cfg.repo.test_command], test_selection: w.cfg.repo.test_selection } } : {}),
  };
}

/**
 * Makes the working tree the committed branch before the checks: changes left uncommitted or untracked files
 * would be checked but not pushed. Ignored files (installed dependencies) stay. Hooks off.
 */
async function cleanTree(w: Worker, handle: SandboxHandle): Promise<void> {
  const status = await w.git(handle, ["status", "--porcelain", "-z", "--untracked-files=normal"]);
  if (status.replace(/\0/g, "").trim() === "") return;
  await w.git(handle, [...NO_HOOKS, "reset", "--quiet", "--hard", "HEAD"]);
  await w.git(handle, [...NO_HOOKS, "clean", "-fdq"]);
}

/** `git diff --quiet ...`: true when it reports a difference (exit 1), throws on any other failure. */
export async function differs(w: Worker, handle: SandboxHandle, args: string[]): Promise<boolean> {
  const r = await w.gitRaw(handle, args);
  if (r.exit_code === 0) return false;
  if (r.exit_code === 1) return true;
  throw new RunFailure("git_failed", `git ${args.join(" ")}: ${r.stderr.trim()}`, true);
}

export async function unmerged(w: Worker, handle: SandboxHandle): Promise<string[]> {
  return (await w.git(handle, ["diff", "--name-only", "-z", "--diff-filter=U"])).split("\0").filter(Boolean);
}

/**
 * The pre-push step (design §4): runs before any handoff row and before every push, on the cumulative
 * branch diff against the merged-in base SHA from syncBase (three-dot, so files only base changed are left out). In order:
 * scope gate (fails `scope_violation`), size gate (fails `diff_too_large`), floor check (returns the floor
 * paths above the item's tier, for the controller to block on; null means the branch may be pushed). Gates, not dials: no config turns them off.
 */
export async function prePushGates(
  w: Worker,
  run: Run,
  item: WorkItem,
  handle: SandboxHandle,
  baseSha: string,
  conflicts: readonly string[] = [],
): Promise<{ floor: FloorHit[] | null; paths: string[] }> {
  await scopeGateStep(w, run, item, handle, baseSha, conflicts);
  // The item's project's gate settings (design 2026-11-01), read only through settingValues, with its size caps. The
  // gates themselves are src/core/pre-push.ts, shared with `session finish` (design §5, 2026-11-01).
  const s = settingValues(item.project, w.cfg.settings, w.d.learned);
  let gates;
  try {
    gates = await diffGates((args) => w.git(handle, args), baseSha, item, { ...s, ...(await itemCaps(w, item)) });
  } catch (err) {
    if (err instanceof NumstatError) throw new RunFailure("git_failed", err.message, true);
    throw err;
  }
  if (gates.size !== null) throw new RunFailure("diff_too_large", gates.size);
  return { floor: gates.floor, paths: gates.paths };
}

/**
 * Scope gate: the files the branch changes against allowed_paths, with the same coverage rule as triage.
 * A file the base merge conflicted in (both sides changed it) passes (decision changed 2026-11-02).
 */
async function scopeGateStep(
  w: Worker,
  run: Run,
  item: WorkItem,
  handle: SandboxHandle,
  baseSha: string,
  conflicts: readonly string[],
) {
  const outside = await scopeGate((args) => w.git(handle, args), baseSha, item.allowed_paths, conflicts);
  if (outside.length === 0) return;
  const body = [
    "## Factory scope check: push blocked",
    "",
    "The implementer changed files outside the approved allowed paths, so the branch was not pushed:",
    "",
    ...outside.map((p) => `- \`${p}\``),
    "",
    ...scopeReply(outside),
  ].join("\n");
  await w.comment(item, { pr: null, body, marker: `<!-- factory:scope:${run.id} -->` });
  throw new RunFailure("scope_violation", `files outside allowed_paths: ${outside.join(", ")}`.slice(0, 500));
}
