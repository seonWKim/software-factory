// The new-version gate of an imported skill (design 07-self-improvement, src/core/skill-eval-gate.ts): a gate row in
// pending written with each new version, the gate pass (3 replays per case, paired with the current version's latest
// run on the same model class: only a paired verdict worse holds; runs that are not comparable pass), the held state with the cases that fell and one owner question, the 30-minute lease
// and its token, and versions recorded before the gate. The store is the real SQLite store; the suite run is a fake
// that stores a run with the verdicts it is given: no test calls a model.

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATE_LEASE_MS, GATE_REPLAYS, type SkillGateWiring, runSkillVersionGates } from "../src/core/skill-eval-gate.js";
import type { Timestamp, UserId } from "../src/core/types.js";
import type { FakeClock } from "../src/impl/clock/fake-clock.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { importItem, skillRefId } from "../src/import/import-plugins.js";
import type { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { gateWiring } from "../src/skill-evals.js";
import { settleHeldSkillVersion } from "../src/core/commands.js";
import { alarmCommand } from "../src/ui/alarms.js";
import { cleanScanner } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

const OWNER = "local:owner" as UserId;
const REF = "sr_a";
const SKILL = "skills/a";
const SUITE = "suite:a";
const MIN = 60_000;
const iso = (clock: FakeClock, plus = 0) => new Date(clock.now().getTime() + plus).toISOString() as Timestamp;

type Verdicts = Record<string, readonly ("pass" | "fail")[]>;

/** The judge version every run records unless a test names another (null: none recorded). */
const JUDGE = "j1";

/** A stored, finished run of the suite on `version` with these verdicts per case (one replay each), and its figures. */
async function storedRun(store: SqlFactoryStore, clock: FakeClock, r: { id: string; version: string; model_class: string; verdicts: Verdicts; judge_version?: string | null }) {
  clock.advance(1000);
  await store.startSkillEvalRun({ id: r.id, suite_id: SUITE, created_by: OWNER, skill_version: r.version, judge_version: r.judge_version === undefined ? JUDGE : r.judge_version });
  const all = Object.entries(r.verdicts).flatMap(([case_id, vs]) => vs.map((verdict, i) => ({ case_id, verdict, replay: i + 1 })));
  for (const v of all) await store.recordSkillEvalReplay({ run_id: r.id, case_id: v.case_id, verdict: v.verdict, detail: {}, replay: v.replay });
  await store.finishSkillEvalRun(r.id, "passed");
  const passed = all.filter((v) => v.verdict === "pass").length;
  await store.recordSkillEvalRunFigures(r.id, { model_class: r.model_class, judge_model_class: "strong", replays: all.length, pass_rate: all.length ? passed / all.length : null, errored: 0 });
  return (await store.getSkillEvalRun(r.id))!;
}

/** A version row written as before the gate: no gate row. */
async function oldVersion(store: SqlFactoryStore, version: number, folder_hash: string) {
  await store.db.run("INSERT INTO ext_skill_versions (ref_id, version, folder_hash, text, source, created_at) VALUES (?, ?, ?, 'old text', 'claude', 't')", [REF, version, folder_hash]);
}

async function setup() {
  const { store, clock } = await newStore();
  await store.createSkillEvalSuite({ id: SUITE, skill_ref: SKILL, title: "a", created_by: OWNER });
  return { store, clock };
}

/** The fake wiring: the suite of REF is SKILL (or none), and each gate run stores a run with `verdicts` replayed per case. */
function fakeWiring(store: SqlFactoryStore, clock: FakeClock, o: { suite?: string | null; verdicts?: Verdicts; run?: "none" | "throw"; during?: () => Promise<void> } = {}) {
  const runs: Parameters<SkillGateWiring["run"]>[0][] = [];
  let n = 0;
  const wiring: SkillGateWiring = {
    newToken: () => `tok${++n}`,
    suiteOf: async (ref) => (ref === REF ? (o.suite === undefined ? SKILL : o.suite) : null),
    run: async (r) => {
      runs.push(r);
      await o.during?.();
      if (o.run === "throw") throw new Error("sandbox down");
      if (o.run === "none") return null;
      const verdicts = Object.fromEntries(Object.entries(o.verdicts ?? { c1: ["pass"] }).map(([c, vs]) => [c, Array.from({ length: r.replays }, (_, i) => vs[i % vs.length]!)]));
      return storedRun(store, clock, { id: `gate${++n}`, version: r.folder_hash, model_class: r.model_class, verdicts });
    },
  };
  return { wiring, runs };
}

const pass = (store: SqlFactoryStore, clock: FakeClock, wiring: SkillGateWiring) =>
  runSkillVersionGates({ store, scanner: cleanScanner, clock, wiring, signal: new AbortController().signal });

describe("skill version gate: the gate row", () => {
  it("a new version is stored with its gate row in pending, in the same transaction as its version row", async () => {
    const { store } = await setup();
    const v = await store.recordSkillVersion({ ref_id: REF, folder_hash: "h1", text: "A", source: "claude" });
    expect(v).toMatchObject({ version: 1 });
    expect(await store.getSkillVersionGate(REF, 1)).toMatchObject({ ref_id: REF, version: 1, state: "pending", lease_token: null, lease_until: null, run_id: null });
    // A gate row that cannot be written rolls the version back: both are one transaction.
    await store.db.run("INSERT INTO controller_skill_version_gates (ref_id, version, state, detail, created_at, updated_at) VALUES (?, 2, 'passed', '{}', 't', 't')", [REF]);
    await expect(store.recordSkillVersion({ ref_id: REF, folder_hash: "h2", text: "B", source: "claude" })).rejects.toThrow();
    expect((await store.listSkillVersions(REF)).map((x) => x.folder_hash)).toEqual(["h1"]);
    // An unchanged hash writes neither.
    expect(await store.recordSkillVersion({ ref_id: REF, folder_hash: "h1", text: "A", source: "claude" })).toBeNull();
  });

  it("the plugin import writes the gate row of the version it records", async () => {
    const { store, clock } = await setup();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "sf-gate-")));
    const path = join(home, "skills", "a", "SKILL.md");
    mkdirSync(join(home, "skills", "a"), { recursive: true });
    writeFileSync(path, "# A\n");
    const item = { kind: "skill" as const, source: "claude", name: "a", path, sha256: "x" };
    await importItem({ db: storeSql(store), now: () => clock.now().toISOString(), scanner: cleanScanner, added_by: OWNER }, item, new Set());
    expect(await store.getSkillVersionGate(skillRefId(item), 1)).toMatchObject({ state: "pending" });
  });

  it("only gates in five states are stored", async () => {
    const { store } = await setup();
    for (const [i, state] of ["pending", "running", "passed", "held", "rejected"].entries()) {
      await store.db.run("INSERT INTO controller_skill_version_gates (ref_id, version, state, detail, created_at, updated_at) VALUES ('r', ?, ?, '{}', 't', 't')", [i + 1, state]);
    }
    await expect(store.db.run("INSERT INTO controller_skill_version_gates (ref_id, version, state, detail, created_at, updated_at) VALUES ('r', 99, 'current', '{}', 't', 't')")).rejects.toThrow();
  });
});

