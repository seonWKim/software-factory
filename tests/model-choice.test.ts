import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/compose.js";
import {
  DEFAULT_MODEL_BY,
  DEFAULT_MODEL_TABLE,
  type ModelTable,
  bumpClass,
  modelClassFor,
  parseModelBy,
} from "../src/core/model-choice.js";
import type { Tier, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { FakeBroker, FakeRunner, FakeSandbox, MemoryStorage, cleanScanner, config, prompts, silent, triageSpec } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const SQLITE: Record<string, unknown> = { ...REAL, store: { type: "sqlite" } };
const TIERS: Tier[] = [1, 2, 3, 4, 5];

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A throwaway repo root with its own config, prompts and secret file. */
function root(cfg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-model-choice-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify(cfg));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "secrets", ".env"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
  return dir;
}

async function loadError(cfg: Record<string, unknown>): Promise<Error> {
  const err = await loadConfig(root(cfg)).then(
    () => null,
    (e: Error) => e,
  );
  if (!err) throw new Error("loadConfig succeeded");
  return err;
}

const T = DEFAULT_MODEL_TABLE;

describe("model class per run kind and tier: the default table", () => {
  for (const tier of TIERS) {
    it(`triage at tier ${tier} uses cheap`, () => {
      expect(modelClassFor(T, "triage", tier, 0)).toBe("cheap");
    });
    it(`review at tier ${tier} uses standard`, () => {
      expect(modelClassFor(T, "review", tier, 0)).toBe("standard");
    });
  }
  for (const tier of [1, 2] as const) {
    it(`implement at tier ${tier} uses standard`, () => {
      expect(modelClassFor(T, "implement", tier, 0)).toBe("standard");
    });
    it(`resolve at tier ${tier} uses standard`, () => {
      expect(modelClassFor(T, "resolve", tier, 0)).toBe("standard");
    });
  }
  for (const tier of [3, 4, 5] as const) {
    it(`implement at tier ${tier} uses strong`, () => {
      expect(modelClassFor(T, "implement", tier, 0)).toBe("strong");
    });
    it(`resolve at tier ${tier} uses strong`, () => {
      expect(modelClassFor(T, "resolve", tier, 0)).toBe("strong");
    });
  }

  it("an item with no tier yet takes the tier-5 entry", () => {
    expect(modelClassFor(T, "implement", null, 0)).toBe("strong");
    expect(modelClassFor(T, "triage", null, 0)).toBe("cheap");
  });
});

describe("retry after a review loop", () => {
  it("implement and resolve with loop_count ≥ 1 go one class up; strong stays strong", () => {
    for (const kind of ["implement", "resolve"] as const) {
      for (const loops of [1, 2, 3]) {
        expect(modelClassFor(T, kind, 1, loops)).toBe("strong");
        expect(modelClassFor(T, kind, 2, loops)).toBe("strong");
        expect(modelClassFor(T, kind, 5, loops)).toBe("strong");
      }
    }
    expect(bumpClass("cheap")).toBe("standard");
    expect(bumpClass("standard")).toBe("strong");
    expect(bumpClass("strong")).toBe("strong");
  });

  it("a cheap entry goes to standard on a retry", () => {
    const table = parseModelBy({ ...DEFAULT_MODEL_BY, implement: "cheap" });
    expect(modelClassFor(table, "implement", 3, 1)).toBe("standard");
  });

  it("triage and review are not moved up when loop_count ≥ 1", () => {
    for (const tier of TIERS) {
      expect(modelClassFor(T, "triage", tier, 1)).toBe("cheap");
      expect(modelClassFor(T, "review", tier, 2)).toBe("standard");
    }
  });

  it("retry_up false turns the bump off", () => {
    const table = parseModelBy({ ...DEFAULT_MODEL_BY, retry_up: false });
    expect(modelClassFor(table, "implement", 1, 2)).toBe("standard");
  });
});

