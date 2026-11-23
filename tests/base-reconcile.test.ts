import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/load-config.js";
import type { FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { type BaseSyncResult, type BaseSyncSpec, type LocalMergeResult, type LocalMergeSpec, reconcileOf, reconcileSourceId } from "../src/core/local-merge.js";
import { runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkItem, WorkItemId, WorkerId } from "../src/core/types.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { Worker } from "../src/worker/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { BasePushInput, Forge } from "../src/interfaces/forge.js";
import type { Sandbox } from "../src/interfaces/sandbox.js";
import type { ActionRow } from "../src/outbound/index.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeRunner, MemoryStorage } from "./helpers/fakes/runner.js";
import { cleanScanner, config, prompts, silent, triageSpec } from "./helpers/fakes/config.js";
import { newStore, system, w1 } from "./helpers/store.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";

// The base reconcile (design 05-sources, Base reconcile): a base push that conflicts with origin files one local
// reconcile item keyed on origin's sha. It starts at its resolve run (no triage, no spec approval), which merges
// origin's base as fetched into a branch made from local main; a green result lands only through the merge queue's
// merge check, and a red one moves nothing. Fakes stand in for origin and the sandbox, or a bare repo does; no live
// remote and no model is called.

const ME = "local:me@example.com" as UserId;
const WHO = { provider: "local" as const, subject: "me@example.com" };
const SHA = (c: string) => c.repeat(40);
const project = localProject({ owner: "o", name: "r" });
const cfg: FactoryConfig = { ...config, project, local_only: true, repo: { ...config.repo, path: "/nowhere" } };

/** A sandbox that merges and syncs with no git; `sync` decides what origin looks like. */
class FakeMergeSandbox {
  merges: LocalMergeSpec[] = [];
  sync: () => BaseSyncResult = () => ({ synced: false, conflicts: ["a.txt"], remote: SHA("c") });
  async mergeLocal(spec: LocalMergeSpec): Promise<LocalMergeResult> {
    this.merges.push(spec);
    return { merged: true, sha: SHA(String(this.merges.length)), already: false, not_updated: [] };
  }
  async localConflicts(): Promise<string[]> {
    return [];
  }
  async syncBase(_spec: BaseSyncSpec): Promise<BaseSyncResult> {
    return this.sync();
  }
}

/** A forge that only pushes a base, recording each push. */
function pushingForge() {
  const pushes: BasePushInput[] = [];
  return { pushes, forge: { ref_type: "github_issue", pushBase: async (input: BasePushInput) => void pushes.push(input) } as unknown as Forge };
}

async function setup(opts: { forge?: Forge } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const sandbox = new FakeMergeSandbox();
  const controller = new ControllerRole({
    store, sources: [new LocalSource(store)], auth: new OwnerAuth(store), clock, config: cfg, log: silent, scanner: cleanScanner,
    sandbox: sandbox as unknown as Sandbox, repeated_failure_rule: false, ...(opts.forge ? { forge: opts.forge } : {}),
  });
  let n = 0;
  /** One local item at merge_pending. */
  const ready = async (): Promise<WorkItemId> => {
    const created = await runLocalCli(
      { answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user: ME, from: "git user.email" }, project: async () => project.key, read: async () => "b", newId: () => `id${++n}x` },
      { action: "create", title: "t", bodyFile: "b" },
    );
    const id = created.lines[0] as WorkItemId;
    const item = (await store.getWorkItem(id))!;
    await store.transition({ id, expected_version: item.version, actor: system, reason: "review_passed", patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" } });
    return id;
  };
  /** `factory merge` of `id`, its merge check completed green, the merge and its base push delivered. */
  const mergeAndPush = async (id: WorkItemId) => {
    expect(await controller.mergeLocal(id, WHO, `k-${id}`)).toBeNull();
    await checkResult({ result: "green", base_sha: SHA("0") });
    await controller.tickOutbox();
    await controller.tickOutbox();
  };
  /** The queued merge-check run, completed with `data`, and applied. */
  const checkResult = async (data: Record<string, unknown>) => {
    const run = (await store.claimRun({ worker_id: w1, kinds: ["merge-check"], lease_ms: 60_000 }))!;
    await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data });
    await (await controller.unit("run-results")).apply((await store.listRuns(run.work_item_id)).find((r) => r.id === run.id)!);
    return run;
  };
  const reconciles = async (): Promise<WorkItem[]> => (await store.listWorkItems(100)).filter((it) => reconcileOf(it) !== null);
  return { store, clock, sandbox, controller, ready, mergeAndPush, checkResult, reconciles };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** The reconcile item's resolve run, claimed and completed with `outcome`, and applied. */
async function resolveResult(f: Setup, id: WorkItemId, outcome: Parameters<FactoryStore["completeRun"]>[2]) {
  const run = (await f.store.claimRun({ worker_id: w1, kinds: ["resolve"], lease_ms: 60_000 }))!;
  expect(run.work_item_id).toBe(id);
  await f.store.completeRun(run.id, run.lease!.token, outcome);
  await (await f.controller.unit("run-results")).apply((await f.store.listRuns(id)).find((r) => r.id === run.id)!);
  return run;
}

describe("base reconcile: one item per origin sha", () => {
  it("a conflicting base push files one reconcile item at its resolve run; a second conflict on that sha files none; another sha files one more", async () => {
    const g = pushingForge();
    const f = await setup({ forge: g.forge });
    await f.mergeAndPush(await f.ready());
    const [item, ...more] = await f.reconciles();
    expect(more).toEqual([]);
    expect(item).toMatchObject({ source: { type: "local", id: reconcileSourceId("main", SHA("c")) }, stage: "RUNNING", blocked_on: "none" });
    // No triage, no spec approval: the resolve run is its first and only run.
    expect((await f.store.listRuns(item!.id)).map((r) => [r.kind, r.idempotency_key])).toEqual([["resolve", `${item!.id}:reconcile:${SHA("c")}`]]);
    expect((await f.store.listStateChanges(item!.id)).map((c) => c.reason)).toEqual(["intake", "reconcile_started"]);
    expect(g.pushes).toEqual([]);

    await f.mergeAndPush(await f.ready());
    expect((await f.reconciles()).map((it) => it.id)).toEqual([item!.id]);

    f.sandbox.sync = () => ({ synced: false, conflicts: ["a.txt"], remote: SHA("d") });
    await f.mergeAndPush(await f.ready());
    expect((await f.reconciles()).map((it) => reconcileOf(it)!.remote).sort()).toEqual([SHA("c"), SHA("d")]);
  });

  it("files nothing for a conflict with no origin sha (stored before the reconcile) or with no forge that pushes a base", async () => {
    const row = (ref: unknown) => ({ action: "push_base", work_item_id: "wi_x", args: { base_ref: "main" }, delivered_ref: JSON.stringify(ref) }) as unknown as ActionRow;
    const withForge = await setup({ forge: pushingForge().forge });
    await (await withForge.controller.unit("local-merge")).basePushDelivered(row({ conflicts: ["a.txt"] }));
    expect(await withForge.reconciles()).toEqual([]);
    const solo = await setup();
    await (await solo.controller.unit("local-merge")).basePushDelivered(row({ conflicts: ["a.txt"], remote: SHA("c") }));
    expect(await solo.reconciles()).toEqual([]);
  });
});

describe("base reconcile: the result lands only through the merge queue's merge check", () => {
  async function reconciled() {
    const f = await setup({ forge: pushingForge().forge });
    await f.mergeAndPush(await f.ready());
    const id = (await f.reconciles())[0]!.id;
    f.sandbox.sync = () => ({ synced: true, local: SHA("e"), remote: SHA("c"), contains: false, not_updated: [] });
    const merges = f.sandbox.merges.length;
    await resolveResult(f, id, { status: "succeeded", summary: "s", data: { result: "pushed", conflicts: ["a.txt"], head_sha: SHA("f"), base_sha: SHA("c") } });
    return { f, id, merges };
  }

  it("a green resolve enters the merge queue with no person and no review; a green merge check lands it and pushes the base", async () => {
    const { f, id, merges } = await reconciled();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "ci", blocked_reason: "merge_queued" });
    expect((await f.store.listRuns(id)).map((r) => r.kind)).toEqual(["resolve", "merge-check"]);
    expect((await f.store.listRuns(id)).at(-1)!.input).toMatchObject({ merge_check: { base_ref: "main", branches: [`factory/${id}`] } });
    expect(f.sandbox.merges).toHaveLength(merges);

    await f.checkResult({ result: "green", base_sha: SHA("0") });
    await f.controller.tickOutbox();
    expect(f.sandbox.merges.at(-1)).toMatchObject({ branch: `factory/${id}`, base_ref: "main" });
    expect(f.sandbox.merges.at(-1)!.message).toContain("as a base reconcile");
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect(await f.store.getBasePush(id)).toMatchObject({ base_ref: "main" });
  });

  it("a red merge check moves nothing: no merge, no implement loop, the item back at merge_pending", async () => {
    const { f, id, merges } = await reconciled();
    await f.checkResult({ result: "red", why: "checks", command: "npm test", how: "exited 1", failing_tests: ["t"], output_tail: "" });
    await f.controller.tickOutbox();
    expect(f.sandbox.merges).toHaveLength(merges);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", loop_count: 0 });
    expect((await f.store.listRuns(id)).map((r) => r.kind)).toEqual(["resolve", "merge-check"]);
  });

  it("a failed resolve run moves nothing and waits on a person", async () => {
    const f = await setup({ forge: pushingForge().forge });
    await f.mergeAndPush(await f.ready());
    const id = (await f.reconciles())[0]!.id;
    const merges = f.sandbox.merges.length;
    await resolveResult(f, id, { status: "failed", error_code: "tests_failed", detail: "npm test exited 1", infra: false });
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human" });
    expect((await f.store.listRuns(id)).map((r) => r.kind)).toEqual(["resolve"]);
    expect(f.sandbox.merges).toHaveLength(merges);
  });
});

