// Local branches (design 08-cleanup): each `refs/heads/<prefix><id>` in the factory repository, owned by item <id>.
// The branch decision: only a branch merged into the base branch goes (the shared merged-branch rule), and never
// one checked out in a worktree. Deleted with the sha it was listed at, so a branch that moved since stays. Remote
// branches are never touched.

import { type CleanupEnv, type Resource, defineCleanupHandler } from "../../handler.js";
import { mergedRule } from "../../removal-safety.js";
import { baseEnv } from "../../../impl/process/run-process.js";

const KIND = "branch";

async function gitOut(env: CleanupEnv, args: readonly string[]): Promise<string> {
  const r = await env.run(["git", ...args], { cwd: env.repo, env: baseEnv() });
  if (r.exit_code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.exit_code}): ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
}

/** The branches checked out in any worktree of the repository, the main checkout included. */
async function checkedOutBranches(env: CleanupEnv): Promise<Set<string>> {
  const out = await gitOut(env, ["worktree", "list", "--porcelain"]);
  return new Set([...out.matchAll(/^branch (.+)$/gm)].map((m) => m[1]!));
}

export default defineCleanupHandler({
  name: KIND,
  order: 30,
  async list(env) {
    const prefix = `refs/heads/${env.branchPrefix}`;
    const checkedOut = await checkedOutBranches(env);
    const out: Resource[] = [];
    for (const line of (await gitOut(env, ["for-each-ref", "--format=%(refname) %(objectname)", prefix])).split("\n")) {
      const [ref, sha] = line.trim().split(" ");
      if (!ref || !sha) continue;
      const name = ref.slice("refs/heads/".length);
      out.push({
        kind: KIND, key: ref, label: `branch ${name}`, item_id: ref.slice(prefix.length),
        data: { ref, sha, checked_out: checkedOut.has(ref) ? 1 : 0 },
      });
    }
    return out;
  },
  accepts: (r) => r.kind === KIND && typeof r.data.ref === "string" && typeof r.data.sha === "string",
  async keep(r, env) {
    if (r.data.checked_out === 1) return "checked out in a worktree";
    return (await (await mergedRule(env.run, env.repo, env.baseBranch)).merged(String(r.data.sha))) ? null : `not merged into ${env.baseBranch}`;
  },
  async cleanup(r, env) {
    await gitOut(env, ["update-ref", "-d", String(r.data.ref), String(r.data.sha)]);
    return { bytes: null };
  },
});
