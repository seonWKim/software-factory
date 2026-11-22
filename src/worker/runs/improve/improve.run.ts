import {
  type Grade, type GradeSubject, IMPROVER_DEFAULTS, type ImproveDeps, improvePrompts, learnFromReport, proposeChanges, proposesIn, runImprove, scoreRun, scorerFor,
} from "../../../core/improver.js";
import type { Run, WorkItem } from "../../../core/types.js";
import { factoryGit } from "../../../impl/broker/trusted-git.js";
import { addUsage } from "../../support.js";
import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, defineRunKind } from "../../run-kind.js";

/**
 * The improve run (design §7): no sandbox, no agent. One plain model call per group, with no tools; its usage
 * counts toward the run's. Stores one report; the outcome names it. Then, only in the daily run and only from the
 * stored report, the learner may write one tighter max_diff_lines for the project (design 08-settings), and, as
 * `improver.schedule` allows, the entity proposals are drafted and replayed through the golden set (core/proposals.ts).
 */
async function improve(w: Worker, run: Run, item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
  const metered = meteredLlm(w, run);
  const report = await runImprove(
    {
      store: w.d.store, storage: w.d.storage, scanner: w.d.scanner, signal, hotspot_threshold: w.live.values().conflict_hotspot_threshold,
      git: mergeGit(w.cfg.repo.path, w.cfg.repo.base_branch),
      ...(metered ? { llm: metered } : {}), ...(w.d.prompts.improve !== undefined ? { prompt: w.live.styled(improvePrompts(w.d.prompts.improve).draft) } : {}),
    },
    run,
    item,
  );
  const learned = await learnFromReport({ store: w.d.store, layers: w.cfg.settings }, run, report);
  // Entity proposals (design §7, #496): the review prompt's change per recurring failure, with its golden evidence; nothing applied.
  const cfg = w.cfg.improver ?? IMPROVER_DEFAULTS;
  const replay = w.d.reviewReplay; // the golden replay, built in the composition root (src/golden-replay.ts)
  const proposals = metered && replay && proposesIn(cfg.schedule, run)
    ? await proposeChanges({ store: w.d.store, scanner: w.d.scanner, llm: metered, file_text: w.d.prompts.review, replay: (prompt) => replay(prompt, { run_id: run.id, config: w.cfg, signal }), config: cfg, signal }, report)
    : [];
  return {
    report_id: report.id, groups: report.groups.length, patterns: report.patterns.length, proposals: proposals.map((p) => p.id),
    ...(learned ? { learned: { key: learned.key, old_value: learned.old_value, new_value: learned.new_value } } : {}),
  };
}

/**
 * The hotspot count's git reader (design 07-self-improvement), on the factory repo: the improve run has no checkout.
 * A merge's per-file deleted lines against its first parent (numstat, no rename detection, so a move deletes every
 * line), each such file's line count at that parent (numstat from the empty tree), and `ls-tree` at the base head.
 * Any git failure throws, so the improve run fails with no report and is retried.
 */
function mergeGit(repo: string, base_branch: string): NonNullable<ImproveDeps["git"]> {
  const git = async (args: string[]): Promise<string> => {
    const r = await factoryGit(repo, args, { GIT_LITERAL_PATHSPECS: "1" });
    if (r.exit_code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().slice(0, 300)}`);
    return r.stdout;
  };
  // `git diff --numstat -z` with no renames: "<added>\t<deleted>\t<path>" per NUL; a binary file's counts are "-".
  const numstat = (out: string) => {
    const rows = new Map<string, { added: number; deleted: number }>();
    for (const entry of out.split("\0")) {
      const [added, deleted, ...path] = entry.split("\t");
      if (path.length > 0) rows.set(path.join("\t"), { added: Number(added) || 0, deleted: Number(deleted) || 0 });
    }
    return rows;
  };
  const diff = ["diff", "--numstat", "-z", "--no-renames", "--no-textconv", "--no-ext-diff"];
  return {
    removals: async (sha) => {
      if (!/^[0-9a-f]{4,64}$/.test(sha)) throw new Error(`not a merge sha: ${sha.slice(0, 80)}`);
      const parent = `${sha}^1`;
      const changed = [...numstat(await git([...diff, parent, sha, "--"]))].filter(([, n]) => n.deleted > 0);
      if (changed.length === 0) return new Map();
      const empty = (await git(["hash-object", "-t", "tree", "/dev/null"])).trim();
      const before = numstat(await git([...diff, empty, parent, "--", ...changed.map(([path]) => path)]));
      return new Map(changed.map(([path, n]) => [path, { deleted: n.deleted, lines: before.get(path)?.added ?? 0 }]));
    },
    existsAtHead: async (path) => (await git(["ls-tree", "--name-only", "-z", `refs/heads/${base_branch}`, "--", path])).split("\0").includes(path),
  };
}

/** The worker's LLMProvider with each call's usage added to the run's (design §6); absent when it has none. */
function meteredLlm(w: Worker, run: Run): ImproveDeps["llm"] {
  const { llm } = w.d;
  const meter = w.meters.get(run);
  return llm && {
    complete: async (req) => {
      const res = await llm.complete(req);
      if (meter) addUsage(meter, res.usage);
      return res;
    },
  };
}

/**
 * A succeeded agent run's data with its scorer grades (design §7, issue #514), from judges independent of the call
 * that produced it (src/core/scorer.ts); their usage counts toward the run's. No model class (a kind with no agent),
 * no LLMProvider or no scorer prompt: the data as it was, with no grade. Grading never fails the run.
 */
export async function gradeRun(
  w: Worker, run: Run, item: WorkItem, producer: GradeSubject["producer"] | null, data: Record<string, unknown>, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (producer === null) return data;
  const scorer = scorerFor(meteredLlm(w, run), w.d.prompts.improve);
  const grades: Grade[] = await scoreRun({ scorer, scanner: w.d.scanner, signal }, { kind: run.kind, title: item.title ?? "", producer, data })
    .catch(() => []);
  return grades.length > 0 ? { ...data, grades } : data;
}

export default defineRunKind({
  name: "improve",
  folder: false,
  timeouts: DEFAULT_TIMEOUTS,
  execute: (w, c) => improve(w, c.run, c.item, c.signal),
  grade: gradeRun,
});
