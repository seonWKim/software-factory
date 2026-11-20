// The restart run (design 04-gate-commands, restart): runs `repo.restart_command` in the repo's base checkout
// (`repo.path`), on the host and outside any sandbox (WorkerDeps.host_exec), so the owner's command stops and starts
// their app on the merged code. No agent, no run folder, no shell: the argv as configured, with the worker's tool env
// (no credential, no slot env) and under `run_timeout_ms`. A command that exits non-zero, times out or cannot start
// is a result (`failed`, `not_started`), not a run failure: the controller posts it in the item's thread (core
// restartReply says how it ended) and changes no item state. The output tail passes the egress scan here; a flagged
// tail is withheld whole.

import { RunFailure, tail } from "../../support.js";
import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, type RunCall, defineRunKind } from "../../run-kind.js";

/** The longest reason kept for a command that could not start. */
const START_ERROR_CHARS = 300;

async function restart(w: Worker, c: RunCall): Promise<Record<string, unknown>> {
  const command = w.cfg.repo.restart_command;
  // Removed from the config after the request was queued: nothing runs.
  if (command === undefined) return { result: "not_set", command: null };
  const exec = w.d.host_exec;
  if (!exec) throw new RunFailure("no_host_exec", "this worker cannot run a command on the host");
  return c.step("run-restart-command", async () => {
    let r;
    try {
      r = await exec(command, { cwd: w.cfg.repo.path, env: { ...w.d.toolEnv }, timeout_ms: w.cfg.run_timeout_ms, signal: c.signal });
    } catch (err) {
      return { result: "not_started", command, start_error: (err instanceof Error ? err.message : "unknown").slice(0, START_ERROR_CHARS) };
    }
    if (c.signal.aborted && !r.timed_out) throw new RunFailure("lease_lost", "run aborted", true);
    const text = tail(`${r.stdout}${r.stderr}`);
    const clean = text === "" || (await w.d.scanner.scan("run_outcome", text)).clean;
    return {
      result: r.exit_code === 0 && !r.timed_out ? "ok" : "failed", command, exit_code: r.exit_code, signal: r.signal, timed_out: r.timed_out,
      output_tail: clean ? text : null, ...(clean ? {} : { output_withheld: true }),
    };
  });
}

export default defineRunKind({
  name: "restart",
  folder: false,
  timeouts: DEFAULT_TIMEOUTS,
  execute: restart,
});
