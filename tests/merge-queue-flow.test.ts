import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/compose.js";
import type { FactoryConfig } from "../src/core/config.js";
import { type CliAction, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkerId, WorkItemId } from "../src/core/types.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { StaticGrant } from "../src/impl/grant/static.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { ControllerRole, type ControllerRoleDeps } from "../src/runtime/roles/controller-role.js";
import { defineHook } from "../src/shared/hook.js";
import { Worker } from "../src/worker/index.js";
import { FakeRunner, MemoryStorage, cleanScanner, config, prompts, silent, triageSpec } from "./helpers/fakes.js";
import { BACKENDS } from "./helpers/store.js";

// The merge queue (RFC 0015 M8), end to end over a real git repo: a change whose merged result is red never lands.
// Two local changes each pass their own checks (a.yml alone, b.yml alone), but together they break the test command
// (it fails when both files exist). Both are approved for a merge at once: the first lands; the second is checked
// as it would land (base + the first) by a merge-check run, comes back red, leaves the queue with the reason, and
// the base never holds both files. At speculative depth 2 (`merge_queue.depth`) both checks run at once, b's on the
// base plus a, and two changes that pass together both land, b on the commit a landed as. A check no worker runs is
// ended by MergeCheckTimedOut; an enabled before_merge hook that vetoes keeps the base where it was.

const ME = "local:me@example.com" as UserId;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const ident = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
/** Inside the spec's allowed paths. */
const DIR = ".github/workflows";
/** Fails exactly when a.yml and b.yml are both there. */
const NOT_BOTH = ["sh", "-c", `test ! -f ${DIR}/a.yml || test ! -f ${DIR}/b.yml`];

interface Options {
  depth?: number;
  test?: string[];
  hooks?: ControllerRoleDeps["hooks"];
}

async function factory(backend: (typeof BACKENDS)[number], o: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "sf-merge-queue-"));
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "-b", "main", repo);
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", "-A");
  git(repo, ...ident, "commit", "--quiet", "-m", "init");
  git(repo, "checkout", "--quiet", "--detach");

  const project = localProject({ owner: "o", name: "r" });
  const cfg: FactoryConfig = {
    ...config, project, local_only: true,
    repo: { ...config.repo, path: repo, install_command: ["sh", "-c", "exit 0"], test_command: o.test ?? NOT_BOTH },
    merge_queue_depth: o.depth ?? 1,
  };
  const clock = new FakeClock();
  const { store } = await backend.make(clock);
  const auth = new LocalAuthProvider(store, [new StaticGrant({ roles: {}, deny: {} })]);
  const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
  const controller = new ControllerRole({
    store, sources: [new LocalSource(store)], auth, local_auth: auth, clock, config: cfg, log: silent, scanner: cleanScanner, sandbox, repeated_failure_rule: false,
    ...(o.hooks ? { hooks: o.hooks } : {}),
  });
  // The first implement run adds a.yml, the second b.yml (the changes are made one after the other).
  let implemented = 0;
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: (spec) => {
      const file = `${DIR}/${implemented++ === 0 ? "a" : "b"}.yml`;
      mkdirSync(join(spec.sandbox.workdir, DIR), { recursive: true });
      writeFileSync(join(spec.sandbox.workdir, file), "name: x\n");
      git(spec.sandbox.workdir, "add", "-A");
      git(spec.sandbox.workdir, ...ident, "commit", "--quiet", "-m", `add ${file}`);
      return { output: { summary: `added ${file}`, next_steps: "none" } };
    },
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const broker = new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: cfg.branch_prefix, repoPath: repo });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config: cfg, prompts,
    log: silent, scanner: cleanScanner, toolEnv: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" }, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let n = 0;
  const cli = (a: CliAction) =>
    runLocalCli({ store, identity: { user: ME, from: "git user.email" }, project: async () => project.key, read: async () => "the body", newId: () => `id${++n}` }, a);
  const toMergePending = async (title: string) => {
    const id = (await cli({ action: "create", title, bodyFile: "body.md" })).lines[0] as WorkItemId;
    await step();
    await cli({ action: "command", command: "approve", id, text: "" });
    await step();
    await step();
    expect(await store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    return id;
  };
  return { repo, store, clock, controller, worker, step, cli, toMergePending };
}

/** The merge-check runs of the items, in order, with what each merged and how it came back. */
async function checks(f: Awaited<ReturnType<typeof factory>>, ...ids: WorkItemId[]) {
  const runs = (await Promise.all(ids.map((id) => f.store.listRuns(id)))).flat().filter((r) => r.kind === "merge-check");
  return runs.map((r) => ({
    branches: (r.input?.merge_check as { branches: string[] }).branches.length,
    result: r.outcome?.status === "succeeded" ? r.outcome.data.result : (r.outcome?.status ?? r.status),
  }));
}

