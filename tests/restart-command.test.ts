import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { RESTART_DONE, RESTART_REQUESTED, requestRestart } from "../src/core/restart.js";
import type { SourceRef, UserId, WorkItem, WorkItemPatch, WorkerId } from "../src/core/types.js";
import type { WorkerDeps } from "../src/core/worker-deps.js";
import type { AppCommandRequest } from "../src/interfaces/factory-store.js";
import type { ExecResult } from "../src/interfaces/sandbox.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { cleanScanner, config, issueRef, prompts, silent } from "./helpers/fakes/config.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// The `restart` command end to end (design 04-gate-commands, restart): an app request (the Restart app button, or
// `factory restart`), the controller's checks, one restart run queued, the worker's fake process runner, the result
// in the item's thread. No item field changes. No real process starts.

const WRITER = "github:1" as UserId;
const READER = "github:666" as UserId;
const MERGED: WorkItemPatch = { stage: "CLOSED", close_reason: "completed", merge_sha: "m1", blocked_on: "none", blocked_reason: null };
const MERGE_PENDING: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" };
const REJECTED: WorkItemPatch = { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null };
const localRef = (n: number): SourceRef => ({ type: "local", id: `local-${n}`, link: `local:local-${n}` });
const CMD = ["bin/restart", "--quiet"];
const TOOL_ENV = { PATH: "/usr/bin", HOME: "/home/owner" };

type Exec = NonNullable<WorkerDeps["host_exec"]>;
const exited = (exit_code: number | null, stdout = "", timed_out = false): ExecResult => ({ exit_code, signal: null, stdout, stderr: "", timed_out });

async function harness(o: { restart_command?: string[] | null; exec?: Exec } = {}) {
  const { store, clock } = await newStore();
  const source = new FakeSource();
  const command = o.restart_command === null ? {} : { restart_command: o.restart_command ?? CMD };
  const cfg: FactoryConfig = { ...config, repo: { ...config.repo, path: "/owner/repo", ...command }, run_timeout_ms: 90_000 };
  const controller = new ControllerRole({ store, sources: [source], auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner });
  const calls: { cmd: readonly string[]; opts: Parameters<Exec>[1] }[] = [];
  const exec: Exec = async (cmd, opts) => {
    calls.push({ cmd, opts });
    return o.exec ? o.exec(cmd, opts) : exited(0, "app restarted\n");
  };
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner: new FakeRunner({}), broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config: cfg, prompts, log: silent, scanner: cleanScanner, toolEnv: TOOL_ENV, awake: new NoKeepAwake(), host_exec: exec,
  });
  const actor = { kind: "system" as const, id: "system:test" };
  const itemIn = async (ref: SourceRef, patch: WorkItemPatch): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ source: ref, requester_id: WRITER, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
    const r = await store.transition({ id: item.id, expected_version: item.version, actor, reason: "setup", patch });
    if (!r.ok) throw new Error("setup failed");
    return r.item;
  };
  let keys = 0;
  const request = async (it: WorkItem, who: UserId = WRITER): Promise<AppCommandRequest> =>
    (await store.recordAppCommandRequest({ key: `app:${++keys}`, actor: who, command: "restart", args: { work_item_id: it.id } })).request;
  /** The controller applies the requests, the worker runs what is queued, the controller applies the results. */
  const cycle = async () => {
    await controller.tickCommands();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
    await controller.tickOutbox();
  };
  const thread = async (it: WorkItem, prefix: string) => (await store.listItemMessages(it.id)).filter((m) => m.marker.startsWith(prefix)).map((m) => m.body);
  const get = async (it: WorkItem) => (await store.getWorkItem(it.id))!;
  const restarts = async (it: WorkItem) => (await store.listRuns(it.id)).filter((r) => r.kind === "restart");
  return { store, cfg, calls, controller, itemIn, request, cycle, thread, get, restarts };
}

/** The item's fields that a restart must not change. */
const fields = (it: WorkItem) => ({ stage: it.stage, close_reason: it.close_reason, merge_sha: it.merge_sha, blocked_on: it.blocked_on, blocked_reason: it.blocked_reason, token_cost: it.token_cost });

