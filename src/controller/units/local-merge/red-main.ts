// Red main after an automatic merge (design 03-risk): the checks on the new base tip, the last green base they store,
// and the revert of a bad automatic merge. Kept out of local-merge.unit.ts, which may not grow (file budget); its I/O
// (the sandbox, the green bases table) is inline, as the unit's.

import { LOCAL_SOURCE, canRevertLocal, checkCommands, runChecks, runKey, toolchainMissing } from "../../../core/local-merge.js";
import { failingTestNames } from "../../../worker/index.js";
import { AUTO, SYSTEM } from "../support.js";
import type { Ctx } from "../context.js";
import { GreenBaseStore } from "./green-base.js";
import type { LocalMergeUnit } from "./local-merge.unit.js";

type WorkItem = NonNullable<Awaited<ReturnType<LocalMergeUnit["item"]>>>;

/** What the red-main check's failing command printed: the failing tests by name (at most 10) and its tail (at most 2000 characters). */
export interface RedMainOutput {
  failing_tests: string[];
  output_tail: string;
}

/** Only an automatic merge this recent is reverted (design 03-risk): older ones take the stop. */
const REVERT_WINDOW_MS = 3_600_000;
/** The loop reason of a reopen after a revert: the merge check's, so it counts and is shown as that loop is. */
const MERGE_CHECK_FAILED = "merge_check_failed";
/** The error code of the red_main alert for a check the host could not run (design 03-risk): the run failure class's word. */
const CHECKS_ENV = "checks_env";
/**
 * One environment alert per tip in this window, the alarms' 6 hours (core/alarms.ts, ALERT_DEDUPE_MS): re-exporting it
 * through core/local-merge.js makes an import cycle, and importing core/alarms.js here adds a legacy import.
 */
const ENV_ALERT_DEDUPE_MS = 6 * 3_600_000;

/** One round of checks on the base tip: the tip checked, and what failed (null: all passed). */
interface Round {
  tip: string | null;
  failed: string | null;
  /** The failing command and how it failed; null when the checks could not run at all. */
  command: string | null;
  how: string | null;
  output?: RedMainOutput;
  /**
   * Why the failure is the host's, not the merge's (design 03-risk): the output line that shows a missing toolchain
   * (`toolchainMissing`), or the command's "could not run: …"; absent for a plain failure.
   */
  env?: { tool: string | null; line: string };
}

function greenBases(c: Ctx): GreenBaseStore | null {
  const db = c.k.db;
  return db ? new GreenBaseStore(db, () => new Date(c.k.nowMs()).toISOString()) : null;
}

/**
 * The install step (`repo.install_commands`, else `repo.install_command`), the checks and the UI check (`repo.ui_check`)
 * on the base tip in a fresh detached checkout, each entry in its folder (design 04-gate-commands), through the merge
 * check's runner (`runChecks`: its tail, at most CHECK_TAIL_CHARS). `where` names the tip in the text.
 */
async function checkTip(c: Ctx, where: string): Promise<Round> {
  const sandbox = c.k.d.sandbox!;
  const { repo } = c.k.cfg;
  let tip: string | null = null;
  try {
    const handle = await sandbox.create({ repo: repo.path, branch: null, base_ref: repo.base_branch });
    tip = handle.base_sha ?? null;
    try {
      const round = await runChecks({
        sandbox, handle, commands: [...(repo.install_commands ?? [repo.install_command]), ...checkCommands(repo), ...(repo.ui_check ? [repo.ui_check.command] : [])],
        env: { ...c.k.d.check_env }, timeout_ms: c.k.cfg.run_timeout_ms, signal: new AbortController().signal, redact: [],
      });
      if (!round.failed) return { tip, failed: null, command: null, how: null };
      // Named as core/checks.ts commandText names a folder entry; this unit reaches core only through core/local-merge.js.
      const { dir } = round.failed;
      const command = `${round.failed.command.join(" ")}${dir === undefined ? "" : ` (in ${dir}/)`}`;
      const missing = toolchainMissing(round.failed.tail);
      const env = round.failed.how.startsWith("could not run") ? { tool: null, line: round.failed.how } : missing !== null ? { tool: toolOf(missing), line: missing } : undefined;
      return {
        tip, command, how: round.failed.how, failed: `\`${command}\` ${round.failed.how} on ${where} of \`${repo.base_branch}\``,
        output: { failing_tests: failingTestNames(round.failed.tail), output_tail: round.failed.tail }, ...(env ? { env } : {}),
      };
    } finally {
      await sandbox.destroy(handle);
    }
  } catch (err) {
    const why = err instanceof Error ? err.message.slice(0, 200) : "unknown error";
    return { tip, failed: `the checks could not run on ${where} of \`${repo.base_branch}\`: ${why}`, command: null, how: null };
  }
}

