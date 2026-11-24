import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lineDiff, skillVersionRows } from "../src/core/skill-eval-compare.js";
import type { Timestamp, UserId } from "../src/core/types.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { skillVersion } from "../src/runtime/capabilities/capabilities.js";
import { type SkillEvalWiring, runSkillEvalFor } from "../src/skill-evals.js";
import { readApi } from "../src/ui/read-routes.js";
import type { ServerDeps, UiRequest } from "../src/ui/server.js";
import { config, cleanScanner } from "./helpers/fakes/config.js";
import { FakeRunner, FakeSandbox } from "./helpers/fakes/runner.js";
import { newStore } from "./helpers/store.js";

// Eval runs bound to skill versions (design 06-measurement): a run is linked to the `ext_skill_versions` row whose
// folder hash it stored; runs with no hash, or a hash with no version row, stay unlinked and nothing is backfilled.
// GET /api/v1/evals/<skill>/versions gives each version's latest pass rate, its change since the previous version and
// the current mark; GET /api/v1/evals/<skill>/diff?a=<hash>&b=<hash> the unified line diff and per-case results.
// `eval run` defaults to the current version and can re-run a previous one by its hash. Fakes only, no live model.

const OWNER = "local:owner" as UserId;
const REQ: UiRequest = { method: "GET", url: undefined, host: "127.0.0.1" };
const V1 = "# Review helper\n\nRead the change.\nReview the diff carefully.\n";
const V2 = "# Review helper\n\nRead the change.\nReview the diff, then the tests.\n";
/** Flags any text holding LEAK. */
const FLAGGING: EgressScanner = { scan: async (channel, t) => (t.includes("LEAK") ? { clean: false, findings: [{ rule: "test_rule", channel }] } : { clean: true }) };

/** A judge that answers yes when the replay's output names the tests (V2) or the case is CASE-A, else no. */
class RubricLLM implements LLMProvider {
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const said = req.messages.map((m) => m.content).join("\n");
    const answer = said.includes("then the tests") || said.includes("CASE-A") ? "yes" : "no";
    const parsed = { answers: [{ answer, reason: "ok" }] };
    return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
  }
}

let tmp: string;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "skill-eval-versions-")));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A suite for an imported skill folder with two cases, the folder's two imported versions (v2 current), and the wiring. */
async function setup() {
  const { store, clock } = await newStore();
  const folder = join(tmp, "skills", "review-helper");
  await mkdir(folder, { recursive: true });
  const skill = folder;
  await store.createSkillEvalSuite({ id: "s1", skill_ref: skill, title: "Review", created_by: OWNER });
  await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "CASE-A", expected: ["names the tests"] });
  await store.addSkillEvalCase({ id: "c2", suite_id: "s1", input: "CASE-B", expected: ["names the tests"] });
  await writeFile(join(folder, "SKILL.md"), V1);
  const h1 = await skillVersion(folder);
  await store.recordSkillVersion({ ref_id: "sr_review", folder_hash: h1, text: V1, source: "claude" });
  clock.advance(1000);
  await writeFile(join(folder, "SKILL.md"), V2);
  const h2 = await skillVersion(folder);
  await store.recordSkillVersion({ ref_id: "sr_review", folder_hash: h2, text: V2, source: "claude" });
  const runner = new FakeRunner({ implement: (spec) => ({ output: `${spec.system_prompt}\n${spec.prompt}` }) });
  let n = 0;
  const d: SkillEvalWiring = {
    store, root: tmp, judgePrompt: async () => "JUDGE", repo: { path: config.repo.path, base_branch: config.repo.base_branch }, deny_paths: [".env"], timeout_ms: 1000,
    plugins: async () => ({ sandbox: new FakeSandbox(), runner, llm: new RubricLLM(), scanner: cleanScanner }),
    newId: () => `run${++n}`,
  };
  const run = async (version?: string) => {
    clock.advance(1000);
    const r = await runSkillEvalFor(d, { skill, created_by: OWNER, signal: new AbortController().signal, ...(version !== undefined && { version }) });
    if (!("run" in r)) throw new Error(r.refused);
    return r.run;
  };
  return { store, clock, d, skill, h1, h2, runner, run };
}

