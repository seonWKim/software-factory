import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { STATS_MIN_SAMPLE_DEFAULT, buildStatsStore, loadConfig, statsConfig } from "../src/compose.js";
import type { StatsConfig } from "../src/core/config.js";
import { type StatsRecord, aggregateStats, collectStats, formatStatsText } from "../src/core/stats.js";
import type { Tier, UserId, VerdictSeverity, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { human, issue, newStore, system } from "./helpers/store.js";

const WEIGHTS = { none: 0, minor: 1, major: 3, critical: 10 };
const REPO_ROOT = join(import.meta.dirname, "..");

type Store = FactoryStore;

interface Seed {
  n: number;
  tier: Tier | null;
  closed: boolean;
  token_cost: number;
  reasons?: string[];
  severities?: VerdictSeverity[];
}

/** One item: tier and token_cost set, then the given reasons as state changes, then verdicts, then closed. */
async function seed(store: Store, s: Seed): Promise<WorkItemId> {
  const { item } = await store.createWorkItem({ ...issue(s.n), title: `Title of ${s.n}` }, system);
  let version = item.version;
  const step = async (reason: string, patch: Parameters<Store["transition"]>[0]["patch"], actor = system) => {
    const r = await store.transition({ id: item.id, expected_version: version, patch, actor, reason });
    if (!r.ok) throw new Error(r.reason);
    version = r.item.version;
  };
  await step("triaged", { stage: "READY", tier: s.tier, token_cost: s.token_cost });
  for (const reason of s.reasons ?? []) await step(reason, {}, human);
  for (const [i, severity] of (s.severities ?? []).entries()) {
    const r = await store.recordVerdict({
      id: item.id, expected_version: version, actor: { kind: "user", id: "github:7" as UserId },
      verdict: severity === "none" ? "accept" : "changes", severity, reason: "x", comment_id: `c${s.n}-${i}`, target: "pr",
    });
    if (!r.ok) throw new Error(r.reason);
    version = r.item.version;
  }
  if (s.closed) await step("merged", { stage: "CLOSED", close_reason: "completed" });
  return item.id;
}

/**
 * tier 1: two closed (weights 1+3 and 10, one /retry, one /reject, tokens 100+50) and one open item that
 *         must not count (critical verdict, /retry, 999 tokens).
 * tier 3: one closed (verdict none, two /retry, a floor_rejected that is not a spec_rejected, 30 tokens).
 * untiered: two closed (one /reject with no verdict; one minor verdict, 5 tokens).
 * tiers 2, 4, 5: nothing.
 */
async function seedAll(store: Store): Promise<void> {
  await seed(store, { n: 1, tier: 1, closed: true, token_cost: 100, reasons: ["retry_requested"], severities: ["minor", "major"] });
  await seed(store, { n: 2, tier: 1, closed: true, token_cost: 50, reasons: ["spec_rejected"], severities: ["critical"] });
  await seed(store, { n: 3, tier: 1, closed: false, token_cost: 999, reasons: ["retry_requested"], severities: ["critical"] });
  await seed(store, {
    n: 4, tier: 3, closed: true, token_cost: 30,
    reasons: ["retry_requested", "retry_requested", "floor_rejected", "spec_approved"], severities: ["none"],
  });
  await seed(store, { n: 5, tier: null, closed: true, token_cost: 0, reasons: ["spec_rejected"] });
  await seed(store, { n: 6, tier: null, closed: true, token_cost: 5, severities: ["minor"] });
}

const empty = (tier: Tier | null) => ({ tier, items: 0, feedback_weight: 0, rate: null, sufficient: false, reject: 0, retry: 0, token_cost: 0 });

describe("factory stats", () => {
  const config: StatsConfig = { weights: WEIGHTS, min_sample: 2 };

  it("reports every number for each tier from a seeded store", async () => {
    const { store } = await newStore();
    await seedAll(store);
    const report = await collectStats(store, config);
    expect(report.config).toEqual(config);
    expect(report.tiers).toEqual([
      { tier: 1, items: 2, feedback_weight: 14, rate: 7, sufficient: true, reject: 1, retry: 1, token_cost: 150 },
      empty(2),
      { tier: 3, items: 1, feedback_weight: 0, rate: null, sufficient: false, reject: 0, retry: 2, token_cost: 30 },
      empty(4),
      empty(5),
      { tier: null, items: 2, feedback_weight: 1, rate: 0.5, sufficient: true, reject: 1, retry: 0, token_cost: 5 },
    ]);
  });

  it("text output: one row per tier plus untiered, not enough data under min_sample, counts still shown", async () => {
    const { store } = await newStore();
    await seedAll(store);
    const text = formatStatsText(await collectStats(store, config));
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^tier\s+items\s+feedback\s+rate\s+\/reject\s+\/retry\s+token_cost$/);
    expect(lines.slice(1, 7).map((l) => l.split(/\s{2,}/))).toEqual([
      ["1", "2", "14", "7.00", "1", "1", "150"],
      ["2", "0", "0", "not enough data", "0", "0", "0"],
      ["3", "1", "0", "not enough data", "0", "2", "30"],
      ["4", "0", "0", "not enough data", "0", "0", "0"],
      ["5", "0", "0", "not enough data", "0", "0", "0"],
      ["untiered", "2", "1", "0.50", "1", "0", "5"],
    ]);
    expect(text).toContain("min_sample 2");
    expect(text).toContain("weights: none 0, minor 1, major 3, critical 10");
    expect(text).toMatch(/refused commands are not counted/);
  });

  it("--json: the same numbers plus the config, parseable, with no display names or ids", async () => {
    const { store } = await newStore();
    await seedAll(store);
    const report = await collectStats(store, config);
    const json = JSON.stringify(report, null, 2);
    expect(JSON.parse(json)).toEqual(report);
    expect(JSON.parse(json).tiers[2]).toMatchObject({ tier: 3, rate: null, sufficient: false });
    expect(json).not.toMatch(/Title of|github:|wi_|problem/);
  });

  it("min_sample boundary: min_sample - 1 items show not enough data, min_sample items show the rate", () => {
    const cfg: StatsConfig = { weights: WEIGHTS, min_sample: 10 };
    const record = (i: number): StatsRecord => ({
      id: `wi_${i}` as WorkItemId, tier: 2, stage: "CLOSED", token_cost: 1, reasons: [], severities: ["major"],
    });
    const rows = (n: number) => aggregateStats(Array.from({ length: n }, (_, i) => record(i)), cfg);

    const under = rows(9)[1]!;
    expect(under).toEqual({ tier: 2, items: 9, feedback_weight: 27, rate: null, sufficient: false, reject: 0, retry: 0, token_cost: 9 });
    expect(formatStatsText({ config: cfg, tiers: rows(9) }).split("\n")[2]).toMatch(/^2\s+9\s+27\s+not enough data\s+0\s+0\s+9$/);

    const at = rows(10)[1]!;
    expect(at).toEqual({ tier: 2, items: 10, feedback_weight: 30, rate: 3, sufficient: true, reject: 0, retry: 0, token_cost: 10 });
    expect(formatStatsText({ config: cfg, tiers: rows(10) }).split("\n")[2]).toMatch(/^2\s+10\s+30\s+3\.00\s+0\s+0\s+10$/);
  });

  it("an empty store: six zero rows, no rate", async () => {
    const { store } = await newStore();
    const report = await collectStats(store, { weights: WEIGHTS, min_sample: 1 });
    expect(report.tiers).toEqual([empty(1), empty(2), empty(3), empty(4), empty(5), empty(null)]);
    expect(formatStatsText(report)).toContain("untiered");
  });

  it("weights come from config, not the command", async () => {
    const { store } = await newStore();
    await seedAll(store);
    const report = await collectStats(store, { weights: { none: 1, minor: 0, major: 0, critical: 0 }, min_sample: 1 });
    expect(report.tiers.map((r) => r.feedback_weight)).toEqual([0, 0, 1, 0, 0, 0]);
  });

  it("writes nothing: work items and state_changes are unchanged, and no write method is called", async () => {
    const { store } = await newStore();
    await seedAll(store);
    const snapshot = async () => {
      const items = await store.listWorkItems(1000);
      return { items, changes: await Promise.all(items.map((i) => store.listStateChanges(i.id))) };
    };
    const before = await snapshot();
    const calls: string[] = [];
    const spy = new Proxy(store, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver) as unknown;
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    await collectStats(spy, config);
    expect(calls).toEqual(["listStatsRecords"]);
    expect(await snapshot()).toEqual(before);
  });
});

