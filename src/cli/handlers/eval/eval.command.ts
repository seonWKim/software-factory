// `factory eval run|results|compare|suite|case|import` (design 06-measurement, skill evals). Suites and cases are
// written through the authoring rules (src/runtime/skill-evals/authoring.ts), `import` through its importCases (the
// configured SkillEvalSource, src/runtime/skill-evals/import.ts); `case try` is the call's trySkillEvalCase; `case split`
// (design 07-self-improvement) is a store call on a stored case and `case from-run` the authoring's caseFromRun. The
// run itself is the root wiring (src/skill-evals.ts) and the grid and compare are src/core/skill-eval-compare.ts, both
// passed in by main.ts through the command call (runSkillEval, skillEvalReads), so this handler imports no root or
// legacy module. <skill> is a suite's skill_ref: a skill folder.

import { readFile } from "node:fs/promises";
import { parseArgs as parseFlags } from "node:util";
import { type CommandContext, type FactoryStore, type SkillEvalReads, type SkillEvalRunOptions, type SkillEvalRunRow, type SkillEvalRunStats, type SkillEvalRunSummary, defineCommand } from "../../command.js";
import { stopOnSignals } from "../../support.js";

const USAGE = `  eval run <skill> [--model <class>] [--judge-model <class>] [--replays <n>] [--baseline]
               runs the skill's eval suite once (each case replayed n times, each replay judged; model calls)
               and stores the run with its skill version, model class, judge model class, replays (cases × n),
               pass rate and errored replays, then prints them with pass@1 (passes over replays), pass^k (share
               of cases that pass all k = n replays) and the 95% Wilson interval of pass@1; exit 0 when the run
               passed. --model: cheap, standard or strong (default standard); --judge-model: only the judge
               class of --model; --replays: a whole number from 1 to 10 (default 1), any other value is a usage
               error; --baseline: replays the suite with no skill text and no skill folder, stored with skill
               version baseline:<folder hash> beside the skill's runs (self-improve does not read it as measured).
               Refuses, running nothing, when no suite exists for <skill> or an option is refused
  eval results <skill> [--by version,model] [--json]
               lists the skill's stored runs, newest first, each with pass@1, pass^k and the 95% Wilson
               interval over its replays (--json: one JSON array, the same fields as
               GET /api/v1/evals/<skill>/runs); --by version,model: one row per skill version and model
               class from its newest run, runs with no figures left out (GET /api/v1/evals/<skill>/grid)
  eval compare <run-a> <run-b> [--json]
               pairs the runs' cases (each case's passes ÷ its replays; cases in only one run left out):
               wins (b higher), losses and ties, the exact two-sided sign-test p over the non-tied cases,
               the mean difference (b − a) with its paired 95% t interval, and the verdict: better or worse
               when p < 0.05 and the interval excludes zero that way, else within noise; not comparable,
               with the reason, when the runs' suite or judge versions differ or one has none recorded
               (--json: the same fields as GET /api/v1/evals/<skill>/compare?a=<run-a>&b=<run-b>)
  eval suite list|add|rename|delete
               suite list prints each suite's skill and title; suite add <skill> [--title <title>] makes the
               skill's one suite (title defaults to the skill); suite rename <skill> <title>; suite delete
               <skill> refuses while a run of it is running, else says how many runs keep their history, then
               deletes the suite and its cases (its runs stay in the store, unlisted)
  eval case list|add|edit|delete|try|split|from-run
               case list <skill> (each case with its split, dev or held-out); case add <skill> (--file <json> | --input <text> --check <text> ...) where the
               json is {"input": ..., "expected": [checks]} or {"expected": {"checks": [...], "threshold": n}};
               a check is a text (a must-have yes/no the judge answers) or an object with a kind: contains,
               does-not-contain, regex, max length, valid JSON, JSON schema subset (run first, no model call),
               rubric (a criterion with anchors "1" to "5", scored 1 to 5) or pairwise (a criterion, judged
               against the previous version's answer), each with an optional weight (0 or more) and must;
               case edit <case-id> takes the same, a field not given keeps its value; case delete <case-id>;
               case try <case-id> [--model cheap|standard|strong] replays and checks one case (default
               standard), prints each check as yes or no with its reason, the score and threshold, then
               "verdict: pass|fail|errored" (exit 0 on pass), and stores no run and no replay;
               case split <case-id> dev|held-out sets the case's split (the suite's version is unchanged):
               self-improve tunes and measures drafts on dev cases and checks a draft on held-out cases before
               it is promoted, while eval run replays every case; case from-run <run-id> <case-id> adds a new dev
               case with an id from the run and the case (a repeat adds nothing), copying the input, expected, seed and MCP servers of <case-id>, only when
               <case-id> has a replay with verdict fail in <run-id> (else refused, nothing written)
  eval import <skill> [--source <plugin>]
               copies the skill's cases from the eval source (--source, else plugins.eval_source; default none)
               into its suite as import:<source>:<skill>:<source case id>; ids already stored are kept as they
               are, and the source is only read. Each new case passes the case add rule and the egress scan
               first; any refusal (no source on, an unknown source, no suite, a source that cannot be read, a
               bad case, a finding, named by rule only) exits 1 and writes nothing`;

