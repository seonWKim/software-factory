// `factory eval run|results|suite|case` (design 06-measurement, skill evals). Suites and cases are written through
// the authoring rules (src/runtime/skill-evals/authoring.ts); `case try` is the call's trySkillEvalCase. The run
// itself is the root wiring (src/skill-evals.ts), passed in by main.ts through the command call (runSkillEval), so
// this handler imports no root or legacy module. <skill> is a suite's skill_ref: a skill folder.

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { type CommandContext, type SkillEvalRunRow, defineCommand } from "../../command.js";
import { stopOnSignals } from "../../support.js";

const USAGE = `  eval run <skill>             runs the skill's eval suite once (one replay per case, then the judge; model calls)
               and stores the run with its skill version, model class, judge model class, replays, pass
               rate and errored count; exit 0 when the run passed. Refuses when no suite exists for <skill>
  eval results <skill> [--json]
               lists the skill's stored runs, newest first (--json: one JSON array, the same fields as
               GET /api/v1/evals/<skill>/runs)
  eval suite list|add|rename|delete
               suite list prints each suite's skill and title; suite add <skill> [--title <title>] makes the
               skill's one suite (title defaults to the skill); suite rename <skill> <title>; suite delete
               <skill> refuses while a run of it is running, else says how many runs keep their history, then
               deletes the suite and its cases (its runs stay in the store, unlisted)
  eval case list|add|edit|delete|try
               case list <skill>; case add <skill> (--file <json> | --input <text> --check <text> ...) where the
               json is {"input": ..., "expected": [check texts]}; case edit <case-id> takes the same, a field
               not given keeps its value; case delete <case-id>; case try <case-id> [--model cheap|standard|strong]
               replays and judges one case (default standard), prints each check as yes or no with its reason,
               then "verdict: pass|fail|errored" (exit 0 on pass), and stores no run and no replay`;

const orDash = (v: string | number | null) => (v === null ? "-" : String(v));

/** One run as one line: when, id, status and figures (a dash for a figure not recorded). */
function runLine(r: SkillEvalRunRow): string {
  const rate = r.pass_rate === null ? "-" : r.pass_rate.toFixed(2);
  return `${r.started_at}  ${r.id}  ${r.status}  replays ${orDash(r.replays)}, pass rate ${rate}, errored ${orDash(r.errored)}`
    + `  (model ${orDash(r.model_class)}, judge ${orDash(r.judge_model_class)}, skill version ${orDash(r.skill_version)})`;
}

/** One refused change on stderr, or the change's value for `show`; the exit code. */
function report<T>(r: { value: T } | { refused: string }, show: (v: T) => void): number {
  if ("refused" in r) {
    console.error(r.refused);
    return 1;
  }
  show(r.value);
  return 0;
}