describe("Restart app on a merged item", () => {
  for (const ref of [localRef(1), issueRef(1)]) {
    it(`${ref.type}: runs the command in the base checkout and posts its exit status and output tail; no item field changes`, async () => {
      const h = await harness();
      const it1 = await h.itemIn(ref, MERGED);
      const r = await h.request(it1);
      await h.cycle();

      expect(h.calls).toHaveLength(1);
      // No shell: the argv as configured; the base checkout; the worker's tool env only; the run timeout.
      expect(h.calls[0]!.cmd).toEqual(CMD);
      expect(h.calls[0]!.opts).toMatchObject({ cwd: "/owner/repo", env: TOOL_ENV, timeout_ms: 90_000 });
      const [run] = await h.restarts(it1);
      expect(run).toMatchObject({ status: "succeeded", outcome: { data: expect.objectContaining({ result: "ok", command: CMD, exit_code: 0 }) } });
      const [reply, ...more] = await h.thread(it1, "<!-- factory:restart:");
      expect(more).toEqual([]);
      expect(reply).toContain("Restarted the app: `bin/restart --quiet` exited 0 in the base checkout.");
      expect(reply).toContain("app restarted");
      expect(fields(await h.get(it1))).toEqual(fields(it1));
      const reasons = (await h.store.listStateChanges(it1.id)).map((c) => c.reason);
      expect(reasons.slice(reasons.indexOf(RESTART_REQUESTED))).toEqual([RESTART_REQUESTED, RESTART_DONE]);
      expect((await h.store.listStateChanges(it1.id)).find((c) => c.reason === RESTART_REQUESTED)).toMatchObject({ actor: { kind: "user", id: WRITER }, detail: { app_request: r.seq } });
      expect(await h.store.getAppCommandRequest(r.seq)).toMatchObject({ refusal: null });
    });
  }

  it("a non-zero exit, a timeout and a command that cannot start are each posted as a failure; nothing else changes", async () => {
    const cases: [Exec, string][] = [
      [async () => exited(3, "port 8080 in use\n"), "exited 3"],
      [async () => exited(null, "", true), "timed out"],
      [async () => { throw new Error("spawn bin/restart ENOENT"); }, "could not start: spawn bin/restart ENOENT"],
    ];
    for (const [exec, how] of cases) {
      const h = await harness({ exec });
      const it1 = await h.itemIn(localRef(1), MERGED);
      await h.request(it1);
      await h.cycle();
      const [reply] = await h.thread(it1, "<!-- factory:restart:");
      expect(reply).toContain(`The restart failed: \`bin/restart --quiet\` ${how}. The item is unchanged.`);
      expect(fields(await h.get(it1))).toEqual(fields(it1));
      // Never retried: the one run, acknowledged.
      expect(await h.restarts(it1)).toHaveLength(1);
    }
    const h = await harness({ exec: async () => exited(3, "port 8080 in use\n") });
    const it1 = await h.itemIn(localRef(1), MERGED);
    await h.request(it1);
    await h.cycle();
    expect((await h.thread(it1, "<!-- factory:restart:"))[0]).toContain("port 8080 in use");
  });

  it("the same request applied twice queues one run", async () => {
    const h = await harness();
    const it1 = await h.itemIn(localRef(1), MERGED);
    const r = await h.request(it1);
    await (await h.controller.unit("app-requests")).applyAppRequest(r);
    await (await h.controller.unit("local-merge")).restart(it1, WRITER, `app-${r.seq}`, { app_request: r.seq });
    await h.cycle();
    expect(await h.restarts(it1)).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    // A second press is a new request: a new run.
    await h.request(it1);
    await h.cycle();
    expect(await h.restarts(it1)).toHaveLength(2);
  });
});

describe("a restart that is refused, with the reason in the thread; nothing runs", () => {
  const refusal = async (h: Awaited<ReturnType<typeof harness>>, it1: WorkItem, r: AppCommandRequest) => {
    await h.cycle();
    expect(h.calls).toEqual([]);
    expect(await h.restarts(it1)).toEqual([]);
    expect(fields(await h.get(it1))).toEqual(fields(it1));
    const [reply] = await h.thread(it1, `<!-- factory:refused:app-${r.seq}`);
    expect((await h.store.getAppCommandRequest(r.seq))!.refusal).toBe(reply);
    return reply!;
  };

  it("an item not merged into the base: waiting for its merge, or closed without one", async () => {
    for (const patch of [MERGE_PENDING, REJECTED]) {
      const h = await harness();
      const it1 = await h.itemIn(localRef(1), patch);
      expect(await refusal(h, it1, await h.request(it1))).toMatch(/^`restart` was not applied: the item is not merged into the base/);
    }
  });

  it("a caller who is not the owner, as for every item command", async () => {
    const h = await harness();
    const it1 = await h.itemIn(localRef(1), MERGED);
    expect(await refusal(h, it1, await h.request(it1, READER))).toMatch(/^`restart` was not applied: only the owner/);
  });

  it("no repo.restart_command: the feature is off", async () => {
    const h = await harness({ restart_command: null });
    const it1 = await h.itemIn(localRef(1), MERGED);
    expect(await refusal(h, it1, await h.request(it1))).toContain("no run command is set (`repo.restart_command`");
  });
});

describe("factory restart <id>", () => {
  it("stores the request the page does, so the controller runs the same restart", async () => {
    const h = await harness();
    const it1 = await h.itemIn(localRef(1), MERGED);
    const r = await requestRestart({ store: h.store, user: WRITER, command: h.cfg.repo.restart_command, newKey: () => "app:cli-1" }, it1.id);
    expect(r.code).toBe(0);
    await h.cycle();
    expect(h.calls.map((c) => c.cmd)).toEqual([CMD]);
    expect(await h.thread(it1, "<!-- factory:restart:")).toEqual([expect.stringContaining("Restarted the app")]);
  });
});