describe("skill version gate: the current version", () => {
  it("is current only with no gate row or a passed gate; pending, running, held and rejected are not", async () => {
    const { store } = await setup();
    await oldVersion(store, 1, "h1");
    await store.recordSkillVersion({ ref_id: REF, folder_hash: "h2", text: "B", source: "claude" });
    expect((await store.currentSkillVersion(REF))?.version).toBe(1);
    for (const state of ["running", "held", "rejected"]) {
      await store.db.run("UPDATE controller_skill_version_gates SET state = ? WHERE ref_id = ? AND version = 2", [state, REF]);
      expect((await store.currentSkillVersion(REF))?.version, state).toBe(1);
    }
    await store.db.run("UPDATE controller_skill_version_gates SET state = 'passed' WHERE ref_id = ? AND version = 2", [REF]);
    expect((await store.currentSkillVersion(REF))?.version).toBe(2);
    expect((await store.currentSkillVersion(REF, 2))?.version).toBe(1);
    expect(await store.currentSkillVersion("sr_none")).toBeNull();
  });
});

describe("skill version gate: the owner's settle of a held version", () => {
  it("a bare /approve passes the newest held version of any skill, so it is current; /reject keeps the earlier one current", async () => {
    const { store, clock } = await setup();
    await oldVersion(store, 1, "h1");
    for (const hash of ["h2", "h3"]) {
      clock.advance(1000);
      const v = (await store.recordSkillVersion({ ref_id: REF, folder_hash: hash, text: hash, source: "claude" }))!;
      await store.db.run("UPDATE controller_skill_version_gates SET state = 'held' WHERE ref_id = ? AND version = ?", [REF, v.version]);
    }
    expect(await settleHeldSkillVersion(store, "reject", OWNER)).toMatchObject({ gate: { ref_id: REF, version: 3 }, settled: true });
    expect((await store.currentSkillVersion(REF))?.version).toBe(1);
    expect(await settleHeldSkillVersion(store, "approve", OWNER)).toMatchObject({ gate: { ref_id: REF, version: 2 }, settled: true });
    expect((await store.currentSkillVersion(REF))?.version).toBe(2);
    expect(await store.getSkillVersionGate(REF, 3)).toMatchObject({ state: "rejected" });
    // Nothing held: null, and the caller keeps its item-ID refusal.
    expect(await settleHeldSkillVersion(store, "approve", OWNER)).toBeNull();
  });

  it("the held version's owner question names the bare approve and reject", () => {
    const step = alarmCommand({ id: "a1", pattern: "skill_version_gate", pattern_key: `skill_version_gate:${REF}:2`, error_code: "pass_rate_drop", count: 2, detail: "", created_at: "t" as Timestamp });
    expect(step).toContain("factory approve");
    expect(step).toContain("factory reject");
  });
});