/** The tool a `toolchainMissing` line shows missing, in the alert's words; null when the line names none of them. */
function toolOf(line: string): string | null {
  if (line.includes("JAVA_HOME") || line.includes("java")) return "the JDK";
  if (line.includes("gradle")) return "Gradle";
  if (line.includes("node_modules") || ["tsc", "vitest", "npx", "node"].some((t) => line.includes(t))) return "the Node tools";
  return null;
}

/**
 * A check on the base tip that failed because of the host (design 03-risk): its tools are missing, or its command
 * could not run. Not the merge's fault and not a red main: nothing is reverted or reopened, no fix item is filed and
 * auto mode goes on; one `red_main` alert with error code `checks_env` on the tip names the missing tool or the
 * command. Safe to run twice: the alert's conditional insert stores it once.
 */
async function environment(c: Ctx, tip: string | null, r: Round): Promise<void> {
  const what = r.env!.tool === null ? `\`${r.command}\` ${r.how}` : `\`${r.command}\` could not start its tools: ${r.env!.tool} is missing (\`${r.env!.line}\`)`;
  const text = `${what} on the new tip of \`${c.k.cfg.repo.base_branch}\`. This is a problem with the host, not a red main: the merge is kept, nothing is reverted or reopened.`;
  c.k.d.log.warn("red main: the checks could not run on the host; merge kept", { base_sha: tip, command: r.command });
  if (tip === null) return;
  // G5: the alert reaches the status page, so its text is scanned as UI text first.
  const clean = (await c.k.reader.scan("ui", text)).clean;
  await c.k.commit({ writes: [{
    kind: "alert", dedupe_ms: ENV_ALERT_DEDUPE_MS,
    alert: { pattern: "red_main", pattern_key: `red_main:${tip}:${CHECKS_ENV}`, error_code: CHECKS_ENV, count: 1, detail: clean ? text : null },
  }] });
}

/**
 * Red main (design 03-risk): after an automatic merge, the checks run again on the new base tip. A pass stores that
 * tip as the project's green base. A check the host could not run (`environment`) is not red main. A failure of a check reverts the merge when it may (`revert`), and the checks run
 * again on the reverted tip: green raises the `red_main` alert with a note that the merge was reverted, files no fix
 * item and keeps auto mode; still red, or no revert, is today's red main (`redMain`: its alert, its fix item, auto
 * mode set back to manual). The revert is never undone. Safe to run twice: a repeat finds the merge reverted or the
 * item reopened, so it changes nothing.
 */
export async function redMainCheck(c: Ctx, it: WorkItem): Promise<void> {
  if (!c.k.d.sandbox) return;
  const lm = c.unit("local-merge");
  const first = await checkTip(c, "the new tip");
  if (first.failed === null) {
    if (first.tip !== null) await greenBases(c)?.set(it.project, first.tip);
    return;
  }
  if (first.env) return environment(c, first.tip ?? (await lm.baseTip()), first);
  const merge = first.command !== null ? await revertable(c, it, first.tip) : null;
  const done = merge ? await revert(c, merge.item, merge.parent) : null;
  if (!merge || !done) return lm.redMain(it.project, first.tip ?? (await lm.baseTip()), first.failed, first.output);
  const again = await checkTip(c, "the reverted tip");
  if (again.failed === null && again.tip !== null) await greenBases(c)?.set(it.project, again.tip);
  await reopen(c, merge.item, done.sha, first);
  const reverted = `the factory reverted the merge of ${it.id} (\`${merge.item.merge_sha}\`) as \`${done.sha}\``;
  if (again.failed === null) return lm.redMain(it.project, first.tip, `${first.failed}; ${reverted}, and the checks pass on it`, first.output, done.sha);
  await lm.redMain(it.project, again.tip ?? done.sha, `${again.failed}; ${reverted} after \`${first.command}\` ${first.how} on the merge`, again.output);
}

/**
 * The automatic merge the failing `tip` is, with the green base before it, when it may be reverted: a local item closed
 * by its merge at `tip`, merged by `system:auto` within REVERT_WINDOW_MS, onto the base stored green. Null otherwise: a
 * merge by a person, an older one, a tip that moved past it, or a base not stored green (already red, or no check has
 * passed since the table exists) is not blamed on the merge.
 */
