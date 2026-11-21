import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import type { UserId, WorkerId } from "../src/core/types.js";
import type { WorkerDeps } from "../src/core/worker-deps.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { Worker } from "../src/worker/index.js";
import { WORKER_KINDS } from "../src/core/settings.js";
import { loadRunKinds } from "../src/worker/run-kind.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { cleanScanner, config, prompts, silent } from "./helpers/fakes/config.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// The restart run kind (design 04-gate-commands, restart): `repo.restart_command` on the host through the worker's
// process runner (a fake here), in the base checkout, no folder, no agent. Its result is data, never a run failure.

/** Flags any text with "SECRET" in it. */
const flagging: EgressScanner = {
  async scan(channel, content) {
    return content.includes("SECRET") ? { clean: false, findings: [{ rule: "test_rule", channel }] } : { clean: true };
  },
};

async function oneRestart(o: { repo?: Partial<FactoryConfig["repo"]>; exec?: WorkerDeps["host_exec"] | null; scanner?: EgressScanner }) {
  const { store, clock } = await newStore();
  const cfg: FactoryConfig = { ...config, repo: { ...config.repo, restart_command: ["bin/restart"], ...o.repo } };
  const { item } = await store.createWorkItem(
    { source: { type: "local", id: "local-1", link: "local:local-1" }, requester_id: "local:me" as UserId, project: PROJECT_KEY, problem: "p", resources: [] },
    { kind: "system", id: "system:test" },
    { enqueue: { kind: "restart", idempotency_key: "restart:app-1" } },
  );
  const sandbox = new FakeSandbox();
  const runner = new FakeRunner({});
  const exec = o.exec === null ? {} : { host_exec: o.exec ?? (async () => ({ exit_code: 0, signal: null, stdout: "ok\n", stderr: "", timed_out: false })) };
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config: cfg, prompts, log: silent, scanner: o.scanner ?? cleanScanner, toolEnv: {}, awake: new NoKeepAwake(), ...exec,
  });
  expect(await worker.tick()).toBe(true);
  const [run] = await store.listRuns(item.id);
  return { run: run!, sandbox, runner };
}

describe("the restart run", () => {
  it("is a run kind every worker claims, with its run file", async () => {
    expect(WORKER_KINDS).toContain("restart");
    expect((await loadRunKinds()).get("restart")).toMatchObject({ name: "restart", folder: false });
  });

  it("makes no run folder and starts no agent", async () => {
    const { run, sandbox, runner } = await oneRestart({});
    expect(run).toMatchObject({ status: "succeeded", outcome: { data: expect.objectContaining({ result: "ok", output_tail: "ok\n" }) } });
    expect(sandbox.created).toEqual([]);
    expect(runner.specs).toEqual([]);
  });

  it("withholds an output tail the egress scan flags, whole, and keeps how it ended", async () => {
    const exec: WorkerDeps["host_exec"] = async () => ({ exit_code: 1, signal: null, stdout: "token=SECRET\n", stderr: "", timed_out: false });
    const { run } = await oneRestart({ exec, scanner: flagging });
    expect(run.status).toBe("succeeded");
    expect(run.outcome?.status === "succeeded" && run.outcome.data).toMatchObject({ result: "failed", exit_code: 1, output_tail: null, output_withheld: true });
    expect(JSON.stringify(run.outcome)).not.toContain("SECRET");
  });

  it("a worker with no process runner fails the run with no_host_exec", async () => {
    const { run } = await oneRestart({ exec: null });
    expect(run).toMatchObject({ status: "failed", outcome: { error_code: "no_host_exec" } });
  });

  it("a command removed from the config after the request runs nothing and says so", async () => {
    let ran = false;
    const { restart_command: _, ...repo } = { ...config.repo, restart_command: ["x"] };
    const { store, clock } = await newStore();
    const cfg: FactoryConfig = { ...config, repo };
    const { item } = await store.createWorkItem(
      { source: { type: "local", id: "local-1", link: "local:local-1" }, requester_id: "local:me" as UserId, project: PROJECT_KEY, problem: "p", resources: [] },
      { kind: "system", id: "system:test" },
      { enqueue: { kind: "restart", idempotency_key: "restart:app-1" } },
    );
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner: new FakeRunner({}), broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config: cfg, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
      host_exec: async () => { ran = true; return { exit_code: 0, signal: null, stdout: "", stderr: "", timed_out: false }; },
    });
    await worker.tick();
    const [run] = await store.listRuns(item.id);
    expect(ran).toBe(false);
    expect(run!.outcome?.status === "succeeded" && run!.outcome.data).toEqual(expect.objectContaining({ result: "not_set", command: null }));
  });
});