describe("skill version gate: the gate pass", () => {
  it("runs the suite with 3 replays per case and compares with the current version's latest run on the same model class", async () => {
    const { store, clock } = await setup();
    await oldVersion(store, 1, "h1");
    await storedRun(store, clock, { id: "old-cheap", version: "h1", model_class: "cheap", verdicts: { c1: ["fail"] } });
    await storedRun(store, clock, { id: "std", version: "h1", model_class: "standard", verdicts: { c1: ["fail"] } });
    await storedRun(store, clock, { id: "latest-cheap", version: "h1", model_class: "cheap", verdicts: { c1: ["pass"], c2: ["pass"] } });
    await store.recordSkillVersion({ ref_id: REF, folder_hash: "h2", text: "B", source: "claude" });
    const f = fakeWiring(store, clock, { verdicts: { c1: ["pass"], c2: ["pass"] } });

    expect(await pass(store, clock, f.wiring)).toEqual([{ ref_id: REF, version: 2, state: "passed", reason: "within_noise" }]);
    expect(GATE_REPLAYS).toBe(3);
    expect(f.runs).toEqual([expect.objectContaining({ skill_ref: SKILL, folder_hash: "h2", replays: 3, model_class: "cheap" })]);
    const gate = (await store.getSkillVersionGate(REF, 2))!;
    expect(gate).toMatchObject({ state: "passed", lease_token: null, lease_until: null, run_id: "gate2" });
    expect(gate.detail).toMatchObject({ reason: "within_noise", pass_rate: 1, model_class: "cheap", current: { version: 1, run_id: "latest-cheap", pass_rate: 1 } });
    expect((await store.listSkillEvalReplays("gate2")).filter((r) => r.case_id === "c1")).toHaveLength(3);
    expect((await store.currentSkillVersion(REF))?.version).toBe(2);
  });

  it("a skill with no suite passes with no run; a run with no pass rate puts the gate back to pending", async () => {
    const { store, clock } = await setup();
    await store.recordSkillVersion({ ref_id: REF, folder_hash: "h1", text: "A", source: "claude" });
    const none = fakeWiring(store, clock, { run: "none" });
    expect(await pass(store, clock, none.wiring)).toEqual([{ ref_id: REF, version: 1, state: "pending", reason: "no_pass_rate" }]);
    expect(await store.getSkillVersionGate(REF, 1)).toMatchObject({ state: "pending", lease_token: null });
    const thrown = fakeWiring(store, clock, { run: "throw" });
    expect((await pass(store, clock, thrown.wiring))[0]).toMatchObject({ state: "pending" });

    const noSuite = fakeWiring(store, clock, { suite: null });
    expect(await pass(store, clock, noSuite.wiring)).toEqual([{ ref_id: REF, version: 1, state: "passed", reason: "no_suite" }]);
    expect(noSuite.runs).toEqual([]);
    expect(await store.getSkillVersionGate(REF, 1)).toMatchObject({ state: "passed", run_id: null, detail: { reason: "no_suite" } });
  });

  it("a first version, with no current version to compare with, passes on its run", async () => {
    const { store, clock } = await setup();
    await store.recordSkillVersion({ ref_id: REF, folder_hash: "h1", text: "A", source: "claude" });
    const f = fakeWiring(store, clock);
    expect(await pass(store, clock, f.wiring)).toEqual([{ ref_id: REF, version: 1, state: "passed", reason: "no_baseline" }]);
    expect(f.runs).toEqual([expect.objectContaining({ model_class: "standard", replays: 3 })]);
  });

  it("a significant paired drop over six non-tied cases holds the version, names each case that fell and raises one owner question", async () => {
    const { store, clock } = await setup();
    await oldVersion(store, 1, "h1");
    const all = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"];
    await storedRun(store, clock, { id: "base", version: "h1", model_class: "standard", verdicts: Object.fromEntries(all.map((c) => [c, ["pass"]])) });
    await store.recordSkillVersion({ ref_id: REF, folder_hash: "h2", text: "B", source: "claude" });
    // c6..c1 fall (two of them only part way), c7 ties: 0 wins, 6 losses, p = 0.03125, the interval below zero.
    const f = fakeWiring(store, clock, { verdicts: { c6: ["fail"], c5: ["pass", "fail", "fail"], c4: ["fail"], c3: ["fail"], c2: ["pass", "fail", "fail"], c1: ["fail"], c7: ["pass"] } });

    expect(await pass(store, clock, f.wiring)).toEqual([{ ref_id: REF, version: 2, state: "held", reason: "dropped" }]);
    const gate = (await store.getSkillVersionGate(REF, 2))!;
    expect(gate).toMatchObject({
      state: "held", lease_token: null,
      detail: { reason: "dropped", verdict: "worse", wins: 0, losses: 6, ties: 1, fell: ["c1", "c2", "c3", "c4", "c5", "c6"], current: { version: 1, run_id: "base" } },
    });
    const paired = gate.detail as { p_value: number; interval: { high: number } };
    expect(paired.p_value).toBeLessThan(0.05);
    expect(paired.interval.high).toBeLessThan(0);
    expect((await store.currentSkillVersion(REF))?.version).toBe(1);
    const alerts = await store.listAlerts({ limit: 10 });
    expect(alerts).toEqual([expect.objectContaining({ pattern: "skill_version_gate", pattern_key: `skill_version_gate:${REF}:2`, count: 2 })]);
    expect(alerts[0]!.detail).toContain("paired verdict is worse");
    expect(alerts[0]!.detail).toContain("c1, c2, c3, c4, c5, c6.");
    // A held gate is not taken again: no second run and no second question.
    expect(await pass(store, clock, f.wiring)).toEqual([]);
    expect(f.runs).toHaveLength(1);
    expect(await store.listAlerts({ limit: 10 })).toHaveLength(1);
  });

  it("a small drop that is within noise passes with the paired figures and raises no question", async () => {
    const { store, clock } = await setup();
    await oldVersion(store, 1, "h1");
    await storedRun(store, clock, { id: "base", version: "h1", model_class: "standard", verdicts: { c1: ["pass"], c2: ["pass"], c3: ["fail"] } });
    await store.recordSkillVersion({ ref_id: REF, folder_hash: "h2", text: "B", source: "claude" });
    // Pass rate 0.666 → 0.333: c2 falls, but one loss is within noise.
    const f = fakeWiring(store, clock, { verdicts: { c1: ["pass"], c2: ["fail"], c3: ["fail"] } });

    expect(await pass(store, clock, f.wiring)).toEqual([{ ref_id: REF, version: 2, state: "passed", reason: "within_noise" }]);
    const gate = (await store.getSkillVersionGate(REF, 2))!;
    expect(gate.detail).toMatchObject({ reason: "within_noise", verdict: "within noise", wins: 0, losses: 1, p_value: 1, current: { version: 1, run_id: "base" } });
    expect(gate.detail).toHaveProperty("mean_difference");
    expect(gate.detail).toHaveProperty("interval");
    expect(await store.listAlerts({ limit: 10 })).toEqual([]);
    expect((await store.currentSkillVersion(REF))?.version).toBe(2);
  });

  for (const [name, judge_version, why] of [
    ["different judge versions", "j2", "the judge versions differ"],
    ["no version recorded", null, "one run has no version recorded"],
  ] as const) {
    it(`runs with ${name} are not comparable: even a large drop passes with reason not_comparable and raises no question`, async () => {
      const { store, clock } = await setup();
      await oldVersion(store, 1, "h1");
      const all = ["c1", "c2", "c3", "c4", "c5", "c6"];
      await storedRun(store, clock, { id: "base", version: "h1", model_class: "standard", judge_version, verdicts: Object.fromEntries(all.map((c) => [c, ["pass"]])) });
      await store.recordSkillVersion({ ref_id: REF, folder_hash: "h2", text: "B", source: "claude" });
      const f = fakeWiring(store, clock, { verdicts: Object.fromEntries(all.map((c) => [c, ["fail"]])) });

      expect(await pass(store, clock, f.wiring)).toEqual([{ ref_id: REF, version: 2, state: "passed", reason: "not_comparable" }]);
      expect((await store.getSkillVersionGate(REF, 2))!.detail).toMatchObject({ reason: "not_comparable", not_comparable: why, pass_rate: 0, current: { version: 1, run_id: "base", pass_rate: 1 } });
      expect(await store.listAlerts({ limit: 10 })).toEqual([]);
    });
  }
});

