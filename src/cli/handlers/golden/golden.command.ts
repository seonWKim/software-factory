import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Plugins, resolveProject } from "../../../compose.js";
import { addCase, buildGoldenRunDeps, compareCases, formatCompare, formatReport, parseAddArgs, parseCompareArgs, parseRunArgs, runCases } from "../../../golden.js";
import { storeProjectResolver } from "../../../ui/settings-api.js";
import { defineCommand } from "../../command.js";

/** `golden add` reads the store and GitHub (read-only); `golden run` and `golden compare` open neither. */
export default defineCommand({
  names: ["golden"],
  usage: `  golden add <pr> [--expect should_flag|should_pass] [--force]
               writes golden/cases/<pr>/ (diff.patch, spec.md, case.json) from a factory PR's record;
               egress-scanned first, nothing written on a finding; a clean merge needs --expect should_pass
  golden run --agent reviewer
               replays every golden case through the reviewer (no push, no GitHub writes), prints
               catch_rate and false_alarm_rate, writes <state_dir>/golden/results/<timestamp>.json.
               With the noop sandbox the agent runs as the host user: test environment only (design §5)
  golden compare --base <file> [--agent reviewer] [--since <ref> | --all]
               replays the cases tagged with the changed prompt twice (base prompt from <file>, then the
               repo's prompt) and fails (exit 1) when catch_rate drops or false_alarm_rate rises by more than
               GOLDEN_MARGIN. Skips (exit 0) when nothing since <ref> (default: the base branch) touches
               prompts/ or prompt code, with no tagged cases, or with an n/a rate. Local only (design §6)`,
  async run(argv, ctx) {
    const [sub, ...rest] = argv;
    const args = [...rest];
    const loaded = await ctx.load();
    const p = new Plugins(loaded);
    if (sub === "add") {
      const opts = parseAddArgs(args);
      await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
      const secrets = await p.secrets();
      const store = await p.store(secrets, await p.clock());
      try {
        await store.migrate();
        const { owner, name } = loaded.config.repo;
        const github = await p.githubApi();
        const r = await addCase(
          {
            store,
            project: (await storeProjectResolver(store, { owner, name })()) ?? (await resolveProject(github, { owner, name })),
            github: { pullDiff: (pr) => github.pullDiff({ owner, name }, pr) },
            scanner: await p.scanner(secrets),
            casesDir: join(loaded.root, "golden", "cases"),
          },
          opts,
        );
        console.log(`wrote ${r.dir} (${r.case.expect}, ${r.case.outcome})`);
        return 0;
      } finally {
        await store.close();
      }
    }
    if (sub === "run") {
      const report = await runCases(await buildGoldenRunDeps(p, loaded), parseRunArgs(args));
      console.log(formatReport(report));
      return 0;
    }
    if (sub === "compare") {
      const opts = parseCompareArgs(args);
      const basePrompt = await readFile(opts.base, "utf8");
      const changed = opts.all ? null : await changedPaths(loaded.root, opts.since ?? loaded.config.repo.base_branch);
      const report = await compareCases(await buildGoldenRunDeps(p, loaded), { agent: opts.agent, basePrompt, changed });
      console.log(formatCompare(report));
      return report.outcome === "fail" ? 1 : 0;
    }
    console.log(ctx.usage);
    return 1;
  },
});

/**
 * Repo-relative paths that differ from where HEAD left `ref` (the merge base), committed or not, plus
 * untracked files: what `golden compare` checks against the prompt inputs.
 */
async function changedPaths(root: string, ref: string): Promise<string[]> {
  const git = async (args: string[]) => (await promisify(execFile)("git", args, { cwd: root, timeout: 30_000 })).stdout;
  const mergeBase = (await git(["merge-base", ref, "HEAD"])).trim();
  const lines = `${await git(["diff", "--name-only", mergeBase])}\n${await git(["ls-files", "--others", "--exclude-standard"])}`;
  return [...new Set(lines.split("\n").filter((l) => l !== ""))];
}