describe("stats config", () => {
  it("defaults min_sample to 10 and keeps the weights as given", () => {
    expect(STATS_MIN_SAMPLE_DEFAULT).toBe(10);
    expect(statsConfig({ weights: WEIGHTS })).toEqual({ weights: WEIGHTS, min_sample: 10 });
    expect(statsConfig({ weights: { ...WEIGHTS, minor: 0.5 }, min_sample: 1 })).toEqual({ weights: { ...WEIGHTS, minor: 0.5 }, min_sample: 1 });
  });

  it("fails on a missing, negative or non-number weight, or a bad min_sample", () => {
    expect(() => statsConfig(undefined)).toThrow(/stats\.weights/);
    expect(() => statsConfig({})).toThrow(/stats\.weights/);
    const { critical: _, ...noCritical } = WEIGHTS;
    expect(() => statsConfig({ weights: noCritical })).toThrow(/stats\.weights\.critical/);
    expect(() => statsConfig({ weights: { ...WEIGHTS, major: -1 } })).toThrow(/stats\.weights\.major/);
    expect(() => statsConfig({ weights: { ...WEIGHTS, minor: "1" } })).toThrow(/stats\.weights\.minor/);
    expect(() => statsConfig({ weights: { ...WEIGHTS, none: Number.NaN } })).toThrow(/stats\.weights\.none/);
    for (const min_sample of [0, -1, 1.5, "10", null]) {
      expect(() => statsConfig({ weights: WEIGHTS, min_sample })).toThrow(/stats\.min_sample/);
    }
  });

  it("factory.config.json sets the stats key, loadConfig carries it, and the dials are unchanged", async () => {
    const file = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
    expect(file.stats).toEqual({ weights: WEIGHTS, min_sample: 10 });
    expect(file.dials).toEqual({ spec_gate_min_tier: 1, auto_merge_max_tier: 0 });
    const loaded = await loadConfig(REPO_ROOT);
    expect(loaded.stats).toEqual({ weights: WEIGHTS, min_sample: 10 });
  });

  it("startup fails when factory.config.json has a bad stats key", async () => {
    const real = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
    const dir = tempRoot({ ...real, stats: { weights: { ...WEIGHTS, major: -3 } } });
    await expect(loadConfig(dir)).rejects.toThrow(/stats\.weights\.major/);
  });
});

describe("the stats store", () => {
  it("is built without migrate(): a fresh SQLite database stays without tables", async () => {
    const real = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
    const dir = tempRoot({ ...real, store: { type: "sqlite" } });
    mkdirSync(join(dir, "state", "db"), { recursive: true });
    const loaded = await loadConfig(dir, { platform: "linux" });
    const store = await buildStatsStore(loaded);
    try {
      await expect(store.listStatsRecords(["spec_rejected"])).rejects.toThrow(/no such table/);
    } finally {
      await store.close();
    }
  });
});

/** A throwaway repo root with its own config, prompts, state dir and an empty secret file. */
function tempRoot(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-stats-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...config, state_dir: "state", worktrees_dir: "wt" }));
  writeFileSync(join(dir, "secrets.env"), "");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets.env"));
  return dir;
}
