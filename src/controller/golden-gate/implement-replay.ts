// The implement role's golden replay (design 06-measurement, eval on change, issue #493). Golden replays a case as a review:
// the case's spec and diff, with the review schema. This wraps the runner so that an implement run replays its case instead:
// it checks out the case's base commit (case.json `base_sha`), runs the implement agent on the case's spec alone with no
// output schema, then answers as a review would: `pass` when the tree changed every file the case's diff.patch changes, else
// `bug` with each file it missed. A failed git step throws, so the replay is errored. Any other run passes through unchanged.
// Built in buildGoldenRunDeps (src/golden.ts); types are structural so the controller imports no legacy interface.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { goldenCasesByRole } from "../../runtime/index.js";

/** What this wrapper reads of a run spec (AgentRunSpec). */
export interface ReplaySpec<H> {
  role: string;
  work_item_id: string;
  prompt: string;
  sandbox: H;
  env_allowlist: Readonly<Record<string, string>>;
  output_schema?: Record<string, unknown>;
}

/** What this wrapper uses of a sandbox (Sandbox.exec). */
export interface ReplayExec<H> {
  exec(h: H, cmd: readonly string[], opts: { env: Readonly<Record<string, string>> }): Promise<{ exit_code: number | null; stdout: string }>;
}

interface ImplementCase { id: string; base_sha: string | null; spec: string; files: string[] }

/** The implement role's cases, by the work item id a replay runs them under (case.json `work_item_id`, else `golden_<id>`). */
function implementCases(rolesDir: string): Map<string, ImplementCase> {
  const out = new Map<string, ImplementCase>();
  for (const id of goldenCasesByRole(rolesDir).get("implement") ?? []) {
    const dir = join(rolesDir, "implement", "golden", id);
    const meta = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as { work_item_id?: unknown; base_sha?: unknown };
    const diff = readFileSync(join(dir, "environment", "diff.patch"), "utf8");
    out.set(typeof meta.work_item_id === "string" ? meta.work_item_id : `golden_${id}`, {
      id,
      base_sha: typeof meta.base_sha === "string" ? meta.base_sha : null,
      spec: readFileSync(join(dir, "instruction.md"), "utf8"),
      files: [...diff.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)].map((m) => m[1]!),
    });
  }
  return out;
}

/** `runner`, with each implement golden replay run on its case's spec and scored on the files it changed. */
export function implementReplayRunner<H extends { base_sha?: string }, S extends ReplaySpec<H>, R extends { status: string; output: unknown }>(
  runner: { run(spec: S): Promise<R> },
  sandbox: ReplayExec<H>,
  rolesDir: string,
): { run(spec: S): Promise<R> } {
  return {
    run: async (spec) => {
      const c = spec.role === "implement" ? implementCases(rolesDir).get(spec.work_item_id) : undefined;
      if (!c) return runner.run(spec);
      const git = async (...args: string[]) => {
        const r = await sandbox.exec(spec.sandbox, ["git", ...args], { env: spec.env_allowlist });
        if (r.exit_code !== 0) throw new Error(`git ${args[0]} failed in the replay sandbox (case ${c.id})`);
        return r.stdout;
      };
      if (c.base_sha !== null) await git("checkout", "--detach", c.base_sha);
      const { output_schema: _review, ...rest } = spec;
      const result = await runner.run({ ...rest, prompt: c.spec } as S);
      if (result.status !== "completed") return result;
      await git("add", "--intent-to-add", "--all");
      const changed = (await git("diff", "--name-only", "-z", c.base_sha ?? spec.sandbox.base_sha ?? "HEAD")).split("\0");
      const missed = c.files.filter((p) => !changed.includes(p));
      const findings = missed.map((p) => `not changed: ${p}`);
      return { ...result, output: { verdict: missed.length === 0 ? "pass" : "bug", tier: 5, findings, summary: `implement replay of case ${c.id}` } };
    },
  };
}
