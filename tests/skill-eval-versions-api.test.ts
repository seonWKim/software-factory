import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLAGGING, OWNER, diffPath, get, setup, versionsPath } from "./helpers/classifier.js";


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

describe("GET /api/v1/evals/<skill>/versions", () => {
  it("eval runs on v1 and v2 show both pass rates, with v2 marked current", async () => {
    const { store, skill, run, h1, h2 } = await setup(tmp);
    const r1 = await run(h1);
    const r2 = await run();
    const res = await get(store, versionsPath(skill));
    expect(res.status).toBe(200);
    const { versions } = res.value as { versions: Record<string, unknown>[] };
    expect(versions.find((v) => v.version === 2)).toMatchObject({ folder_hash: h2, current: true, run_id: r2.id, pass_rate: 1 });
    expect(versions.find((v) => v.version === 1)).toMatchObject({ folder_hash: h1, current: false, run_id: r1.id, pass_rate: 0.5 });
  });

  it("gives each version's 95% band, its cost per run and each case's verdict, from its newest linked run", async () => {
    const { store, skill, run, h1, h2 } = await setup(tmp);
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
    const { store, skill, run } = await setup(tmp);
    await run();
    const { versions } = (await get(store, versionsPath(skill))).value as { versions: { version: number; band: unknown; cost_usd: unknown; cases: unknown[] }[] };
    expect(versions.find((v) => v.version === 1)).toMatchObject({ band: null, cost_usd: null, cases: [] });
    await store.db.run("UPDATE controller_skill_eval_replays SET case_id = 'LEAK-case' WHERE case_id = 'c1'");
    const leaked = await get(store, versionsPath(skill), FLAGGING);
    expect(JSON.stringify(leaked.value)).not.toContain("LEAK");
  });

  it("marks the version the gate makes current: a pending, held or rejected newest version is not; an approved one is", async () => {
    const { store, skill, run, h1 } = await setup(tmp);
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
    const { store, skill, run, h1 } = await setup(tmp);
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
    const { store, skill, run, h2 } = await setup(tmp);
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
    const { store, skill } = await setup(tmp);
    expect((await get(store, versionsPath(skill))).value).toEqual({ versions: [], unlinked: [] });
  });
});

describe("GET /api/v1/evals/<skill>/diff", () => {
  it("returns the changed lines between two versions, unified, with per-case results", async () => {
    const { store, skill, run, h1, h2 } = await setup(tmp);
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

  it("tallies the second version's wins, losses and ties over the first on their paired cases, with the paired verdict", async () => {
    const { store, skill, run, h1, h2 } = await setup(tmp);
    await run(h1);
    await run();
    // c2 failed on v1 and passed on v2 (a win), c1 passed on both (a tie): one win is within noise.
    expect((await get(store, diffPath(skill, h1, h2))).value).toMatchObject({ wins: 1, losses: 0, ties: 1, verdict: "within noise" });
    expect((await get(store, diffPath(skill, h2, h1))).value).toMatchObject({ wins: 0, losses: 1, ties: 1, verdict: "within noise" });
  });

  it("answers 404 for a hash that is no version of the skill and 400 without both hashes", async () => {
    const { store, skill, run, h1 } = await setup(tmp);
    await run();
    expect((await get(store, diffPath(skill, h1, "0".repeat(64)))).status).toBe(404);
    expect((await get(store, `/api/v1/evals/${encodeURIComponent(skill)}/diff?a=${h1}`)).status).toBe(400);
  });

  it("sends every line of text through the Withholder", async () => {
    const { store, skill, run, h1, h2 } = await setup(tmp);
    await run();
    await store.db.run("UPDATE ext_skill_versions SET text = ? WHERE folder_hash = ?", ["# Review helper\nLEAK secret\n", h1]);
    const { lines } = (await get(store, diffPath(skill, h1, h2), FLAGGING)).value as { lines: { text: string }[] };
    expect(lines.map((l) => l.text).join("\n")).not.toContain("LEAK");
  });
});
