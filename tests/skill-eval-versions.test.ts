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
  // Both gates passed (design 07-self-improvement): v2 is the gate's current version.
  await store.db.run("UPDATE controller_skill_version_gates SET state = 'passed' WHERE ref_id = 'sr_review'");
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

  it("gives each version's 95% band, its cost per run and each case's verdict, from its newest linked run", async () => {
    const { store, skill, run, h1, h2 } = await setup();
    await run(h1);
    const r2 = await run();
    await store.db.run("UPDATE controller_skill_eval_replays SET cost_usd = 0.25 WHERE run_id = ?", [r2.id]);
    const { versions } = (await get(store, versionsPath(skill))).value as { versions: { version: number; band: { low: number; high: number } | null; cost_usd: number | null; cases: { case_id: string; verdict: string }[] }[] };
    const v1 = versions.find((v) => v.version === 1)!, v2 = versions.find((v) => v.version === 2)!;
    expect(v2.cost_usd).toBe(0.5);
    expect(v2.cases).toEqual([{ case_id: "c1", verdict: "pass" }, { case_id: "c2", verdict: "pass" }]);
    expect(v1.cases).toEqual([{ case_id: "c1", verdict: "pass" }, { case_id: "c2", verdict: "fail" }]);
    // A run with no recorded cost has none; the band brackets the pass rate (1 of 2 replays passed for v1).
    expect(v1.cost_usd).toBeNull();
    expect(v1.band!.low).toBeLessThan(0.5);
    expect(v1.band!.high).toBeGreaterThan(0.5);
    expect(v2.band!.high).toBe(1);
  });

  it("gives a version with no linked run no band, no cost and no cases, and sends the case IDs through the Withholder", async () => {
    const { store, skill, run } = await setup();
    await run();
    const { versions } = (await get(store, versionsPath(skill))).value as { versions: { version: number; band: unknown; cost_usd: unknown; cases: unknown[] }[] };
    expect(versions.find((v) => v.version === 1)).toMatchObject({ band: null, cost_usd: null, cases: [] });
    await store.db.run("UPDATE controller_skill_eval_replays SET case_id = 'LEAK-case' WHERE case_id = 'c1'");
    const leaked = await get(store, versionsPath(skill), FLAGGING);
    expect(JSON.stringify(leaked.value)).not.toContain("LEAK");
  });

  it("marks the version the gate makes current: a pending, held or rejected newest version is not; an approved one is", async () => {
    const { store, skill, run, h1 } = await setup();
    await run(h1);
    await run();
    const marks = async () => ((await get(store, versionsPath(skill))).value as { versions: { version: number; gate: string | null; current: boolean }[] }).versions.map((v) => [v.version, v.gate, v.current]);
    for (const state of ["pending", "held", "rejected"]) {
      await store.db.run("UPDATE controller_skill_version_gates SET state = ? WHERE ref_id = 'sr_review' AND version = 2", [state]);
      expect(await marks(), state).toEqual([[2, state, false], [1, "passed", true]]);
    }
    await store.db.run("UPDATE controller_skill_version_gates SET state = 'held' WHERE ref_id = 'sr_review' AND version = 2");
    expect(await store.settleSkillVersionGate("sr_review", 2, "passed", OWNER)).toBe(true);
    expect(await marks()).toEqual([[2, "passed", true], [1, "passed", false]]);
    // A version recorded before the gate has no gate row and is current when nothing newer passed.
    await store.db.run("DELETE FROM controller_skill_version_gates WHERE ref_id = 'sr_review' AND version = 1");
    await store.db.run("UPDATE controller_skill_version_gates SET state = 'rejected' WHERE ref_id = 'sr_review' AND version = 2");
    expect(await marks()).toEqual([[2, "rejected", false], [1, null, true]]);
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

  it("skillVersionRows marks the newest version whose gate passed or that has no gate, and no version when none is", () => {
    const v = (version: number, gate: "pending" | "held" | "passed" | "rejected" | null) => ({ version, folder_hash: `h${version}`, created_at: "2026-11-25T00:00:00.000Z", gate });
    const current = (vs: ReturnType<typeof v>[]) => skillVersionRows(vs, []).filter((r) => r.current).map((r) => r.version);
    expect(current([v(1, null), v(2, "passed"), v(3, "held")])).toEqual([2]);
    expect(current([v(1, "passed"), v(2, "rejected"), v(3, "pending")])).toEqual([1]);
    expect(current([v(1, null), v(2, "held")])).toEqual([1]);
    expect(current([v(1, "held"), v(2, "pending")])).toEqual([]);
  });
});

