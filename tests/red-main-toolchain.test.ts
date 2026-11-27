import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/load-config.js";
import type { FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { type CliAction, runLocalCli } from "../src/core/local-cli.js";
import { AUTO_ACTOR } from "../src/core/policy.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import type { UserId, WorkerId, WorkItemId } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { LocalForge } from "../src/impl/forge/local-forge.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { Sandbox } from "../src/interfaces/sandbox.js";
import { parseModeArgs, runSettings } from "../src/settings-cmd.js";
import { FakeRunner, MemoryStorage } from "./helpers/fakes/runner.js";
import { cleanScanner, config, prompts, silent, triageSpec } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";
import { seedMergeRecord } from "./helpers/merge-record.js";

// Red main after an automatic merge (design 03-risk): a merge-time check that fails because the host's tools are
// missing, or whose command could not run, is an environment problem, not the merge's fault. A local factory over a
// real git repo in auto mode, as in auto-mode.test.ts: the first item merges green and stores the green base; the
// second item's change makes the UI check on the new base tip fail, so without the environment rule it is reverted.

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
const OK = ["sh", "-c", "exit 0"];
/** The UI check: it prints `out` and fails on a tree holding BROKEN, which only the second item's change writes. */
const uiCheck = (out: string) => ({ command: ["sh", "-c", `if git grep -q BROKEN; then echo '${out}'; exit 1; fi`], paths: ["web/"] });

async function factory(o: { ui_check: NonNullable<FactoryConfig["repo"]["ui_check"]>; controllerSandbox?: (s: NoOpSandbox) => Sandbox; beforeSecond?: () => void }) {
  const root = mkdtempSync(join(tmpdir(), "sf-redenv-"));
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "-b", "main", repo);
  commitIn(repo, { "README.md": "hi\n" }, "init");
  git(repo, "checkout", "--quiet", "-b", "work");
  const project = localProject({ owner: "o", name: "r" });
  const file = String((triageSpec.files_to_change as string[])[0]);
  const cfg: FactoryConfig = { ...config, project, local_only: true, repo: { ...config.repo, path: repo, install_command: OK, test_command: OK, ui_check: o.ui_check } };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  await seedMergeRecord(store, clock, { tier: 2 });
  const auth = new OwnerAuth(store);
  const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
  const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store });
  const controller = new ControllerRole({
    store, sources: [new LocalSource(store)], auth, clock, config: cfg, log: silent, scanner: cleanScanner,
    sandbox: o.controllerSandbox ? o.controllerSandbox(sandbox) : sandbox, repeated_failure_rule: false, settings,
    check_env: { PATH: process.env.PATH ?? "" }, links: new LocalForge(cfg.branch_prefix, null),
  });
  let n = 0;
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: (s) => {
      commitIn(s.sandbox.workdir, { [file]: ++n === 2 ? "BROKEN\n" : `changed ${n}\n` }, "the change");
      return { output: { summary: "done", next_steps: "none" } };
    },
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const broker = new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: cfg.branch_prefix, repoPath: repo });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config: cfg, prompts, log: silent,
    scanner: cleanScanner, toolEnv: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" }, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let ids = 0;
  const cli = (a: CliAction) =>
    runLocalCli({ answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user: ME, from: "git user.email" }, project: async () => project.key, read: async () => "the body", newId: () => `id${++ids}` }, a);
  /** One item through auto mode up to its merge (the Rule of Two holds its implement run for a person's /approve). */
  const mergeOne = async (): Promise<WorkItemId> => {
    const id = (await cli({ action: "create", title: "A change", bodyFile: "b.md" })).lines[0] as WorkItemId;
    await step();
    expect((await cli({ action: "command", command: "approve", id, text: "" })).code).toBe(0);
    await step();
    return id;
  };
  await store.setSettingOverride({ key: "auto_merge_max_tier", project: "", value: "3", actor: ME });
  const action = parseModeArgs(["auto"]);
  if ("error" in action) throw new Error(action.error);
  await runSettings({ store, base: baseFromConfig(cfg), repo: { owner: "o", name: "r" }, actor: ME, resolveProject: async () => project, mayApproveMerge: async () => null }, action);
  const first = await mergeOne();
  expect(await store.getWorkItem(first)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
  o.beforeSecond?.();
  const id = await mergeOne();
  const merged = (await store.listStateChanges(id)).find((c) => c.reason === "local_merged");
  expect(merged?.actor).toEqual({ kind: "system", id: AUTO_ACTOR });
  const merge = String(merged!.changes.merge_sha!.to);
  const alerts = async (pattern: string) => (await store.listAlerts({ limit: 50 })).filter((a) => a.pattern === pattern);
  const fixItems = async () => (await store.db.all("SELECT intent_key FROM outbound_actions WHERE action = 'file_fix_item'")).map((r) => String(r.intent_key));
  const modes = async () => (await store.listSettingChanges(50)).filter((c) => c.key === "mode").map((c) => c.new_value);
  return { repo, store, id, merge, alerts, fixItems, modes };
}