const get = (store: FactoryStore, path: string, scanner: EgressScanner = cleanScanner) =>
  readApi({ store, scanner } as unknown as ServerDeps, new URL(`http://127.0.0.1${path}`), REQ);
const versionsPath = (skill: string) => `/api/v1/evals/${encodeURIComponent(skill)}/versions`;
const diffPath = (skill: string, a: string, b: string) => `/api/v1/evals/${encodeURIComponent(skill)}/diff?a=${a}&b=${b}`;

describe("running evals by version", () => {
  it("defaults to the current version: the run replays SKILL.md as it is now and stores its folder hash", async () => {
    const { run, h2, runner } = await setup();
    const r = await run();
    expect(r).toMatchObject({ skill_version: h2, pass_rate: 1 });
    expect(runner.specs.map((s) => s.system_prompt)).toEqual([V2, V2]);
  });

  it("re-runs a previous version by its hash: its stored text is the skill's system prompt and the run stores that hash", async () => {
    const { run, h1, runner } = await setup();
    const r = await run(h1);
    expect(r).toMatchObject({ skill_version: h1, pass_rate: 0.5 });
    expect(runner.specs.map((s) => s.system_prompt)).toEqual([V1, V1]);
  });

  it("refuses a hash that is no version of the skill, writing no run", async () => {
    const { d, skill, store } = await setup();
    const r = await runSkillEvalFor(d, { skill, created_by: OWNER, signal: new AbortController().signal, version: "f".repeat(64) });
    expect(r).toEqual({ refused: expect.stringContaining("no version") });
    expect(await store.listSkillEvalRuns(skill)).toEqual([]);
  });
});

describe("GET /api/v1/evals/<skill>/versions", () => {
  it("eval runs on v1 and v2 show both pass rates, with v2 marked current", async () => {
    const { store, skill, run, h1, h2 } = await setup();
    const r1 = await run(h1);
    const r2 = await run();
    const res = await get(store, versionsPath(skill));
    expect(res.status).toBe(200);
    const { versions } = res.value as { versions: Record<string, unknown>[] };
    expect(versions.find((v) => v.version === 2)).toMatchObject({ folder_hash: h2, current: true, run_id: r2.id, pass_rate: 1 });
    expect(versions.find((v) => v.version === 1)).toMatchObject({ folder_hash: h1, current: false, run_id: r1.id, pass_rate: 0.5 });
  });

  it("gives each version's latest pass rate and its change since the previous version, newest version first", async () => {
    const { store, skill, run, h1 } = await setup();
    await run(h1);
    await run();
    const latestV1 = await run(h1);
    await store.db.run("UPDATE controller_skill_eval_runs SET pass_rate = 0.25 WHERE id = ?", [latestV1.id]);
    const { versions } = (await get(store, versionsPath(skill))).value as { versions: Record<string, unknown>[] };
    const v1 = versions.findIndex((v) => v.version === 1), v2 = versions.findIndex((v) => v.version === 2);
    expect(v2).toBeLessThan(v1);
    expect(versions[v1]).toMatchObject({ run_id: latestV1.id, pass_rate: 0.25, change: null });
    expect(versions[v2]).toMatchObject({ pass_rate: 1, change: 0.75 });
  });

  it("runs with an empty skill_version or a hash with no version row stay unlinked, and nothing is backfilled", async () => {
    const { store, skill, run, h2 } = await setup();
    await store.startSkillEvalRun({ id: "old", suite_id: "s1", created_by: OWNER });
    await store.recordSkillEvalRunFigures("old", { model_class: "standard", judge_model_class: "strong", replays: 2, pass_rate: 0, errored: 0 });
    await store.startSkillEvalRun({ id: "stray", suite_id: "s1", created_by: OWNER, skill_version: "0".repeat(64) });
    await store.finishSkillEvalRun("stray", "failed");
    await store.recordSkillEvalRunFigures("stray", { model_class: "standard", judge_model_class: "strong", replays: 2, pass_rate: 0, errored: 0 });
    await run();
    const value = (await get(store, versionsPath(skill))).value as { versions: Record<string, unknown>[]; unlinked: string[] };
    expect(value.versions.find((v) => v.folder_hash === h2)).toMatchObject({ pass_rate: 1 });
    expect(value.versions.find((v) => v.version === 1)).toMatchObject({ run_id: null, pass_rate: null });
    expect(value.unlinked).toEqual(expect.arrayContaining(["old", "stray"]));
    expect(await store.getSkillEvalRun("old")).toMatchObject({ skill_version: null });
    expect(await store.getSkillEvalRun("stray")).toMatchObject({ skill_version: "0".repeat(64) });
  });

  it("lists no version for a skill with no linked run", async () => {
    const { store, skill } = await setup();
    expect((await get(store, versionsPath(skill))).value).toEqual({ versions: [], unlinked: [] });
  });
});