// Versioned skill-eval runs (design 06-measurement): each new run stores its suite, judge and factory versions beside
// its skill version and figures; a case add, edit or delete gives the suite its next version in the same transaction,
// and a run keeps the suite version it started with. A run stored before keeps null: no backfill.

const FIGURES = { model_class: "standard", judge_model_class: "strong", replays: 1, pass_rate: 1, errored: 0 };

type Store = Awaited<ReturnType<typeof newStore>>["store"];
const suiteVersion = async (store: Store, id: string) => Number((await store.db.all("SELECT version FROM controller_skill_eval_suites WHERE id = ?", [id]))[0]!.version);

async function withSuite() {
  const { store } = await newStore();
  await store.createSkillEvalSuite({ id: "s1", skill_ref: "skills/a", title: "A", created_by: OWNER });
  await store.createSkillEvalSuite({ id: "s2", skill_ref: "skills/b", title: "B", created_by: OWNER });
  return store;
}

describe("a run's versions", () => {
  it("stores suite_version, judge_version and factory_version beside skill_version, model_class and judge_model_class", async () => {
    const store = await withSuite();
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "sk1", judge_version: "j1", factory_version: "rev1" });
    await store.finishSkillEvalRun("r1", "passed");
    await store.recordSkillEvalRunFigures("r1", FIGURES);
    expect(await store.getSkillEvalRun("r1")).toMatchObject({
      skill_version: "sk1", suite_version: await suiteVersion(store, "s1"), judge_version: "j1", factory_version: "rev1", model_class: "standard", judge_model_class: "strong",
    });
    expect((await store.listSkillEvalRuns("skills/a"))[0]).toMatchObject({ suite_version: await suiteVersion(store, "s1"), judge_version: "j1", factory_version: "rev1" });
  });

  it("keeps null in each version on a run stored before them, with no backfill", async () => {
    const store = await withSuite();
    await store.db.run("INSERT INTO controller_skill_eval_runs (id, suite_id, status, started_at, created_by) VALUES ('old', 's1', 'passed', 't', ?)", [OWNER]);
    await store.startSkillEvalRun({ id: "new", suite_id: "s1", created_by: OWNER, judge_version: "j1", factory_version: "dev" });
    await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "x", expected: "y" });
    expect(await store.getSkillEvalRun("old")).toMatchObject({ suite_version: null, judge_version: null, factory_version: null });
  });
});

describe("a suite's version", () => {
  it("goes to the next version on each case add, edit and delete, and only for that case's suite", async () => {
    const store = await withSuite();
    const start = await suiteVersion(store, "s1");
    const other = await suiteVersion(store, "s2");
    await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "x", expected: "y" });
    expect(await suiteVersion(store, "s1")).toBe(start + 1);
    await store.updateSkillEvalCase("c1", { input: "x2", expected: "y2" });
    expect(await suiteVersion(store, "s1")).toBe(start + 2);
    expect(await store.deleteSkillEvalCase("c1")).toBe(true);
    expect(await suiteVersion(store, "s1")).toBe(start + 3);
    expect(await suiteVersion(store, "s2")).toBe(other);
  });

  it("is unchanged by a repeated add, or an edit or delete of an unknown case", async () => {
    const store = await withSuite();
    await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "x", expected: "y" });
    const v = await suiteVersion(store, "s1");
    await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "x", expected: "y" });
    expect(await store.updateSkillEvalCase("nope", { input: 1, expected: 2 })).toBeNull();
    expect(await store.deleteSkillEvalCase("nope")).toBe(false);
    expect(await suiteVersion(store, "s1")).toBe(v);
  });

  it("a run keeps the suite version it started with after a case changes", async () => {
    const store = await withSuite();
    await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "x", expected: "y" });
    const before = await suiteVersion(store, "s1");
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER, judge_version: "j1", factory_version: "dev" });
    await store.updateSkillEvalCase("c1", { input: "x2", expected: "y" });
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER, judge_version: "j1", factory_version: "dev" });
    await store.startSkillEvalRun({ id: "r2", suite_id: "s1", created_by: OWNER, judge_version: "j1", factory_version: "dev" });
    expect((await store.getSkillEvalRun("r1"))!.suite_version).toBe(before);
    expect((await store.getSkillEvalRun("r2"))!.suite_version).toBe(before + 1);
  });
});
