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
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { FakeRunner, MemoryStorage, cleanScanner, config, prompts, silent, triageSpec } from "./helpers/fakes.js";
import { BACKENDS } from "./helpers/store.js";

// The merge queue (RFC 0015 M8), end to end over a real git repo: a change whose merged result is red never lands.
// Two local changes each pass their own checks (a.yml alone, b.yml alone), but together they break the test command
// (it fails when both files exist). Both are approved for a merge at once: the first lands; the second is checked
// as it would land (base + the first) by a merge-check run, comes back red, leaves the queue with the reason, and
// the base never holds both files.

const ME = "local:me@example.com" as UserId;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const ident = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
/** Inside the spec's allowed paths. */
const DIR = ".github/workflows";
/** Fails exactly when a.yml and b.yml are both there. */
const NOT_BOTH = ["sh", "-c", `test ! -f ${DIR}/a.yml || test ! -f ${DIR}/b.yml`];

async function factory(backend: (typeof BACKENDS)[number]) {
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
    repo: { ...config.repo, path: repo, install_command: ["sh", "-c", "exit 0"], test_command: NOT_BOTH },
  };
  const clock = new FakeClock();
  const { store } = await backend.make(clock);
  const auth = new LocalAuthProvider(store, [new StaticGrant({ roles: {}, deny: {} })]);
  const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
  const controller = new ControllerRole({
    store, sources: [new LocalSource(store)], auth, local_auth: auth, clock, config: cfg, log: silent, scanner: cleanScanner, sandbox, repeated_failure_rule: false,
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
  return { repo, store, controller, step, cli, toMergePending };
}

for (const backend of BACKENDS) {
  describe(`merge queue (${backend.name})`, { timeout: 120_000 }, () => {
    it("a change whose merged result is red never lands; the change ahead of it does", async () => {
      const f = await factory(backend);
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
      // Each was checked by its own merge-check run, b on the base a landed on.
      const checks = [...(await f.store.listRuns(a)), ...(await f.store.listRuns(b))].filter((r) => r.kind === "merge-check");
      expect(checks.map((r) => r.outcome?.status === "succeeded" ? r.outcome.data.result : null)).toEqual(["green", "red"]);

      // Nothing else is checked or merged later.
      await f.step();
      expect(git(f.repo, "rev-parse", "main")).toBe(main);
    });
  });
}
