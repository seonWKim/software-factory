import { describe, expect, it } from "vitest";
import { enqueueImprove } from "../src/core/improver.js";
import { LEARN_MIN_FAILURES, StoredLearnedSettings, learnFromReport, tighterLimit } from "../src/core/learned-settings.js";
import { diffGates } from "../src/core/pre-push.js";
import { LiveSettings, type SettingsLayers, baseFromConfig, settingValues, settingsFor } from "../src/core/settings.js";
import type { FactoryConfig } from "../src/core/config.js";
import type { RunId, Timestamp, WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { AgentRunner } from "../src/interfaces/agent-runner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { type SettingsDeps, parseSettingsArgs, runSettings } from "../src/settings-cmd.js";
import { Worker } from "../src/worker/index.js";
import { FakeBroker, FakeSandbox, MemoryStorage, PROJECT, cleanScanner, config, prompts, silent } from "./helpers/fakes.js";
import { OTHER_PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

// Issue #497: the daily improve run learns a tighter max_diff_lines per project from its stored report.

const KEY = "max_diff_lines";
const noRunner = { run: () => { throw new Error("the improve run called the agent runner"); } } as unknown as AgentRunner;

/** Fails a triage run of a new item `n` (in `project`) with `code`. */
async function failRun(store: FactoryStore, n: number, code: string, project = PROJECT.key): Promise<RunId> {
  await store.createWorkItem({ ...issue(n), project }, system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
  const run = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: ["triage"], lease_ms: 60_000 }))!;
  await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: code, detail: "the diff changes 2000 lines", infra: false });
  return run.id;
}

/** `tooLarge` diff_too_large failures (and `other` of another project) on 2026-03-04, then that window's improve run queued. */
async function world(tooLarge: number, o: { other?: number; trigger?: "daily" | "manual"; settings?: SettingsLayers } = {}) {
  const clock = new FakeClock("2026-03-04T01:00:00.000Z");
  const { store } = await newStore(clock);
  const ids: RunId[] = [];
  let n = 0;
  for (let i = 0; i < tooLarge; i++) {
    clock.advance(1_000);
    ids.push(await failRun(store, ++n, "diff_too_large"));
  }
  for (let i = 0; i < (o.other ?? 0); i++) {
    clock.advance(1_000);
    await failRun(store, ++n, "diff_too_large", OTHER_PROJECT_KEY);
  }
  clock.set("2026-03-05T06:00:00.000Z");
  const { run } = await enqueueImprove({ store, clock }, PROJECT.key, o.trigger ?? "daily");
  const cfg: FactoryConfig = { ...config, settings: o.settings ?? config.settings };
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner: noRunner, broker: new FakeBroker(), storage: new MemoryStorage(), clock, config: cfg,
    prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  return { clock, store, ids, run, cfg, worker };
}

async function learned(store: FactoryStore) {
  const source = new StoredLearnedSettings(store);
  await source.refresh();
  return source;
}

describe("the learner in the daily improve run", () => {
  it(`${LEARN_MIN_FAILURES} diff_too_large failures: one learned max_diff_lines, 80% of the value in force, with one audit row`, async () => {
    const w = await world(3);
    const before = settingsFor(PROJECT.key, w.cfg.settings, await learned(w.store)).max_diff_lines;
    expect(await w.worker.tick()).toBe(true);
    const value = (await w.store.getLearnedSetting(PROJECT.key, KEY))!.value;
    expect(JSON.parse(value)).toBe(Math.floor(before.value * 0.8));
    expect(JSON.parse(value)).toBeLessThan(before.value);
    const report = (await w.store.getImproveReport(w.run.id))!;
    expect(await w.store.listLearnedSettingChanges(10)).toEqual([
      expect.objectContaining({ project: PROJECT.key, key: KEY, old_value: null, new_value: value, evidence_run_ids: w.ids, window_end: report.window_end }),
    ]);
    expect((await w.store.getRun(w.run.id))!.outcome).toMatchObject({ status: "succeeded", data: { learned: { key: KEY, new_value: value } } });
  });

  it("then settingsFor reports max_diff_lines from the learned layer, with the stored value", async () => {
    const w = await world(3);
    await w.worker.tick();
    const value = JSON.parse((await w.store.getLearnedSetting(PROJECT.key, KEY))!.value) as number;
    expect(settingsFor(PROJECT.key, w.cfg.settings, await learned(w.store)).max_diff_lines).toEqual({ value, layer: "learned" });
  });

  it("LiveSettings.refresh refreshes the learned cache", async () => {
    const w = await world(3);
    const source = new StoredLearnedSettings(w.store);
    const live = new LiveSettings({ config: w.cfg, base: baseFromConfig(w.cfg), source: w.store, learned: source });
    await live.refresh();
    expect(source.get(PROJECT.key, KEY)).toBeUndefined();
    await w.worker.tick();
    await live.refresh();
    expect(source.get(PROJECT.key, KEY)).toBe(tighterLimit(1500));
  });

  it("fewer than 3 diff_too_large failures: no learned write and no audit row", async () => {
    const w = await world(2);
    await w.worker.tick();
    expect((await w.store.getRun(w.run.id))!.status).toBe("succeeded");
    expect(await w.store.listLearnedSettings()).toEqual([]);
    expect(await w.store.listLearnedSettingChanges(10)).toEqual([]);
  });

  it("the improve run again on the same window writes no second value and no second audit row", async () => {
    const w = await world(3);
    await w.worker.tick();
    const run = (await w.store.getRun(w.run.id))!;
    const report = (await w.store.getImproveReport(run.id))!;
    expect(await learnFromReport({ store: w.store, layers: w.cfg.settings }, run, report)).toBeNull();
    expect(await w.store.listLearnedSettingChanges(10)).toHaveLength(1);
    expect((await w.store.listLearnedSettings()).map((r) => r.value)).toEqual([JSON.stringify(tighterLimit(1500))]);
  });

  it("only the daily run learns, and only after its report is stored", async () => {
    const manual = await world(3, { trigger: "manual" });
    await manual.worker.tick();
    expect(await manual.store.getImproveReport(manual.run.id)).not.toBeNull();
    expect(await manual.store.listLearnedSettingChanges(10)).toEqual([]);

    const daily = await world(3);
    const write = daily.store.setLearnedSetting.bind(daily.store);
    let reportStored: boolean | null = null;
    daily.store.setLearnedSetting = async (input) => {
      reportStored = (await daily.store.getImproveReport(daily.run.id)) !== null;
      return write(input);
    };
    await daily.worker.tick();
    expect(reportStored).toBe(true);
  });

  it("each report counts only runs of its own project", async () => {
    const w = await world(2, { other: 5 });
    await w.worker.tick();
    const report = (await w.store.getImproveReport(w.run.id))!;
    expect([...report.groups, ...report.patterns].flatMap((g) => g.run_ids).sort()).toEqual([...w.ids].sort());
    expect(await w.store.listLearnedSettingChanges(10)).toEqual([]);
  });
});