const orDash = (v: string | number | null) => (v === null ? "-" : String(v));
const rate = (v: number | null) => (v === null ? "-" : v.toFixed(2));

/** pass@1, pass^k and the 95% Wilson interval, a dash for a rate with no replay. */
function statsText(s: SkillEvalRunStats): string {
  const interval = s.interval === null ? "-" : `${s.interval.low.toFixed(2)}-${s.interval.high.toFixed(2)}`;
  return `pass@1 ${rate(s.pass_at_1)}, pass^${s.k} ${rate(s.pass_hat_k)}, 95% interval ${interval}`;
}

/** One run as one line: when, id, status and figures (a dash for a figure not recorded), then its stats when given. */
function runLine(r: SkillEvalRunRow, stats?: SkillEvalRunStats): string {
  return `${r.started_at}  ${r.id}  ${r.status}  replays ${orDash(r.replays)}, pass rate ${rate(r.pass_rate)}, errored ${orDash(r.errored)}`
    + `  (model ${orDash(r.model_class)}, judge ${orDash(r.judge_model_class)}, skill version ${orDash(r.skill_version)})`
    + (stats ? `  ${statsText(stats)}` : "");
}

/** Each run's line, with its stats from its stored replays when the call has the stats function. */
async function runLines(store: FactoryStore, runs: readonly SkillEvalRunRow[], reads: SkillEvalReads | undefined): Promise<string[]> {
  return Promise.all(runs.map(async (r) => runLine(r, reads ? reads.stats(await store.listSkillEvalReplays(r.id)) : undefined)));
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
  const { values, positionals: [sub, skill, title, ...extra] } = parseFlags({ args: [...argv], allowPositionals: true, options: { title: { type: "string" } } });
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

// The store's split values (`SKILL_EVAL_SPLITS`), kept here so the cli component imports no legacy interface.
type SkillEvalSplit = "dev" | "held-out";
const isSplit = (v: string | undefined): v is SkillEvalSplit => v === "dev" || v === "held-out";

/** `case split <case-id> dev|held-out`: sets one case's split, bumping no suite version; an unknown case is refused. */
async function setSplit(store: FactoryStore, case_id: string, split: SkillEvalSplit): Promise<number> {
  const c = await store.setSkillEvalCaseSplit(case_id, split);
  return report(c ? { value: c } : { refused: `no skill eval case ${case_id}: nothing changed` }, (x) => console.log(`case ${x.id} is ${x.split}`));
}

async function caseCommand(argv: readonly string[], ctx: CommandContext, authoring: NonNullable<CommandContext["authoring"]>): Promise<number | null> {
  const { values, positionals: [sub, target, second, ...extra] } = parseFlags({
    args: [...argv], allowPositionals: true, options: { file: { type: "string" }, input: { type: "string" }, check: { type: "string", multiple: true }, model: { type: "string" } },
  });
  const writes = sub === "add" || sub === "edit";
  const modelOk = values.model === undefined || sub === "try";
  const flagsOk = writes || (values.file === undefined && values.input === undefined && values.check === undefined);
  const pair = sub === "split" || sub === "from-run";
  const secondOk = pair ? second !== undefined && (sub !== "split" || isSplit(second)) : second === undefined;
  if (!["list", "add", "edit", "delete", "try", "split", "from-run"].includes(sub ?? "") || !target || !secondOk || extra.length > 0 || !modelOk || !flagsOk) return null;
  if (sub === "split") return ctx.withStore((store) => setSplit(store, target, second as SkillEvalSplit));
  if (sub === "from-run") return ctx.withStore(async (store) => report(await authoring.caseFromRun(store, target, second!), (c) => console.log(`added case ${c.id} (dev) from case ${second} of eval run ${target}`)));
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
    for (const c of r.value.checks) console.log(`${c.answer}  ${c.check}${c.score !== undefined ? ` (${c.score}/5)` : ""}  ${c.reason}`);
    if (r.value.threshold !== undefined) console.log(`score: ${r.value.score == null ? "-" : r.value.score.toFixed(2)} (threshold ${r.value.threshold})`);
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
      for (const c of cases) console.log(`${c.id}  ${c.split}  ${JSON.stringify(c.input)}  ${JSON.stringify(c.expected)}`);
      return 0;
    }
    if (sub === "add") return report(await authoring.addCase(store, target, fields), (c) => console.log(`added case ${c.id}`));
    if (sub === "edit") return report(await authoring.editCase(store, target, fields), (c) => console.log(`edited case ${c.id}`));
    return report((await store.deleteSkillEvalCase(target)) ? { value: target } : { refused: `no skill eval case ${target}: nothing deleted` }, (id) => console.log(`deleted case ${id}`));
  });
}