describe("skill version gate: lease and token", () => {
  it("a gate in running whose 30-minute lease has ended is taken again by the next pass, by a conditional update", async () => {
    const { store, clock } = await setup();
    await store.recordSkillVersion({ ref_id: REF, folder_hash: "h1", text: "A", source: "claude" });
    // A holder took it and stopped.
    expect(await store.takeSkillVersionGate({ ref_id: REF, version: 1, lease_token: "dead", now: iso(clock), lease_until: iso(clock, GATE_LEASE_MS) })).toBe(true);
    expect(GATE_LEASE_MS).toBe(30 * MIN);
    const f = fakeWiring(store, clock, { suite: null });
    clock.advance(29 * MIN);
    expect(await pass(store, clock, f.wiring)).toEqual([]);
    expect(await store.getSkillVersionGate(REF, 1)).toMatchObject({ state: "running", lease_token: "dead" });

    clock.advance(MIN);
    // Two takers at once: one conditional update wins.
    const takes = await Promise.all(["a", "b"].map((lease_token) => store.takeSkillVersionGate({ ref_id: REF, version: 1, lease_token, now: iso(clock), lease_until: iso(clock, GATE_LEASE_MS) })));
    expect(takes.filter(Boolean)).toHaveLength(1);
    const winner = takes[0] ? "a" : "b";
    expect(await store.getSkillVersionGate(REF, 1)).toMatchObject({ state: "running", lease_token: winner, lease_until: iso(clock, GATE_LEASE_MS) });

    clock.advance(GATE_LEASE_MS);
    expect(await pass(store, clock, f.wiring)).toEqual([{ ref_id: REF, version: 1, state: "passed", reason: "no_suite" }]);
  });

  it("a finished gate writes its state only while it holds its lease token; a late holder writes nothing", async () => {
    const { store, clock } = await setup();
    await oldVersion(store, 1, "h1");
    await storedRun(store, clock, { id: "base", version: "h1", model_class: "standard", verdicts: { c1: ["pass"] } });
    await store.recordSkillVersion({ ref_id: REF, folder_hash: "h2", text: "B", source: "claude" });
    // The pass's run outlives its lease; another holder takes the gate and passes it meanwhile.
    const during = async () => {
      clock.advance(GATE_LEASE_MS);
      expect(await store.takeSkillVersionGate({ ref_id: REF, version: 2, lease_token: "other", now: iso(clock), lease_until: iso(clock, GATE_LEASE_MS) })).toBe(true);
      expect(await store.finishSkillVersionGate({ ref_id: REF, version: 2, lease_token: "other", state: "passed", run_id: null, detail: { reason: "by_other" } })).toBe(true);
    };
    const f = fakeWiring(store, clock, { verdicts: { c1: ["fail"] }, during });

    expect(await pass(store, clock, f.wiring)).toEqual([{ ref_id: REF, version: 2, state: "lost", reason: "within_noise" }]);
    expect(await store.getSkillVersionGate(REF, 2)).toMatchObject({ state: "passed", run_id: null, detail: { reason: "by_other" } });
    expect(await store.listAlerts({ limit: 10 })).toEqual([]);
    // A finish under a token that never held it writes nothing either.
    expect(await store.finishSkillVersionGate({ ref_id: REF, version: 2, lease_token: "other", state: "held", run_id: null, detail: {} })).toBe(false);
  });
});