async function revertable(c: Ctx, it: WorkItem, tip: string | null): Promise<{ item: WorkItem; parent: string } | null> {
  const store = greenBases(c);
  if (!store || tip === null || !canRevertLocal(c.k.d.sandbox)) return null;
  const cur = await c.unit("local-merge").item(it.id);
  if (!cur || cur.source.type !== LOCAL_SOURCE || cur.stage !== "CLOSED" || cur.close_reason !== "completed" || cur.merge_sha !== tip) return null;
  const merged = (await c.k.reader.listStateChanges(cur.id)).filter((s) => s.reason === "local_merged").at(-1);
  if (!merged || merged.actor.kind !== "system" || merged.actor.id !== AUTO.id) return null;
  if (c.k.nowMs() - Date.parse(merged.at) > REVERT_WINDOW_MS) return null;
  const parent = await store.get(cur.project);
  return parent === null ? null : { item: cur, parent };
}

/**
 * Reverts `item`'s merge on the local base (`revertLocal`), conditionally on the base at the merge and the merge's
 * first parent at `parent`; the item's branch gets the change back on top of the revert. The revert commit says `This
 * reverts commit <merge_sha>`, so the revert tracking records it on the item as any revert (`recordReverts`), before
 * the reopen clears its merge. Null when nothing was reverted (the merge's parent is not the green base, the base moved).
 */
async function revert(c: Ctx, item: WorkItem, parent: string): Promise<{ sha: string } | null> {
  const sandbox = c.k.d.sandbox;
  if (!canRevertLocal(sandbox) || item.merge_sha === null) return null;
  const { repo, agent_git_identity } = c.k.cfg;
  const r = await sandbox.revertLocal({
    repo: repo.path, base_ref: repo.base_branch, merge_sha: item.merge_sha, parent, branch: c.unit("local-merge").branchOf(item), identity: agent_git_identity,
  });
  if (!r.reverted) {
    c.k.d.log.info("red main: merge not reverted", { work_item_id: item.id, reason: r.refused });
    return null;
  }
  c.k.d.log.info("red main: merge reverted", { work_item_id: item.id, merge_sha: item.merge_sha, revert_sha: r.sha, branch_reapplied: r.branch_reapplied });
  await c.k.guard("revert verdict", () => c.unit("verdicts").recordReverts({ kind: "base_commit", sha: r.sha, message: `This reverts commit ${item.merge_sha}.` }));
  return { sha: r.sha };
}

/**
 * The reverted item goes back to implement as a loop, as a failed merge check sends it (`merge_check_failed`: stage
 * RUNNING, loop_count + 1, the implement run keyed by the new loop, the failing command, tests and tail in the
 * detail), or at `max_loops` waits in REVIEW on a person. Its close and merge are cleared. Conditional on the item
 * still closed by that merge, so a repeat or another replica adds no loop.
 */
async function reopen(c: Ctx, item: WorkItem, revert_sha: string, failed: Round): Promise<void> {
  const limit = c.k.cfg.max_loops;
  const merge_sha = item.merge_sha;
  // G5: the detail reaches the status page, so the tail is scanned as run outcome text first, as the merge check's is.
  const raw = failed.output?.output_tail ?? "";
  const tail = raw !== "" && (await c.k.reader.scan("run_outcome", raw)).clean ? raw : null;
  await c.unit("transitions").decide(item.id, (it) => {
    if (it.stage !== "CLOSED" || it.merge_sha === null || it.merge_sha !== merge_sha) return null;
    const loop = it.loop_count + 1;
    const detail = {
      reverted: true, merge_sha, revert_sha, command: failed.command, how: failed.how,
      failing_tests: JSON.stringify(failed.output?.failing_tests ?? []), output_tail: tail,
    };
    const open = { close_reason: null, merge_sha: null };
    if (loop >= limit) return { patch: { ...open, stage: "REVIEW", blocked_on: "human", blocked_reason: "max_loops" }, actor: SYSTEM, reason: "max_loops", detail };
    return {
      patch: { ...open, stage: "RUNNING", blocked_on: "none", blocked_reason: null, loop_count: loop },
      actor: SYSTEM, reason: MERGE_CHECK_FAILED, detail,
      enqueue: { kind: "implement", idempotency_key: runKey({ ...it, loop_count: loop }, "implement") },
    };
  });
}