describe("GET /api/v1/evals/<skill>/diff", () => {
  it("returns the changed lines between two versions, unified, with per-case results", async () => {
    const { store, skill, run, h1, h2 } = await setup();
    await run(h1);
    await run();
    const res = await get(store, diffPath(skill, h1, h2));
    expect(res.status).toBe(200);
    const value = res.value as { a: Record<string, unknown>; b: Record<string, unknown>; lines: { op: string; text: string }[]; cases: unknown[] };
    expect(value.a).toMatchObject({ version: 1, folder_hash: h1, pass_rate: 0.5 });
    expect(value.b).toMatchObject({ version: 2, folder_hash: h2, pass_rate: 1 });
    expect(value.lines.filter((l) => l.op !== "same")).toEqual([
      { op: "removed", text: "Review the diff carefully." },
      { op: "added", text: "Review the diff, then the tests." },
    ]);
    expect(value.lines).toContainEqual({ op: "same", text: "Read the change." });
    expect(value.cases).toEqual([{ case_id: "c1", a: "pass", b: "pass" }, { case_id: "c2", a: "fail", b: "pass" }]);
  });

  it("answers 404 for a hash that is no version of the skill and 400 without both hashes", async () => {
    const { store, skill, run, h1 } = await setup();
    await run();
    expect((await get(store, diffPath(skill, h1, "0".repeat(64)))).status).toBe(404);
    expect((await get(store, `/api/v1/evals/${encodeURIComponent(skill)}/diff?a=${h1}`)).status).toBe(400);
  });

  it("sends every line of text through the Withholder", async () => {
    const { store, skill, run, h1, h2 } = await setup();
    await run();
    await store.db.run("UPDATE ext_skill_versions SET text = ? WHERE folder_hash = ?", ["# Review helper\nLEAK secret\n", h1]);
    const { lines } = (await get(store, diffPath(skill, h1, h2), FLAGGING)).value as { lines: { text: string }[] };
    expect(lines.map((l) => l.text).join("\n")).not.toContain("LEAK");
  });
});

describe("the pure reads", () => {
  it("lineDiff keeps unchanged lines and marks removed lines before added ones", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { op: "same", text: "a" }, { op: "removed", text: "b" }, { op: "added", text: "x" }, { op: "same", text: "c" },
    ]);
  });

  it("skillVersionRows gives a null change when the previous version has no pass rate", () => {
    const v = (version: number, folder_hash: string) => ({ version, folder_hash, created_at: `2026-11-2${version}T00:00:00.000Z` });
    const run = (id: string, skill_version: string | null, pass_rate: number | null) => ({ id, started_at: "2026-11-25T00:00:00.000Z" as Timestamp, skill_version, pass_rate });
    const rows = skillVersionRows([v(1, "h1"), v(2, "h2")], [run("r2", "h2", 0.5)]);
    expect(rows.map((r) => [r.version, r.current, r.pass_rate, r.change])).toEqual([[2, true, 0.5, null], [1, false, null, null]]);
  });
});
