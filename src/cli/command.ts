// A CLI command (RFC 0015 §6.1): one folder under cli/handlers/<command>/ holding a `<command>.command.ts`
// whose default export is defineCommand(...). main.ts finds them by pattern; nothing lists them centrally.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type CliEnvironment, type CliIdentity, type FactoryStore, type Loaded, buildStatsStore } from "../compose.js";
import type { Authored, SkillEvalAuthoring, TriedCase } from "../runtime/index.js";
import { loadedIdentity } from "./support.js";

/** The registry and the local owner check, for a command that builds plugins or checks the owner itself (attach, alarm). */
export { Plugins, localAuth, ownerRefusal } from "../compose.js";
/** The routine writes, the same core function the routine API calls (`factory routine`). */
export { writeRoutine, type CliIdentity, type FactoryStore, type Routine, type RoutineFields, type RoutineWrite } from "../compose.js";

/** What a command is called with: by main.ts, by another command (setup runs settings) or by a test. */
export interface CommandCall {
  /** The name the command was called by (one of its `names`). */
  readonly name: string;
  /** Loads factory.config.json (the --config flag or FACTORY_CONFIG wins); throws on a broken config. */
  load(): Promise<Loaded>;
  /** The full help text, for a command that prints it on a bad argument. */
  readonly usage: string;
  /** What the environment says about the operator; absent: git's user.email in the repo, then the OS user (cliEnvironment). */
  readonly environment?: (root: string) => Promise<CliEnvironment>;
  /** Opens the configured store; absent: buildStatsStore. */
  readonly openStore?: (loaded: Loaded) => Promise<FactoryStore>;
  /** Runs one skill eval with the configured plugins (src/skill-evals.ts skillEvalRun, built by main.ts); absent: `eval run` refuses. */
  readonly runSkillEval?: SkillEvalRunFn;
  /** Replays and judges one skill-eval case, storing nothing (src/skill-evals.ts skillEvalTry, built by main.ts); absent: `eval case try` refuses. */
  readonly trySkillEvalCase?: SkillEvalTryFn;
  /** The suite and case authoring rules (src/skill-evals.ts skillEvalAuthoring, built by main.ts); absent: `eval suite` and `eval case` refuse. */
  readonly authoring?: SkillEvalAuthoring;
  /** Grid and compare over stored runs (src/core/skill-eval-compare.ts, passed by main.ts); absent: `eval results --by` and `eval compare` refuse. */
  readonly skillEvalReads?: SkillEvalReads;
}

/** One stored skill-eval run with its figures, as `eval results` prints it. */
export type SkillEvalRunRow = Awaited<ReturnType<FactoryStore["listSkillEvalRuns"]>>[number];

/** `eval run <skill>`'s options, as typed: the replays' model class, the judge's class and replays per case (1 to 10). */
export interface SkillEvalRunOptions {
  model_class?: string;
  judge_model_class?: string;
  replays?: number;
  /** --baseline: the suite with no skill text and no skill folder, stored as `baseline:<folder hash>`; absent unless set. */
  baseline?: boolean;
}

/** One `eval run <skill>`: the stored run, or why nothing was run (no run written). */
export type SkillEvalRunFn = (
  store: FactoryStore, loaded: Loaded, r: { skill: string; created_by: CliIdentity["user"]; signal: AbortSignal } & SkillEvalRunOptions,
) => Promise<{ run: SkillEvalRunRow } | { refused: string }>;

/** One `eval case try <case>`: the tried case's verdict and checks, or why nothing was tried. */
export type SkillEvalTryFn = (
  store: FactoryStore, loaded: Loaded, r: { case_id: string; model_class: string; signal: AbortSignal },
) => Promise<Authored<TriedCase>>;

/**
 * One run in a grid row or a comparison. The shapes of src/core/skill-eval-compare.ts, restated here because the CLI
 * component imports no legacy module; main.ts passes the functions, so the compiler checks the two agree.
 */
