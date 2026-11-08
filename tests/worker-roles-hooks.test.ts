import { describe, expect, it } from "vitest";
import { checkEnabledHooks, hookNames } from "../src/compose.js";
import { Worker } from "../src/worker/index.js";
import type { FactoryConfig } from "../src/core/config.js";
import type { WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { RoleCatalog, SqlHookAudit, loadRoles } from "../src/runtime/index.js";
import { defineHook, type HookDescriptor } from "../src/shared/hook.js";
import { defineRole } from "../src/shared/role.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeBroker, FakeRunner, FakeSandbox, MemoryStorage, cleanScanner, config, prompts, recordingLog, triageSpec } from "./helpers/fakes.js";

// M10 wiring (design 10-event-driven): the run roles drive the worker's prompts and tools, and the owner's
// `before_run` hooks run at run start, after the guards, failing closed.

async function world(o: { cfg?: Partial<FactoryConfig>; roles?: RoleCatalog; hooks?: HookDescriptor[] } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
  const runner = new FakeRunner({ triage: async () => ({ output: triageSpec }) });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config: { ...config, ...o.cfg }, prompts, log: recordingLog(), scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  }, { ...(o.roles ? { roles: o.roles } : {}), ...(o.hooks ? { hooks: o.hooks } : {}) });
  expect(await worker.tick()).toBe(true);
  const [run] = await store.listRuns(item.id);
  return { run: run!, runner, store };
}

describe("run roles drive the agent's prompt and tools", () => {
  it("the triage agent gets its role's prompt file and tools, not ones the run kind picks", async () => {
    const triage = (await loadRoles()).get("triage")!;
    const { runner } = await world();
    expect(runner.specs[0]!.system_prompt).toBe(prompts.triage);
    expect(runner.specs[0]!.tools.map((t) => t.name)).toEqual(triage.tools);

    // A role that declares other tools and another prompt file changes what the agent gets.
    const narrowed = defineRole({ ...triage, prompt: "review.md", tools: ["Read"] });
    const { runner: other } = await world({ roles: new RoleCatalog([{ file: "worker/roles/triage.role.ts", descriptor: narrowed }]) });
    expect(other.specs[0]!.system_prompt).toBe(prompts.review);
    expect(other.specs[0]!.tools.map((t) => t.name)).toEqual(["Read"]);
  });

  it("a role whose prompt file is missing fails the run before the agent starts", async () => {
    const triage = (await loadRoles()).get("triage")!;
    const missing = defineRole({ ...triage, prompt: "improve.md" });
    const { run, runner } = await world({ roles: new RoleCatalog([{ file: "worker/roles/triage.role.ts", descriptor: missing }]) });
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "prompt_missing" });
    expect(runner.specs).toHaveLength(0);
  });
});

describe("before_run hooks", () => {
  const calls: string[] = [];
  const hook = (name: string, run: HookDescriptor["run"]) => defineHook({ name, point: "before_run", budget_ms: 1_000, run: async (i, s) => (calls.push(name), run(i, s)) });
  const veto = hook("freeze", async () => ({ kind: "veto", reason: "release freeze" }));
  const other = hook("other", async () => ({ kind: "veto", reason: "never enabled" }));

  it("an enabled hook's veto fails the run before the agent starts, and the decision is audited", async () => {
    calls.length = 0;
    const { run, runner, store } = await world({ cfg: { hooks: ["freeze"] }, hooks: [veto, other] });
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "hook_refused", detail: "hook freeze: release freeze" });
    expect(runner.specs).toHaveLength(0);
    expect(calls).toEqual(["freeze"]);
    expect(await new SqlHookAudit(storeSql(store)).forSubject(run.id)).toMatchObject([{ hook: "freeze", point: "before_run", outcome: "veto" }]);
  });

  it("a hook that throws refuses the run too (fail closed)", async () => {
    const broken = hook("broken", async () => {
      throw new Error("no answer");
    });
    const { run, runner } = await world({ cfg: { hooks: ["broken"] }, hooks: [broken] });
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "hook_refused" });
    expect(runner.specs).toHaveLength(0);
  });

  it("with no hook enabled, none runs and the run goes on", async () => {
    calls.length = 0;
    const { run } = await world({ hooks: [veto, other] });
    expect(run.status).toBe("succeeded");
    expect(calls).toEqual([]);
  });
});

describe("the hooks setting", () => {
  it("startup refuses a name no discovered hook has, and anything but a list of names", async () => {
    await expect(checkEnabledHooks(["no-such-hook"])).rejects.toThrow("hooks: no discovered hook named no-such-hook");
    await expect(checkEnabledHooks([])).resolves.toBeUndefined();
    expect(() => hookNames("freeze")).toThrow("hooks must be a list of hook names");
    expect(() => hookNames([1])).toThrow("hooks must be a list of hook names");
    expect(hookNames(["freeze"])).toEqual(["freeze"]);
  });

  it("startup refuses a hook at a point nothing calls yet (before_delivery); one at a called point passes", async () => {
    const at = (name: string, point: HookDescriptor["point"]) => defineHook({ name, point, budget_ms: 100, run: async () => ({ kind: "pass" }) });
    const hooks = [at("delivery-check", "before_delivery"), at("merge-check", "before_merge")];
    await expect(checkEnabledHooks(["delivery-check"], hooks)).rejects.toThrow("hooks: delivery-check (before_delivery): that point is not wired yet");
    await expect(checkEnabledHooks(["merge-check"], hooks)).resolves.toBeUndefined();
  });
});
