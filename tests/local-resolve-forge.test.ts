import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/compose.js";
import type { FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { type CliAction, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkerId, WorkItemId } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { StaticGrant } from "../src/impl/grant/static.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { autoResolveKey } from "../src/core/policy.js";
import { FakeBroker, FakeForge, FakeRunner, MemoryStorage, cleanScanner, config, prompts, silent, triageSpec } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// A local item's automatic resolve with a forge selected (design §5 Merge conflict, decision changed 2026-11-12):
// the controller's sandbox fetches origin, but a local item's branch and the local base are read from the factory
// repo's own refs, and its resolve run takes the local route (local sandbox, local broker): the result is committed
// on the local branch only and nothing is pushed to origin. A fake forge records every push; it must see none.

const ME = "local:me@example.com" as UserId;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const ident = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
const commitIn = (dir: string, files: Record<string, string>, msg: string) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, ...ident, "commit", "--quiet", "-m", msg);
};
const WORKFLOW = ".github/workflows/scope.yml";

async function forgeFactory(opts: { resolve?: ConstructorParameters<typeof FakeRunner>[0]["resolve"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sf-local-resolve-forge-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "init", "--quiet", "-b", "main", repo);
  commitIn(repo, { "README.md": "hi\n" }, "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "--quiet", "origin", "main");
  git(repo, "checkout", "--quiet", "-b", "work");
  const remoteRefs = () => git(origin, "for-each-ref");

  const project = localProject({ owner: "o", name: "r" });
  // A forge selected: no local_only.
  const cfg: FactoryConfig = { ...config, project, repo: { ...config.repo, path: repo, install_command: ["sh", "-c", "exit 0"], test_command: ["sh", "-c", "exit 0"] } };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new LocalSource(store);
  const forge = new FakeForge();
  const auth = new LocalAuthProvider(store, [new StaticGrant({ roles: {}, deny: {} })]);
  // The selected sandbox reads origin; the local route's reads the factory repo's local branches (as compose builds them).
  const sandbox = new NoOpSandbox(join(root, "wt"));
  const localSandbox = new NoOpSandbox(join(root, "local-wt"), undefined, undefined, { local: true });
  const controller = new ControllerRole({
    store, sources: [source], forge, auth, clock, config: cfg, log: silent, scanner: cleanScanner, sandbox, repeated_failure_rule: false,
  });
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: (spec) => {
      commitIn(spec.sandbox.workdir, { [WORKFLOW]: "name: scope\non: push\n" }, "add the scope gate");
      return { output: { summary: "added the scope gate", next_steps: "none" } };
    },
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
    resolve: opts.resolve ?? ((spec) => {
      writeFileSync(join(spec.sandbox.workdir, WORKFLOW), "name: scope\non: push\n");
      return { output: { summary: "kept the branch's workflow", next_steps: "none" } };
    }),
  });
  // The forge's broker: a local item must never reach it.
  const forgeBroker = new FakeBroker();
  const localBroker = new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: cfg.branch_prefix, repoPath: repo });
  const toolEnv = { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" };
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker: forgeBroker, storage: new MemoryStorage(), clock, config: cfg, prompts,
    log: silent, scanner: cleanScanner, toolEnv, awake: new NoKeepAwake(), local: { broker: localBroker, sandbox: localSandbox },
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let n = 0;
  const cli = (a: CliAction) =>
    runLocalCli({ store, identity: { user: ME, from: "git user.email" }, project: async () => project.key, read: async () => "the body", newId: () => `id${++n}` }, a);
  const messages = async (id: WorkItemId, prefix: string) =>
    (await store.listItemMessages(id)).filter((m) => m.marker.startsWith(prefix)).map((m) => m.body);
  const toMergePending = async () => {
    const id = (await cli({ action: "create", title: "Add a scope gate", bodyFile: "body.md" })).lines[0] as WorkItemId;
    await step();
    await cli({ action: "command", command: "approve", id, text: "" });
    await step();
    await step();
    return id;
  };
  /** A commit on the local main only (never pushed) that changes the workflow file the branch adds. */
  const conflictOnMain = () => {
    const side = join(root, "side");
    git(repo, "worktree", "add", "--quiet", side, "main");
    commitIn(side, { [WORKFLOW]: "name: other\n" }, "another workflow");
    git(repo, "worktree", "remove", side);
    return git(repo, "rev-parse", "main");
  };
  const resolves = async (id: WorkItemId) => (await store.listRuns(id)).filter((r) => r.kind === "resolve");
  return { repo, origin, remoteRefs, store, forge, forgeBroker, runner, controller, clock, step, cli, messages, toMergePending, conflictOnMain, resolves };
}

