import { RunFailure, STOPPED_CODES, tail } from "../../support.js";
import type { Worker } from "../../runner.js";

type Agent = Parameters<Worker["agent"]>;
/** The first turn's agent spec without its prompt: model, output schema, writable paths, environment and gate hooks. */
type Turn = Omit<Agent[4], "prompt">;
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The wip ref's next steps of a run whose answer stayed invalid after its repair turn. */
export const INVALID_NEXT_STEPS =
  "the final answer did not match the output schema, also after a repair turn: continue from the wip head and give the final answer";

/** Keeps the run's commits on its wip branch marked `continue` (the implement run's `keepStopped`); returns the failure to throw. */
export type KeepWork = (failure: RunFailure, next_steps?: string) => Promise<RunFailure>;

/** The repair turn's prompt: the final answer only, in the required shape, and no further work. */
export function repairPrompt(error: string): string {
  return [
    "## Your final answer did not match the required format",
    `The factory could not read it (${error.slice(0, 200)}).`,
    "Do not change, commit or run anything more. Give only your final answer again, in the required format, with `summary` and `next_steps` filled in (or `needs_human` or `spec_conflict` if you meant that).",
  ].join("\n\n");
}

/**
 * The implement agent step's answer (design §5 Restarts, the repair turn). A valid answer is returned as it is. An
 * invalid one gets one repair turn: when the step's session is stored and the runner still has it, the agent is asked
 * once more in that session, with the first turn's spec (`turn`) and a prompt asking for the answer only. A valid
 * repair answer is returned as if it were the first. Still invalid, or no session to resume: the run fails with
 * `invalid_output`, its commits since the start kept on the run's wip branch with `continue` through `keep` (no
 * commits: nothing is kept). A usage limit, a stall or a timeout during the repair turn keeps the work as any stopped run.
 */
export async function repairedAnswer<T>(
  w: Worker, run: Agent[0], item: Agent[1], handle: Agent[2], signal: AbortSignal, turn: Turn,
  parse: (output: unknown) => Parsed<T>, first: Awaited<ReturnType<Worker["agent"]>>, keep: KeepWork,
): Promise<{ ok: true; value: T }> {
  const out = parse(first.output);
  if (out.ok) return out;
  const session = w.scratch.get(run)?.step_session;
  const stored = session ? await w.d.runner.hasSession?.(session).catch(() => false) : false;
  let last = first;
  let error = out.error;
  if (session && stored) {
    last = await w.agent(run, item, handle, signal, { ...turn, prompt: repairPrompt(out.error) }, "repair", { resume: session })
      .catch(async (err: unknown) => {
        throw err instanceof RunFailure && STOPPED_CODES.includes(err.code) && !signal.aborted ? await keep(err) : err;
      });
    const repaired = parse(last.output);
    if (repaired.ok) return repaired;
    error = repaired.error;
  }
  throw await keep(new RunFailure("invalid_output", error, false, { output_tail: tail(last.transcript) }), INVALID_NEXT_STEPS);
}