// The git side: a bare repo stands in for origin, the worker runs the resolve with a fake agent.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const commitIn = (dir: string, files: Record<string, string>, msg: string) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", msg);
};

/** A factory repo whose local main and origin's main each changed `shared.txt` since they split. */
function diverged() {
  const root = mkdtempSync(join(tmpdir(), "sf-reconcile-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const dev = join(root, "dev");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "init", "--quiet", "-b", "main", repo);
  commitIn(repo, { "shared.txt": "base\n" }, "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "--quiet", "origin", "main");
  git(root, "clone", "--quiet", origin, dev);
  commitIn(repo, { "shared.txt": "local\n" }, "a local merge");
  git(repo, "checkout", "--quiet", "--detach");
  commitIn(dev, { "shared.txt": "theirs\n" }, "a person's push");
  git(dev, "push", "--quiet", "origin", "main");
  return { root, origin, repo, local: git(repo, "rev-parse", "main"), remote: git(dev, "rev-parse", "HEAD") };
}

describe("base reconcile with git (a bare origin)", { timeout: 60_000 }, () => {
  it("the sandbox reports origin's sha with a conflict, and starts the reconcile branch from local main, kept on a retry", async () => {
    const r = diverged();
    const sandbox = new NoOpSandbox(join(r.root, "wt"), undefined, undefined, { local: true });
    const sync = await sandbox.syncBase({ repo: r.repo, base_ref: "main", merge_sha: r.local, message: "m", identity: { name: "f", email: "f@example.com" } });
    expect(sync).toEqual({ synced: false, conflicts: ["shared.txt"], remote: r.remote });
    expect(await sandbox.startReconcile({ repo: r.repo, base_ref: "main", branch: "factory/wi_r" })).toEqual({ origin: r.remote, start: r.local });
    expect(git(r.repo, "rev-parse", "factory/wi_r")).toBe(r.local);
    // A retry keeps the branch where an earlier attempt left it.
    git(r.repo, "update-ref", "refs/heads/factory/wi_r", r.remote);
    expect(await sandbox.startReconcile({ repo: r.repo, base_ref: "main", branch: "factory/wi_r" })).toEqual({ origin: r.remote, start: r.remote });
    expect(git(r.repo, "rev-parse", "main")).toBe(r.local);
  });

  it("the resolve run merges origin's main as fetched into a branch made from local main; local main moves only by the merge queue", async () => {
    const r = diverged();
    const cfg2: FactoryConfig = { ...config, project, repo: { ...config.repo, path: r.repo, install_command: ["sh", "-c", "exit 0"], test_command: ["sh", "-c", "exit 0"] } };
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const forge = new FakeForge();
    const controller = new ControllerRole({
      store, sources: [new LocalSource(store)], forge, auth: new OwnerAuth(store), clock, config: cfg2, log: silent, scanner: cleanScanner,
      sandbox: new NoOpSandbox(join(r.root, "wt")), repeated_failure_rule: false,
    });
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      resolve: (spec) => {
        writeFileSync(join(spec.sandbox.workdir, "shared.txt"), "local and theirs\n");
        return { output: { summary: "kept both", next_steps: "none" } };
      },
    });
    const localSandbox = new NoOpSandbox(join(r.root, "local-wt"), undefined, undefined, { local: true });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new NoOpSandbox(join(r.root, "wt")), runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock, config: cfg2, prompts,
      log: silent, scanner: cleanScanner, toolEnv: { PATH: process.env.PATH ?? "", HOME: r.root, GIT_CONFIG_GLOBAL: "/dev/null" }, awake: new NoKeepAwake(),
      local: { broker: new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: cfg2.branch_prefix, repoPath: r.repo }), sandbox: localSandbox },
    });
    await (await controller.unit("intake")).fileReconcile("main", r.remote, ["shared.txt"], reconcileSourceId("main", r.remote));
    const item = (await store.getWorkItemBySource("local", reconcileSourceId("main", r.remote)))!;
    const branch = `factory/${item.id}`;
    const originBefore = git(r.origin, "rev-parse", "main");

    // The resolve run, then the merge check and the landing.
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
    await controller.tickOutbox();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
    await controller.tickOutbox();

    const runs = await store.listRuns(item.id);
    expect(runs.map((x) => [x.kind, x.status])).toEqual([["resolve", "succeeded"], ["merge-check", "succeeded"]]);
    // The branch: local main merged with origin's fetched commit, never origin as its start.
    const head = git(r.repo, "rev-parse", branch);
    expect(git(r.repo, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1)).toEqual([r.local, r.remote]);
    expect(git(r.repo, "show", `${head}:shared.txt`)).toBe("local and theirs");
    // Local main moved once, by the merge queue's landing of that branch.
    const main = git(r.repo, "rev-parse", "main");
    expect(await store.getWorkItem(item.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: main });
    expect(git(r.repo, "rev-list", "--parents", "-n", "1", main).split(" ").slice(1)).toEqual([r.local, head]);
    expect(git(r.origin, "rev-parse", "main")).toBe(originBefore);
  });
});