/** A case's fields from `--file` (a JSON object with `input` and/or `expected`) or from `--input` and `--check` flags. */
async function caseFields(v: { file?: string; input?: string; check?: string[] }): Promise<{ input?: unknown; expected?: unknown }> {
  if (v.file !== undefined) {
    if (v.input !== undefined || v.check !== undefined) throw new Error("--file cannot be combined with --input or --check");
    const parsed: unknown = JSON.parse(await readFile(v.file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("--file must hold a JSON object");
    const { input, expected } = parsed as { input?: unknown; expected?: unknown };
    return { input, expected };
  }
  return { ...(v.input !== undefined ? { input: v.input } : {}), ...(v.check !== undefined ? { expected: v.check } : {}) };
}

async function suiteCommand(argv: readonly string[], ctx: CommandContext, authoring: NonNullable<CommandContext["authoring"]>): Promise<number | null> {
  const { values, positionals: [sub, skill, title, ...extra] } = parseArgs({ args: [...argv], allowPositionals: true, options: { title: { type: "string" } } });
  const bad = !skill && sub !== "list" ? true : extra.length > 0 || (sub !== "add" && values.title !== undefined) || (sub === "rename" ? !title : title !== undefined && sub !== "rename");
  if (bad || !["list", "add", "rename", "delete"].includes(sub ?? "") || (sub === "list" && skill)) return null;
  const { user } = await ctx.identity();
  return ctx.withStore(async (store) => {
    if (sub === "list") {
      const suites = await store.listSkillEvalSuites();
      if (suites.length === 0) console.log("no eval suites");
      for (const s of suites) console.log(`${s.skill_ref}  ${s.title}`);
      return 0;
    }
    if (sub === "add") return report(await authoring.addSuite(store, { skill: skill!, ...(values.title !== undefined ? { title: values.title } : {}), created_by: user }), (s) => console.log(`added suite ${s.skill_ref}  ${s.title}`));
    if (sub === "rename") return report(await authoring.renameSuite(store, skill!, title!), (s) => console.log(`renamed suite ${s.skill_ref}  ${s.title}`));
    return report(await authoring.deleteSuite(store, skill!, (n) => console.log(`${n} run${n === 1 ? "" : "s"} keep their history in the store, unlisted`)), () => console.log(`deleted suite ${skill}`));
  });
}

async function caseCommand(argv: readonly string[], ctx: CommandContext, authoring: NonNullable<CommandContext["authoring"]>): Promise<number | null> {
  const { values, positionals: [sub, target, ...extra] } = parseArgs({
    args: [...argv], allowPositionals: true, options: { file: { type: "string" }, input: { type: "string" }, check: { type: "string", multiple: true }, model: { type: "string" } },
  });
  const writes = sub === "add" || sub === "edit";
  const modelOk = values.model === undefined || sub === "try";
  const flagsOk = writes || (values.file === undefined && values.input === undefined && values.check === undefined);
  if (!["list", "add", "edit", "delete", "try"].includes(sub ?? "") || !target || extra.length > 0 || !modelOk || !flagsOk) return null;
  if (sub === "try") {
    const tryCase = ctx.trySkillEvalCase;
    if (!tryCase) {
      console.error("eval case try is not available here: run it as `factory eval case try <case-id>`");
      return 1;
    }
    const model_class = values.model ?? "standard";
    const r = await ctx.withStore((store, loaded) => tryCase(store, loaded, { case_id: target, model_class, signal: stopOnSignals() }));
    if ("refused" in r) {
      console.error(r.refused);
      return 1;
    }
    for (const c of r.value.checks) console.log(`${c.answer}  ${c.check}  ${c.reason}`);
    if (r.value.error) console.log(`error: ${r.value.error}`);
    console.log(`verdict: ${r.value.verdict}`);
    return r.value.verdict === "pass" ? 0 : 1;
  }
  const fields = writes ? await caseFields(values) : {};
  return ctx.withStore(async (store) => {
    if (sub === "list") {
      const suite = (await store.listSkillEvalSuites()).find((s) => s.skill_ref === target);
      if (!suite) return report({ refused: `no skill eval suite for ${target}` }, () => {});
      const cases = await store.listSkillEvalCases(suite.id);
      if (cases.length === 0) console.log(`no eval cases for ${target}`);
      for (const c of cases) console.log(`${c.id}  ${JSON.stringify(c.input)}  ${JSON.stringify(c.expected)}`);
      return 0;
    }
    if (sub === "add") return report(await authoring.addCase(store, target, fields), (c) => console.log(`added case ${c.id}`));
    if (sub === "edit") return report(await authoring.editCase(store, target, fields), (c) => console.log(`edited case ${c.id}`));
    return report((await store.deleteSkillEvalCase(target)) ? { value: target } : { refused: `no skill eval case ${target}: nothing deleted` }, (id) => console.log(`deleted case ${id}`));
  });
}

export default defineCommand({
  names: ["eval"],
  usage: USAGE,
  async run(argv, ctx) {
    if (argv[0] === "suite" || argv[0] === "case") {
      if (!ctx.authoring) {
        console.error(`eval ${argv[0]} is not available here: run it as \`factory eval ${argv[0]} ...\``);
        return 1;
      }
      const authoring = ctx.authoring;
      let code: number | null;
      try {
        code = await (argv[0] === "suite" ? suiteCommand : caseCommand)(argv.slice(1), ctx, authoring);
      } catch (e) {
        console.error((e as Error).message);
        return 1;
      }
      if (code === null) console.error(`usage:\n${USAGE}`);
      return code ?? 1;
    }
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