type F = Awaited<ReturnType<typeof factory>>;

/** The environment path: the merge is kept, the item stays closed by it, nothing reopens, no fix item, auto mode goes on. */
async function kept(f: F) {
  expect(git(f.repo, "rev-parse", "main")).toBe(f.merge);
  expect(git(f.repo, "log", "--format=%B", "-1", "main")).not.toContain("This reverts commit");
  expect(await f.store.getWorkItem(f.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: f.merge, loop_count: 0 });
  const reasons = (await f.store.listStateChanges(f.id)).map((c) => c.reason);
  expect(reasons).not.toContain("merge_check_failed");
  expect(reasons).not.toContain("reverted");
  expect(await f.fixItems()).toEqual([]);
  expect(await f.alerts("auto_stopped")).toEqual([]);
  expect(await f.modes()).toEqual(['"auto"']);
  const env = (await f.store.listAlerts({ limit: 50 })).filter((a) => a.error_code === "checks_env");
  expect(env).toHaveLength(1);
  return env[0]!;
}

describe("red main after an automatic merge: a missing toolchain or a command that could not run", { timeout: 60_000 }, () => {
  it("output with `JAVA_HOME is not set` reverts nothing, reopens nothing, and raises one checks_env alert naming the JDK, with no fix item and auto mode on", async () => {
    const f = await factory({ ui_check: uiCheck("ERROR: JAVA_HOME is not set and no java command could be found") });
    const alert = await kept(f);
    expect(alert.detail).toContain("JDK");
    expect(alert.detail).toContain("JAVA_HOME is not set");
    expect(alert.detail).toContain("not a red main");
  });

  it("a command that could not run (a sandbox exec error) reverts nothing, reopens nothing, and the alert names the command", async () => {
    const check = uiCheck("never printed");
    let late = false;
    const throwing = (s: NoOpSandbox): Sandbox => new Proxy(s, {
      get: (t, k) => (k === "exec"
        ? async (...a: Parameters<NoOpSandbox["exec"]>) => {
          if (late && a[1].join(" ") === check.command.join(" ")) throw new Error("spawn sh ENOENT");
          return t.exec(...a);
        }
        : Reflect.get(t, k, t)),
    });
    // Only the check after the second item's merge fails to start: the first stores the green base.
    const f = await factory({ ui_check: check, controllerSandbox: throwing, beforeSecond: () => { late = true; } });
    const alert = await kept(f);
    expect(alert.detail).toContain(`\`${check.command.join(" ")}\``);
    expect(alert.detail).toContain("could not run");
    expect(alert.detail).toContain("not a red main");
  });

  it("a plain test failure still reverts the merge and reopens the item as merge_check_failed", async () => {
    const f = await factory({ ui_check: uiCheck("FAIL  tests/broken.test.ts > is green") });
    expect(git(f.repo, "rev-parse", "main^1")).toBe(f.merge);
    expect(git(f.repo, "show", "-s", "--format=%B", "main")).toContain(`This reverts commit ${f.merge}`);
    expect(await f.store.getWorkItem(f.id)).toMatchObject({ stage: "RUNNING", loop_count: 1, merge_sha: null, close_reason: null });
    expect((await f.store.listStateChanges(f.id)).map((c) => c.reason)).toContain("merge_check_failed");
    expect((await f.store.listAlerts({ limit: 50 })).some((a) => a.error_code === "checks_env")).toBe(false);
  });
});