/** `eval import <skill> [--source <plugin>]`: null on a bad argument. */
async function importCommand(argv: readonly string[], ctx: CommandContext, authoring: NonNullable<CommandContext["authoring"]>): Promise<number | null> {
  const { values, positionals: [skill, ...extra] } = parseFlags({ args: [...argv], allowPositionals: true, options: { source: { type: "string" } } });
  if (!skill || extra.length > 0) return null;
  const importCases = authoring.importCases;
  if (!importCases) return (console.error("eval import is not available here: run it as `factory eval import <skill>`"), 1);
  return ctx.withStore(async (store) => report(await importCases(store, { skill, source: values.source }), (v) => {
    for (const id of v.added) console.log(`imported case ${id}`);
    if (v.kept.length > 0) console.log(`${v.kept.length} case${v.kept.length === 1 ? "" : "s"} already stored, kept as ${v.kept.length === 1 ? "it is" : "they are"}`);
    console.log(`imported ${v.added.length} new case${v.added.length === 1 ? "" : "s"} from ${v.source}`);
  }));
}

/** One grid row or compared run as one line. */
const summaryLine = (r: SkillEvalRunSummary) =>
  `skill version ${orDash(r.skill_version)}  model ${orDash(r.model_class)}  pass rate ${rate(r.pass_rate)}  replays ${orDash(r.replays)}  (run ${r.run_id}, ${r.started_at})`;

/** The words and flags after the subcommand: positionals, value flags, --json and `--baseline` (run only); null on an unknown or valueless flag. */
function parseArgs(args: readonly string[], valued: readonly string[], sub: string): { words: string[]; values: Map<string, string>; json: boolean; baseline: boolean } | null {
  const words: string[] = [];
  const values = new Map<string, string>();
  let json = false, baseline = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") json = true;
    else if (a === "--baseline" && sub === "run") baseline = true;
    else if (valued.includes(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith("-") || values.has(a)) return null;
      values.set(a, v);
    } else if (a.startsWith("-")) return null;
    else words.push(a);
  }
  return { words, values, json, baseline };
}

/** --replays: a whole number from 1 to 10 (MAX_REPLAYS in src/skill-evals.ts, whose run check refuses the same). */
const REPLAYS = /^(?:[1-9]|10)$/;

/** --model, --judge-model, --replays and --baseline (only when set) as the run function takes them; null on a --replays that is not 1 to 10. */
function runOptions(values: Map<string, string>, baseline: boolean): SkillEvalRunOptions | null {
  const o: SkillEvalRunOptions = baseline ? { baseline: true } : {};
  const model = values.get("--model"), judge = values.get("--judge-model"), replays = values.get("--replays");
  if (model !== undefined) o.model_class = model;
  if (judge !== undefined) o.judge_model_class = judge;
  if (replays !== undefined) {
    if (!REPLAYS.test(replays)) return null;
    o.replays = Number(replays);
  }
  return o;
}

const VALUED: Record<string, readonly string[]> = { run: ["--model", "--judge-model", "--replays"], results: ["--by"], compare: [] };

