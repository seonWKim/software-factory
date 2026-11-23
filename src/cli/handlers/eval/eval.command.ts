// `factory eval run <skill>` and `factory eval results <skill> [--json]` (design 06-measurement, skill evals). The run
// itself is the root wiring (src/skill-evals.ts), passed in by main.ts through the command call (runSkillEval), so
// this handler imports no root or legacy module. <skill> is a suite's skill_ref: a skill folder.

import { type SkillEvalRunRow, defineCommand } from "../../command.js";
import { stopOnSignals } from "../../support.js";

const USAGE = `  eval run <skill>             runs the skill's eval suite once (one replay per case, then the judge; model calls)
               and stores the run with its skill version, model class, judge model class, replays, pass
               rate and errored count; exit 0 when the run passed. Refuses when no suite exists for <skill>
  eval results <skill> [--json]
               lists the skill's stored runs, newest first (--json: one JSON array, the same fields as
               GET /api/v1/evals/<skill>/runs)`;

const orDash = (v: string | number | null) => (v === null ? "-" : String(v));

/** One run as one line: when, id, status and figures (a dash for a figure not recorded). */
function runLine(r: SkillEvalRunRow): string {
  const rate = r.pass_rate === null ? "-" : r.pass_rate.toFixed(2);
  return `${r.started_at}  ${r.id}  ${r.status}  replays ${orDash(r.replays)}, pass rate ${rate}, errored ${orDash(r.errored)}`
    + `  (model ${orDash(r.model_class)}, judge ${orDash(r.judge_model_class)}, skill version ${orDash(r.skill_version)})`;
}

export default defineCommand({
  names: ["eval"],
  usage: USAGE,
  async run(argv, ctx) {
    const [sub, skill, ...rest] = argv;
    const json = rest.includes("--json");
    const extra = rest.filter((a) => a !== "--json");
    if ((sub !== "run" && sub !== "results") || !skill || skill.startsWith("-") || extra.length > 0 || (sub === "run" && json)) {
      console.error(`usage:\n${USAGE}`);
      return 1;
    }
    if (sub === "results") {
      const runs = await ctx.withStore((store) => store.listSkillEvalRuns(skill));
      if (json) console.log(JSON.stringify(runs, null, 2));
      else if (runs.length === 0) console.log(`no eval runs for ${skill}`);
      else for (const r of runs) console.log(runLine(r));
      return 0;
    }
    const runSkillEval = ctx.runSkillEval;
    if (!runSkillEval) {
      console.error("eval run is not available here: run it as `factory eval run <skill>`");
      return 1;
    }
    const { user } = await ctx.identity();
    const result = await ctx.withStore((store, loaded) => runSkillEval(store, loaded, { skill, created_by: user, signal: stopOnSignals() }));
    if ("refused" in result) {
      console.error(result.refused);
      return 1;
    }
    console.log(runLine(result.run));
    return result.run.status === "passed" ? 0 : 1;
  },
});