export interface SkillEvalRunSummary {
  run_id: string;
  started_at: string;
  status: string;
  skill_version: string | null;
  suite_version: number | null;
  judge_version: string | null;
  factory_version: string | null;
  model_class: string | null;
  judge_model_class: string | null;
  replays: number | null;
  pass_rate: number | null;
  errored: number | null;
}

/**
 * A run's pass@1, pass^k and 95% Wilson interval over its replays: the shape of src/core/skill-eval-stats.ts RunStats,
 * restated here for the same reason as SkillEvalRunSummary.
 */
export interface SkillEvalRunStats {
  replays: number;
  k: number;
  pass_at_1: number | null;
  pass_hat_k: number | null;
  interval: { low: number; high: number } | null;
}

/** One stored replay verdict of a run, as stats and compare take it. */
export interface SkillEvalVerdictRow {
  case_id: string;
  verdict: string;
}

/** Grid, compare and run stats, the same functions the read routes call. */
export interface SkillEvalReads {
  /** A run's stats from its stored verdicts (src/core/skill-eval-stats.ts runStats). */
  stats(verdicts: readonly SkillEvalVerdictRow[]): SkillEvalRunStats;
  /** One row per (skill version, model class) from its newest run; runs with no figures left out. */
  grid(runs: readonly SkillEvalRunRow[]): SkillEvalRunSummary[];
  /**
   * b against a, paired case by case from both runs' stored verdicts: wins, losses, ties, the sign-test p, the mean
   * case difference with its paired 95% interval and the verdict; every figure null when the runs are not comparable
   * (different suite or judge versions, or one with none recorded: `reason` says which).
   */
  compare(a: SkillEvalRunRow, b: SkillEvalRunRow, replays: { a: readonly SkillEvalVerdictRow[]; b: readonly SkillEvalVerdictRow[] }): {
    a: SkillEvalRunSummary; b: SkillEvalRunSummary; comparable: boolean; reason: string | null;
    paired: number | null; wins: number | null; losses: number | null; ties: number | null; p_value: number | null;
    mean_difference: number | null; interval: { low: number; high: number } | null; verdict: "better" | "worse" | "within noise" | null;
  };
}

/** What a command runs with: its call, plus the CLI identity and the store, built once here for every command. */
export interface CommandContext extends CommandCall {  /**
   * The CLI identity the command acts as (issue #318): `cli_user`, else local:<git user.email>, else local:<OS user>,
   * else local:anonymous. Throws on a `cli_user` that is no user ID.
   */
  identity(): Promise<CliIdentity>;
  /** Runs `fn` with the configured store open and migrated (its db folder made first); closes the store after. */
  withStore<T>(fn: (store: FactoryStore, loaded: Loaded) => Promise<T>): Promise<T>;
}

export interface CommandDescriptor {
  readonly kind: "command";
  /** The words that call it; the first is its name. */
  readonly names: readonly string[];
  /** Its block of the help text, every line indented by two spaces. */
  readonly usage: string;
  run(args: readonly string[], call: CommandCall): Promise<number>;
}

export const COMMAND_FILE = /\.command\.(?:ts|js)$/;

export function defineCommand(d: Omit<CommandDescriptor, "kind" | "run"> & { run(args: readonly string[], ctx: CommandContext): Promise<number> }): CommandDescriptor {
  if (d.names.length === 0) throw new Error("a command needs at least one name");
  return { kind: "command", names: d.names, usage: d.usage, run: (args, call) => d.run(args, commandContext(call)) };
}

/** The context of `call`: identity() and withStore(fn) over its config, which each loads afresh (setup rewrites it). */
function commandContext(call: CommandCall): CommandContext {
  return {
    ...call,
    identity: async () => loadedIdentity(await call.load(), call.environment),
    async withStore(fn) {
      const loaded = await call.load();
      await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
      const store = await (call.openStore ?? buildStatsStore)(loaded);
      try {
        await store.migrate();
        return await fn(store, loaded);
      } finally {
        await store.close();
      }
    },
  };
}