describe("the learner never loosens", () => {
  const layers = (defaults: number, project?: number): SettingsLayers => ({
    defaults: { max_diff_lines: defaults }, projects: project === undefined ? {} : { [PROJECT.key]: { max_diff_lines: project } },
  });

  it("learns from the project override when it is set, not the global value", async () => {
    const w = await world(3, { settings: layers(1500, 100) });
    await w.worker.tick();
    expect((await w.store.getLearnedSetting(PROJECT.key, KEY))?.value).toBe("80");
  });

  it("never writes a value above the value in force, even when a stored learned value is looser", async () => {
    const w = await world(3, { settings: layers(1500, 100) });
    await w.store.setLearnedSetting({
      project: PROJECT.key, key: KEY, expected: null, value: "1000", evidence_run_ids: [], window_end: "2026-03-01T00:00:00.000Z" as Timestamp, actor: "system:test",
    });
    await w.worker.tick();
    expect((await w.store.listLearnedSettingChanges(1))[0]).toMatchObject({ old_value: "1000", new_value: "80" });
  });

  it("no write when the value in force cannot get tighter (1)", async () => {
    const w = await world(3, { settings: layers(1) });
    await w.worker.tick();
    expect(await w.store.listLearnedSettingChanges(10)).toEqual([]);
  });

  it("tighterLimit is 80% rounded down, never below 1 and never above its input", () => {
    expect([1500, 101, 5, 2, 1].map(tighterLimit)).toEqual([1200, 80, 4, 1, 1]);
    for (let v = 1; v <= 200; v++) expect(tighterLimit(v)).toBeLessThanOrEqual(v);
  });
});

describe("the pre-push size gate with a learned limit", () => {
  const git = (lines: number) => async () => `${lines}\t0\tsrc/a.ts\0`;

  it("fails a branch diff over the learned limit and passes one at or under it", async () => {
    const w = await world(3);
    await w.worker.tick();
    const limits = settingValues(PROJECT.key, w.cfg.settings, await learned(w.store));
    expect(limits.max_diff_lines).toBe(1200);
    expect((await diffGates(git(1201), "base", { tier: 1 }, limits)).size).toContain("limit max_diff_lines = 1200");
    expect((await diffGates(git(1200), "base", { tier: 1 }, limits)).size).toBeNull();
    expect((await diffGates(git(900), "base", { tier: 1 }, limits)).size).toBeNull();
  });
});

describe("factory settings reset --learned", () => {
  function deps(store: FactoryStore, refusal: string | null): SettingsDeps {
    return {
      store, base: { file: {}, layers: { defaults: {}, projects: {} } }, repo: { owner: "o", name: "r" }, resolveProject: async () => PROJECT,
      actor: "local:owner", mayApproveMerge: async () => refusal,
    };
  }
  const reset = (d: SettingsDeps) => {
    const a = parseSettingsArgs(["reset", KEY, "--project", "o/r", "--learned"]);
    if ("error" in a) throw new Error(a.error);
    return runSettings(d, a);
  };

  it("is refused without approve_merge, with no row written", async () => {
    const w = await world(3);
    await w.worker.tick();
    const r = await reset(deps(w.store, "the requester role cannot approve_merge"));
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toContain("approve_merge");
    expect(await w.store.getLearnedSetting(PROJECT.key, KEY)).not.toBeNull();
    expect(await w.store.listLearnedSettingChanges(10)).toHaveLength(1);
  });

  it("with approve_merge it clears the value and writes one audit row", async () => {
    const w = await world(3);
    await w.worker.tick();
    const r = await reset(deps(w.store, null));
    expect(r.ok).toBe(true);
    expect(await w.store.getLearnedSetting(PROJECT.key, KEY)).toBeNull();
    const changes = await w.store.listLearnedSettingChanges(10);
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ project: PROJECT.key, key: KEY, new_value: null, actor: "local:owner" });
    expect(settingsFor(PROJECT.key, w.cfg.settings, await learned(w.store)).max_diff_lines.layer).not.toBe("learned");
  });

  it("needs --project; a second reset has nothing to clear", async () => {
    expect(parseSettingsArgs(["reset", KEY, "--learned"])).toEqual({ error: expect.stringContaining("--project") });
    const { store } = await newStore();
    expect((await reset(deps(store, null))).lines[0]).toContain("no learned value");
  });
});