describe("model_by and models in factory.config.json", () => {
  it("the shipped model_by is exactly the default table, and loading it yields that table", async () => {
    expect(REAL.model_by).toEqual(DEFAULT_MODEL_BY);
    expect(REAL.models).toEqual({ cheap: "haiku", standard: "sonnet", strong: "opus" });
    const loaded = await loadConfig(root(REAL));
    expect(loaded.model_by).toEqual(DEFAULT_MODEL_TABLE);
    expect(loaded.models).toEqual({ cheap: "haiku", standard: "sonnet", strong: "opus" });
  });

  it("absent model_by uses the default table", async () => {
    const { model_by: _, ...rest } = SQLITE;
    const loaded = await loadConfig(root(rest));
    expect(loaded.model_by).toEqual(DEFAULT_MODEL_TABLE);
  });

  it("changing one entry changes the class for that row, with no code change", async () => {
    const implement = { ...DEFAULT_MODEL_BY.implement, "1": "strong" };
    const loaded = await loadConfig(root({ ...SQLITE, model_by: { ...DEFAULT_MODEL_BY, implement } }));
    expect(modelClassFor(loaded.model_by, "implement", 1, 0)).toBe("strong");
    expect(modelClassFor(loaded.model_by, "implement", 2, 0)).toBe("standard");
  });

  it("an unknown run kind under model_by fails loading and names the key", async () => {
    const err = await loadError({ ...SQLITE, model_by: { ...DEFAULT_MODEL_BY, update: "cheap" } });
    expect(err.message).toContain('"update"');
  });

  it("an unknown tier key under model_by fails loading and names the key", async () => {
    const implement = { ...DEFAULT_MODEL_BY.implement, "6": "strong" };
    const err = await loadError({ ...SQLITE, model_by: { ...DEFAULT_MODEL_BY, implement } });
    expect(err.message).toContain('"6"');
    expect(err.message).toContain("model_by.implement");
  });

  it("a value that is not cheap, standard or strong fails loading and names the value", async () => {
    const err = await loadError({ ...SQLITE, model_by: { ...DEFAULT_MODEL_BY, review: "medium" } });
    expect(err.message).toContain('"medium"');
    const err2 = await loadError({ ...SQLITE, model_by: { ...DEFAULT_MODEL_BY, resolve: { ...DEFAULT_MODEL_BY.resolve, "3": "opus" } } });
    expect(err2.message).toContain('"opus"');
  });

  it("models without a standard entry fails loading", async () => {
    const err = await loadError({ ...SQLITE, models: { cheap: "haiku", strong: "opus" } });
    expect(err.message).toContain("models.standard");
  });
});

describe("the worker", () => {
  async function triageOnce(models?: { table: ModelTable; names?: { cheap: string; standard: string; strong: string } }) {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } });
    const runner = new FakeRunner({ triage: () => ({ output: triageSpec }) });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
      ...(models ? { models } : {}),
    });
    expect(await worker.tick()).toBe(true);
    const [run] = await store.listRuns(item.id);
    return { run: run!, runner };
  }

  it("records the model class and model name in the run outcome, next to the token usage", async () => {
    const { run, runner } = await triageOnce({ table: DEFAULT_MODEL_TABLE, names: { cheap: "haiku", standard: "sonnet", strong: "opus" } });
    expect(runner.specs[0]!.model_class).toBe("cheap");
    expect(run.outcome).toMatchObject({ status: "succeeded", data: { tokens: 15, model_class: "cheap", model: "haiku" } });
  });

  it("uses the configured table for the run it starts", async () => {
    const table = parseModelBy({ ...DEFAULT_MODEL_BY, triage: "standard" });
    const { run, runner } = await triageOnce({ table, names: { cheap: "haiku", standard: "sonnet", strong: "opus" } });
    expect(runner.specs[0]!.model_class).toBe("standard");
    expect(run.outcome).toMatchObject({ data: { model_class: "standard", model: "sonnet" } });
  });

  it("with no models given, uses the default table and records the name as null", async () => {
    const { run } = await triageOnce();
    expect(run.outcome).toMatchObject({ data: { model_class: "cheap", model: null } });
  });
});