describe("skill version gate: versions recorded before it", () => {
  it("a version with no gate row stays current, starts no gate run and is not backfilled", async () => {
    const { store, clock } = await setup();
    await oldVersion(store, 1, "h1");
    await oldVersion(store, 2, "h2");
    const f = fakeWiring(store, clock);
    expect(await pass(store, clock, f.wiring)).toEqual([]);
    expect(f.runs).toEqual([]);
    expect(await store.db.all("SELECT ref_id FROM controller_skill_version_gates")).toEqual([]);
    expect((await store.currentSkillVersion(REF))?.version).toBe(2);
  });
});

describe("skill version gate: the wiring", () => {
  it("finds the suite whose skill_ref resolves to the imported skill's folder", async () => {
    const { store } = await setup();
    const paths: Record<string, string> = { [REF]: "/repo/skills/a/SKILL.md", sr_other: "/repo/skills/b/SKILL.md" };
    const w = gateWiring({ store, root: "/repo", newId: () => "id" } as unknown as Parameters<typeof gateWiring>[0], async (id) => paths[id] ?? null);
    expect(await w.suiteOf(REF)).toBe(SKILL);
    expect(await w.suiteOf("sr_other")).toBeNull();
    expect(await w.suiteOf("sr_none")).toBeNull();
  });
});