for (const backend of BACKENDS) {
  describe(`merge queue (${backend.name})`, { timeout: 120_000 }, () => {
    it.each([1, 2])("a change whose merged result is red never lands; the change ahead of it does (depth %i)", async (depth) => {
      const f = await factory(backend, { depth });
      const a = await f.toMergePending("Add a");
      const b = await f.toMergePending("Add b");
      const mainBefore = git(f.repo, "rev-parse", "main");

      await f.cli({ action: "command", command: "merge", id: a, text: "" });
      await f.cli({ action: "command", command: "merge", id: b, text: "" });
      await f.step();

      const main = git(f.repo, "rev-parse", "main");
      expect(await f.store.getWorkItem(a)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: main });
      expect(git(f.repo, "rev-list", "--parents", "-n", "1", main).split(" ")[1]).toBe(mainBefore);
      // b's merged result (base + a + b) failed the checks: the base never holds both files.
      expect(git(f.repo, "ls-tree", "-r", "--name-only", "main").split("\n").sort()).toEqual([`${DIR}/a.yml`, "README.md"]);
      expect(await f.store.getWorkItem(b)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", merge_sha: null });
      const refused = (await f.store.listItemMessages(b)).filter((m) => m.marker.startsWith("<!-- factory:refused:")).map((m) => m.body);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain("on the merged commit, so `main` did not move and the change left the merge queue");

      const queue = await f.controller.unit("merge-queue");
      expect((await queue.entries(a)).map((e) => e.state)).toEqual(["merged"]);
      expect((await queue.entries(b)).map((e) => e.state)).toEqual(["removed"]);
      // Each was checked by its own merge-check run, b on the base plus a (at depth 1 on the base a landed on).
      expect(await checks(f, a, b)).toEqual([{ branches: 1, result: "green" }, { branches: depth === 1 ? 1 : 2, result: "red" }]);

      // Nothing else is checked or merged later.
      await f.step();
      expect(git(f.repo, "rev-parse", "main")).toBe(main);
    });
    it("at depth 2 checks both at once, b on the base plus a, and both land, b on the commit a landed as", async () => {
      const f = await factory(backend, { depth: 2, test: ["sh", "-c", "exit 0"] });
      const a = await f.toMergePending("Add a");
      const b = await f.toMergePending("Add b");
      await f.cli({ action: "command", command: "merge", id: a, text: "" });
      await f.cli({ action: "command", command: "merge", id: b, text: "" });
      await f.controller.tickCommands();
      // Both checks are out before any worker ran one: b's merges a's branch and then its own.
      const queue = await f.controller.unit("merge-queue");
      expect([...(await queue.entries(a)), ...(await queue.entries(b))].map((e) => e.state)).toEqual(["checking", "checking"]);
      expect(await checks(f, a, b)).toEqual([{ branches: 1, result: "queued" }, { branches: 2, result: "queued" }]);

      await f.step();
      const main = git(f.repo, "rev-parse", "main");
      const aSha = (await f.store.getWorkItem(a))!.merge_sha;
      expect(await f.store.getWorkItem(b)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: main });
      expect(git(f.repo, "rev-list", "--parents", "-n", "1", main).split(" ")[1]).toBe(aSha);
      expect(git(f.repo, "ls-tree", "-r", "--name-only", "main").split("\n").sort()).toEqual([`${DIR}/a.yml`, `${DIR}/b.yml`, "README.md"]);
      // No check ran again: b's check on the base plus a was the tree that landed.
      expect(await checks(f, a, b)).toEqual([{ branches: 1, result: "green" }, { branches: 2, result: "green" }]);
    });

    it("a check no worker finishes is ended by MergeCheckTimedOut; its late result changes nothing", async () => {
      const f = await factory(backend, { test: ["sh", "-c", "exit 0"] });
      const a = await f.toMergePending("Add a");
      const mainBefore = git(f.repo, "rev-parse", "main");
      await f.cli({ action: "command", command: "merge", id: a, text: "" });
      await f.controller.tickCommands();
      const queue = await f.controller.unit("merge-queue");
      expect((await queue.entries(a)).map((e) => e.state)).toEqual(["checking"]);

      // Just before the timer nothing moves; past it, the delayed message ends the check.
      f.clock.advance(queue.checkTimeoutMs() - 1);
      await f.controller.tickRuns();
      expect((await queue.entries(a)).map((e) => e.state)).toEqual(["checking"]);
      f.clock.advance(1);
      await f.controller.tickRuns();
      expect((await queue.entries(a)).map((e) => [e.state, e.reason])).toEqual([["removed", "its merge check did not finish in time; run `factory merge` again"]]);
      const refused = (await f.store.listItemMessages(a)).filter((m) => m.marker.startsWith("<!-- factory:refused:")).map((m) => m.body);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain("did not finish in time");

      // The worker runs the stale check later: green, but the entry left, so nothing lands.
      while (await f.worker.tick()) await f.controller.tickRuns();
      expect(await checks(f, a)).toEqual([{ branches: 1, result: "green" }]);
      expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
      expect(await f.store.getWorkItem(a)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    });

    it("an enabled before_merge hook that vetoes keeps the base where it was; a disabled one never runs", async () => {
      const seen: string[] = [];
      const freeze = defineHook({
        name: "freeze", point: "before_merge", budget_ms: 1_000,
        run: async (input) => { seen.push(input.subject); return { kind: "veto", reason: "the base is frozen" }; },
      });
      const off = await factory(backend, { test: ["sh", "-c", "exit 0"], hooks: { enabled: [], list: [freeze] } });
      const landed = await off.toMergePending("Add a");
      await off.cli({ action: "command", command: "merge", id: landed, text: "" });
      await off.step();
      expect(await off.store.getWorkItem(landed)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
      expect(seen).toEqual([]);

      const f = await factory(backend, { test: ["sh", "-c", "exit 0"], hooks: { enabled: ["freeze"], list: [freeze] } });
      const a = await f.toMergePending("Add a");
      const mainBefore = git(f.repo, "rev-parse", "main");
      await f.cli({ action: "command", command: "merge", id: a, text: "" });
      await f.step();
      expect(seen).toEqual([a]);
      expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
      expect(await f.store.getWorkItem(a)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", merge_sha: null });
      const queue = await f.controller.unit("merge-queue");
      expect((await queue.entries(a)).map((e) => e.state)).toEqual(["removed"]);
      const refused = (await f.store.listItemMessages(a)).filter((m) => m.marker.startsWith("<!-- factory:refused:")).map((m) => m.body);
      expect(refused[0]).toContain("hook freeze: the base is frozen");
    });
  });
}