export default defineCommand({
  names: ["eval"],
  usage: USAGE,
  async run(argv, ctx) {
    if (argv[0] === "suite" || argv[0] === "case" || argv[0] === "import") {
      if (!ctx.authoring) {
        console.error(`eval ${argv[0]} is not available here: run it as \`factory eval ${argv[0]} ...\``);
        return 1;
      }
      const authoring = ctx.authoring;
      let code: number | null;
      try {
        code = await ({ suite: suiteCommand, case: caseCommand, import: importCommand }[argv[0]])(argv.slice(1), ctx, authoring);
      } catch (e) {
        console.error((e as Error).message);
        return 1;
      }
      if (code === null) console.error(`usage:\n${USAGE}`);
      return code ?? 1;
    }
    const [sub, ...rest] = argv;
    const parsed = sub !== undefined && Object.hasOwn(VALUED, sub) ? parseArgs(rest, VALUED[sub]!, sub) : null;
    const usage = () => (console.error(`usage:\n${USAGE}`), 1);
    if (!parsed || parsed.words.length !== (sub === "compare" ? 2 : 1) || (sub === "run" && parsed.json)) return usage();
    const { words, values, json, baseline } = parsed;
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
      if (grid) {
        const runs = await ctx.withStore((store) => store.listSkillEvalRuns(skill));
        const rows = grid(runs);
        if (json) console.log(JSON.stringify(rows, null, 2));
        else if (rows.length === 0) console.log(`no eval runs with figures for ${skill}`);
        else for (const r of rows) console.log(summaryLine(r));
        return 0;
      }
      const { runs, lines } = await ctx.withStore(async (store) => {
        const runs = await store.listSkillEvalRuns(skill);
        return { runs, lines: json ? [] : await runLines(store, runs, reads) };
      });
      if (json) console.log(JSON.stringify(runs, null, 2));
      else if (runs.length === 0) console.log(`no eval runs for ${skill}`);
      else for (const l of lines) console.log(l);
      return 0;
    }
    const options = runOptions(values, baseline);
    if (!options) return usage();
    const runSkillEval = ctx.runSkillEval;
    if (!runSkillEval) {
      console.error("eval run is not available here: run it as `factory eval run <skill>`");
      return 1;
    }
    const { user } = await ctx.identity();
    const result = await ctx.withStore(async (store, loaded) => {
      const r = await runSkillEval(store, loaded, { skill, created_by: user, signal: stopOnSignals(), ...options });
      return "refused" in r ? r : { run: r.run, line: (await runLines(store, [r.run], reads))[0]! };
    });
    if ("refused" in result) {
      console.error(result.refused);
      return 1;
    }
    console.log(result.line);
    return result.run.status === "passed" ? 0 : 1;
  },
});

/** `eval compare <run-a> <run-b>`: both runs and their replays read by id; exit 1 when either is unknown. Reads only. */
async function compare(ctx: Pick<CommandContext, "withStore">, reads: SkillEvalReads, a: string, b: string, json: boolean): Promise<number> {
  const read = await ctx.withStore(async (store) => {
    const [ra, rb] = await Promise.all([store.getSkillEvalRun(a), store.getSkillEvalRun(b)]);
    if (!ra || !rb) return { missing: [ra ? null : a, rb ? null : b].filter((x) => x !== null) };
    const [va, vb] = await Promise.all([store.listSkillEvalReplays(a), store.listSkillEvalReplays(b)]);
    return { c: reads.compare(ra, rb, { a: va, b: vb }) };
  });
  if (!("c" in read)) return (console.error(`no eval run ${read.missing.join(", ")}: nothing compared`), 1);
  const { c } = read;
  if (json) {
    console.log(JSON.stringify(c, null, 2));
    return 0;
  }
  console.log(`a  ${summaryLine(c.a)}`);
  console.log(`b  ${summaryLine(c.b)}`);
  if (!c.comparable) console.log(`not comparable: ${c.reason}`);
  else if (c.verdict === null || c.mean_difference === null) console.log("no comparison: no case has replays in both runs");
  else {
    const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
    console.log(`paired cases ${c.paired}: wins ${c.wins}, losses ${c.losses}, ties ${c.ties}`);
    const interval = c.interval === null ? "no 95% interval (fewer than two paired cases)" : `95% interval ${signed(c.interval.low)} to ${signed(c.interval.high)}`;
    console.log(`sign test p ${c.p_value!.toFixed(3)}, mean difference ${signed(c.mean_difference)}, ${interval}: ${c.verdict}`);
  }
  return 0;
}