describe("a local item's automatic resolve with a forge selected", { timeout: 60_000 }, () => {
  it("factory merge on a conflict starts the resolve: the reply says so, the run reads the local base and branch, commits on the local branch only, pushes nothing", async () => {
    const f = await forgeFactory();
    const id = await f.toMergePending();
    const branch = `factory/${id}`;
    expect(await f.store.getWorkItem(id)).toMatchObject({ blocked_reason: "merge_pending", change_ref: null });
    const tip = git(f.repo, "rev-parse", branch);
    const main = f.conflictOnMain();
    // The local base and the local branch are not on origin: only the factory repo's own refs hold them.
    expect(git(f.origin, "rev-parse", "main")).not.toBe(main);
    expect(f.remoteRefs()).not.toContain(branch);
    const remoteBefore = f.remoteRefs();

    await f.cli({ action: "command", command: "merge", id, text: "" });
    await f.step();
    const reply = (await f.messages(id, "<!-- factory:refused:")).at(-1)!;
    expect(reply).toContain("does not merge cleanly");
    expect(reply).toContain(`- \`${WORKFLOW}\``);
    expect(reply).toContain("An automatic resolve run merges");

    const [run] = await f.resolves(id);
    expect([run!.idempotency_key, run!.status]).toEqual([autoResolveKey(id, main, 1), "succeeded"]);
    const changes = await f.store.listStateChanges(id);
    expect(changes.find((c) => c.reason === "auto_resolve_started")!.detail).toMatchObject({ cause: "merge_refused", base_sha: main, attempt: 1 });
    // The local base merged into the local branch, committed there; the base, origin and the forge untouched.
    const head = git(f.repo, "rev-parse", branch);
    expect(git(f.repo, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1)).toEqual([tip, main]);
    expect(git(f.repo, "show", `${head}:${WORKFLOW}`)).toBe("name: scope\non: push");
    expect(git(f.repo, "rev-parse", "main")).toBe(main);
    expect(f.remoteRefs()).toBe(remoteBefore);
    expect(f.forge.pushes).toEqual([]);
    expect(f.forgeBroker.calls).toEqual([]);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: null });
  });

  it("the merge check finds a conflict with the local base and starts the same resolve run", async () => {
    const f = await forgeFactory();
    const id = await f.toMergePending();
    await f.controller.tickMergeCheck();
    expect(await f.store.getWorkItem(id)).toMatchObject({ blocked_reason: "merge_pending" });
    const main = f.conflictOnMain();
    const remoteBefore = f.remoteRefs();

    await f.controller.tickMergeCheck();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
    expect((await f.resolves(id)).map((r) => r.idempotency_key)).toEqual([autoResolveKey(id, main, 1)]);
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(git(f.repo, "rev-list", "--parents", "-n", "1", `factory/${id}`).split(" ")).toContain(main);
    expect(f.remoteRefs()).toBe(remoteBefore);
    expect(f.forge.pushes).toEqual([]);
  });

  it("two failed automatic resolves for the local base stop at merge_conflict_pending; the local branch is unchanged", async () => {
    const f = await forgeFactory({ resolve: () => { throw new Error("the agent gave up"); } });
    const id = await f.toMergePending();
    const tip = git(f.repo, "rev-parse", `factory/${id}`);
    const main = f.conflictOnMain();
    await f.cli({ action: "command", command: "merge", id, text: "" });
    await f.step();
    expect((await f.resolves(id)).map((r) => [r.idempotency_key, r.status])).toEqual([
      [autoResolveKey(id, main, 1), "failed"], [autoResolveKey(id, main, 2), "failed"],
    ]);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending" });
    expect(git(f.repo, "rev-parse", `factory/${id}`)).toBe(tip);
  });

  it("a local item that merges cleanly runs no resolve: it goes through the merge queue and lands on the local base", async () => {
    const f = await forgeFactory();
    const id = await f.toMergePending();
    const tip = git(f.repo, "rev-parse", `factory/${id}`);
    await f.controller.tickMergeCheck();
    await f.cli({ action: "command", command: "merge", id, text: "" });
    await f.step();
    expect(await f.resolves(id)).toEqual([]);
    expect(await f.messages(id, "<!-- factory:refused:")).toEqual([]);
    expect((await f.store.listStateChanges(id)).map((c) => c.reason)).not.toContain("auto_resolve_started");
    const main = git(f.repo, "rev-parse", "main");
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: main });
    expect(git(f.repo, "rev-list", "--parents", "-n", "1", main).split(" ")).toContain(tip);
  });
});
