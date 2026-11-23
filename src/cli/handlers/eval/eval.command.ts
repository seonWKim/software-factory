// `factory eval run <skill>`, `factory eval results <skill>` and `factory eval compare <run-a> <run-b>` (design
// 06-measurement, skill evals). The run itself is the root wiring (src/skill-evals.ts) and the grid and compare are
// src/core/skill-eval-compare.ts, both passed in by main.ts through the command call (runSkillEval, skillEvalReads),
// so this handler imports no root or legacy module. <skill> is a suite's skill_ref: a skill folder.

import { type CommandContext, type SkillEvalReads, type SkillEvalRunOptions, type SkillEvalRunRow, type SkillEvalRunSummary, defineCommand } from "../../command.js";
import { stopOnSignals } from "../../support.js";

const USAGE = `  eval run <skill> [--model <class>] [--judge-model <class>] [--replays 1]
               runs the skill's eval suite once (one replay per case, then the judge; model calls) and stores
               the run with its skill version, model class, judge model class, replays, pass rate and errored
               count; exit 0 when the run passed. --model: cheap, standard or strong (default standard);
               --judge-model: only the judge class of --model; --replays: only 1 (one verdict per case).
               Refuses, running nothing, when no suite exists for <skill> or an option is refused
  eval results <skill> [--by version,model] [--json]
               lists the skill's stored runs, newest first (--json: one JSON array, the same fields as
               GET /api/v1/evals/<skill>/runs); --by version,model: one row per skill version and model
               class from its newest run, runs with no figures left out (GET /api/v1/evals/<skill>/grid)
  eval compare <run-a> <run-b> [--json]
               both runs' pass rates, the gap (b − a), the noise band 2 × sqrt(sd_a² + sd_b²) with
               sd = sqrt(p × (1 − p) ÷ replays), and whether the gap is within it; no comparison without two
               pass rates (--json: the same fields as GET /api/v1/evals/<skill>/compare?a=<run-a>&b=<run-b>)`;

const orDash = (v: string | number | null) => (v === null ? "-" : String(v));
const rate = (v: number | null) => (v === null ? "-" : v.toFixed(2));

/** One run as one line: when, id, status and figures (a dash for a figure not recorded). */
function runLine(r: SkillEvalRunRow): string {
  return `${r.started_at}  ${r.id}  ${r.status}  replays ${orDash(r.replays)}, pass rate ${rate(r.pass_rate)}, errored ${orDash(r.errored)}`
    + `  (model ${orDash(r.model_class)}, judge ${orDash(r.judge_model_class)}, skill version ${orDash(r.skill_version)})`;
}

/** One grid row or compared run as one line. */
const summaryLine = (r: SkillEvalRunSummary) =>
  `skill version ${orDash(r.skill_version)}  model ${orDash(r.model_class)}  pass rate ${rate(r.pass_rate)}  replays ${orDash(r.replays)}  (run ${r.run_id}, ${r.started_at})`;

/** The words and flags after the subcommand: positionals, value flags and --json; null on an unknown or valueless flag. */
function parseArgs(args: readonly string[], valued: readonly string[]): { words: string[]; values: Map<string, string>; json: boolean } | null {
  const words: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") json = true;
    else if (valued.includes(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith("-") || values.has(a)) return null;
      values.set(a, v);
    } else if (a.startsWith("-")) return null;
    else words.push(a);
  }
  return { words, values, json };
}

/** --model, --judge-model and --replays as the run function takes them; null on a --replays that is no whole number. */
function runOptions(values: Map<string, string>): SkillEvalRunOptions | null {
  const o: SkillEvalRunOptions = {};
  const model = values.get("--model"), judge = values.get("--judge-model"), replays = values.get("--replays");
  if (model !== undefined) o.model_class = model;
  if (judge !== undefined) o.judge_model_class = judge;
  if (replays !== undefined) {
    if (!/^[1-9]\d*$/.test(replays)) return null;
    o.replays = Number(replays);
  }
  return o;
}

const VALUED: Record<string, readonly string[]> = { run: ["--model", "--judge-model", "--replays"], results: ["--by"], compare: [] };

export default defineCommand({
  names: ["eval"],
  usage: USAGE,
  async run(argv, ctx) {
    const [sub, ...rest] = argv;
    const parsed = sub !== undefined && Object.hasOwn(VALUED, sub) ? parseArgs(rest, VALUED[sub]!) : null;
    const usage = () => (console.error(`usage:\n${USAGE}`), 1);
    if (!parsed || parsed.words.length !== (sub === "compare" ? 2 : 1) || (sub === "run" && parsed.json)) return usage();
    const { words, values, json } = parsed;
    const reads = ctx.skillEvalReads;
    if (sub === "compare") {
      if (!reads) return (console.error("eval compare is not available here: run it as `factory eval compare <run-a> <run-b>`"), 1);
      return compare(ctx, reads, words[0]!, words[1]!, json);
    }
    const skill = words[0]!;
    if (sub === "results") {
      const by = values.get("--by");
      if (by !== undefined && by !== "version,model") return usage();
      const grid = by === undefined ? null : reads?.grid;
      if (grid === undefined) return (console.error("eval results --by is not available here: run it as `factory eval results <skill> --by version,model`"), 1);
      const runs = await ctx.withStore((store) => store.listSkillEvalRuns(skill));
      if (grid) {
        const rows = grid(runs);
        if (json) console.log(JSON.stringify(rows, null, 2));
        else if (rows.length === 0) console.log(`no eval runs with figures for ${skill}`);
        else for (const r of rows) console.log(summaryLine(r));
        return 0;
      }
      if (json) console.log(JSON.stringify(runs, null, 2));
      else if (runs.length === 0) console.log(`no eval runs for ${skill}`);
      else for (const r of runs) console.log(runLine(r));
      return 0;
    }
    const options = runOptions(values);
    if (!options) return usage();
    const runSkillEval = ctx.runSkillEval;
    if (!runSkillEval) {
      console.error("eval run is not available here: run it as `factory eval run <skill>`");
      return 1;
    }
    const { user } = await ctx.identity();
    const result = await ctx.withStore((store, loaded) => runSkillEval(store, loaded, { skill, created_by: user, signal: stopOnSignals(), ...options }));
    if ("refused" in result) {
      console.error(result.refused);
      return 1;
    }
    console.log(runLine(result.run));
    return result.run.status === "passed" ? 0 : 1;
  },
});

/** `eval compare <run-a> <run-b>`: both runs read by id; exit 1 when either is unknown. Reads only. */
async function compare(ctx: Pick<CommandContext, "withStore">, reads: SkillEvalReads, a: string, b: string, json: boolean): Promise<number> {
  const [ra, rb] = await ctx.withStore((store) => Promise.all([store.getSkillEvalRun(a), store.getSkillEvalRun(b)]));
  const missing = [ra ? null : a, rb ? null : b].filter((x) => x !== null);
  if (!ra || !rb) return (console.error(`no eval run ${missing.join(", ")}: nothing compared`), 1);
  const c = reads.compare(ra, rb);
  if (json) {
    console.log(JSON.stringify(c, null, 2));
    return 0;
  }
  console.log(`a  ${summaryLine(c.a)}`);
  console.log(`b  ${summaryLine(c.b)}`);
  if (c.gap === null || c.noise_band === null) console.log("no comparison: both runs need a pass rate");
  else console.log(`gap ${c.gap >= 0 ? "+" : ""}${c.gap.toFixed(2)}, noise band ${c.noise_band.toFixed(2)}: ${c.within_noise ? "within noise" : "beyond noise"}`);
  return 0;
}
