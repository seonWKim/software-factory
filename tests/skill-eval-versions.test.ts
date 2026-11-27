import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSkillEvalFor } from "../src/skill-evals.js";
import { OWNER, V1, V2, setup } from "./helpers/classifier.js";


// Eval runs bound to skill versions (design 06-measurement): a run is linked to the `ext_skill_versions` row whose
// folder hash it stored; runs with no hash, or a hash with no version row, stay unlinked and nothing is backfilled.
// GET /api/v1/evals/<skill>/versions gives each version's latest pass rate, its change since the previous version and
// the current mark; GET /api/v1/evals/<skill>/diff?a=<hash>&b=<hash> the unified line diff and per-case results.
// `eval run` defaults to the current version and can re-run a previous one by its hash. Fakes only, no live model.

let tmp: string;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "skill-eval-versions-")));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("running evals by version", () => {
  it("defaults to the current version: the run replays SKILL.md as it is now and stores its folder hash", async () => {
    const { run, h2, runner } = await setup(tmp);
    const r = await run();
    expect(r).toMatchObject({ skill_version: h2, pass_rate: 1 });
    expect(runner.specs.map((s) => s.system_prompt)).toEqual([V2, V2]);
  });

  it("re-runs a previous version by its hash: its stored text is the skill's system prompt and the run stores that hash", async () => {
    const { run, h1, runner } = await setup(tmp);
    const r = await run(h1);
    expect(r).toMatchObject({ skill_version: h1, pass_rate: 0.5 });
    expect(runner.specs.map((s) => s.system_prompt)).toEqual([V1, V1]);
  });

  it("refuses a hash that is no version of the skill, writing no run", async () => {
    const { d, skill, store } = await setup(tmp);
    const r = await runSkillEvalFor(d, { skill, created_by: OWNER, signal: new AbortController().signal, version: "f".repeat(64) });
    expect(r).toEqual({ refused: expect.stringContaining("no version") });
    expect(await store.listSkillEvalRuns(skill)).toEqual([]);
  });
});
