import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/load-config.js";
import type { FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { type CliAction, runLocalCli } from "../src/core/local-cli.js";
import { IMPROVER } from "../src/core/improver.js";
import { AUTO_ACTOR } from "../src/core/policy.js";
import { lastAutoStop, openAlarms } from "../src/ui/alarms.js";
import { systemActions } from "../src/ui/system-actions.js";
import type { ChildRestart } from "../src/interfaces/updater.js";
import { utcMinute } from "../src/core/spec-comment.js";
import { footerCommands } from "../src/impl/source/slack-format.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import { RECURRING_FAILURE, type Tier, type UserId, type WorkerId, type WorkItemId } from "../src/core/types.js";
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
import { issue, newStore, system } from "./helpers/store.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";
import { seedMergeRecord } from "./helpers/merge-record.js";

// Auto mode (design 03-risk, issue #444): a local factory over a real git repo, as in local-merge-flow.test.ts, with the
// live settings read from the store each tick. The mode is flipped after the controller is built, so every test also
// shows a running controller reading the new mode at its next tick, with no restart. Each factory starts with a met
// merge record for the review's tier (50 clean merges), so the tier rule lets its change merge unless a test says otherwise.

const ME = "local:me@example.com" as UserId;
const DEV = "local:dev@example.com" as UserId;
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
/** A check that passes everywhere except on a merge commit (the merge queue's merge-check run checks one). */
const FAILS_ON_MERGE = ["sh", "-c", "git rev-parse -q --verify HEAD^2 >/dev/null && exit 1; exit 0"];
const OK = ["sh", "-c", "exit 0"];
/**
 * A UI check that passes on the merge check's merged commit (its subject ends in "(merge check)") and runs `script`
 * anywhere else, such as on the new base tip after an automatic merge: the change lands, and the red-main check fails.
 */
const uiAfterMerge = (script: string) => ["sh", "-c", `git log -1 --format=%s | grep -q '(merge check)$' && exit 0; ${script}`];
/** A change to a `repo.ui_check` path ("web/"), so the merge check and the red-main check after its merge run the UI check. */
const UI_CHANGE = { allowed_paths: ["web/"], files_to_change: ["web/app.css"] };

interface Opts {
  /** The triage answer, over triageSpec. */
  spec?: Record<string, unknown>;
  /** The review's tier. */
  reviewTier?: number;
  test_command?: string[];
  /** Wraps the controller's sandbox (the worker keeps the real one); `clock` is the factory's. */
  controllerSandbox?: (s: NoOpSandbox, clock: FakeClock) => Sandbox;
  /** The text the `n`th implement run (1-based, across items) writes to the spec's file; default "changed\n". */
  change?: (n: number) => string;
  config?: Partial<FactoryConfig>;
  /** The supervisor's restart list the alarm step reads. */
  restarts?: () => Promise<readonly ChildRestart[]>;
  /** `repo.ui_check`: run at merge on a change to its paths, and on the new base tip after an automatic merge. */
  ui_check?: FactoryConfig["repo"]["ui_check"];
  /** The review tier's merge record seeded before the change (seedMergeRecord); default 50 clean merges, a met rule. */
  record?: { merges?: number; bad?: number };
}

async function autoFactory(opts: Opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "sf-auto-"));
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "-b", "main", repo);
  commitIn(repo, { "README.md": "hi\n" }, "init");
  git(repo, "checkout", "--quiet", "-b", "work");

  const project = localProject({ owner: "o", name: "r" });
  const spec = { ...triageSpec, ...opts.spec };
  const file = String((spec.files_to_change as string[])[0]);
  const cfg: FactoryConfig = {
    ...config,
    project,
    local_only: true,
    repo: { ...config.repo, path: repo, install_command: OK, test_command: opts.test_command ?? OK, ...(opts.ui_check ? { ui_check: opts.ui_check } : {}) },
    ...opts.config,
  };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  await seedMergeRecord(store, clock, { tier: (opts.reviewTier ?? 2) as Tier, ...opts.record });
  const auth = new OwnerAuth(store);
  const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
  const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store });
  const controller = new ControllerRole({
    store, sources: [new LocalSource(store)], auth, clock, config: cfg, log: silent, scanner: cleanScanner,
    sandbox: opts.controllerSandbox ? opts.controllerSandbox(sandbox, clock) : sandbox, repeated_failure_rule: false, settings,
    check_env: { PATH: process.env.PATH ?? "" }, links: new LocalForge(cfg.branch_prefix, null), ...(opts.restarts ? { restarts: opts.restarts } : {}),
  });
  let implemented = 0;
  const runner = new FakeRunner({
    triage: () => ({ output: spec }),
    implement: (s) => {
      commitIn(s.sandbox.workdir, { [file]: opts.change?.(++implemented) ?? "changed\n" }, "the change");
      return { output: { summary: "done", next_steps: "none" } };
    },
    review: () => ({ output: { verdict: "pass", tier: opts.reviewTier ?? 2, findings: [], summary: "s" } }),
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
  let n = 0;
  const cli = (user: UserId, a: CliAction) =>
    runLocalCli({ answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user, from: "git user.email" }, project: async () => project.key, read: async () => "the body", newId: () => `id${++n}` }, a);
  const create = async () => (await cli(ME, { action: "create", title: "A change", bodyFile: "b.md" })).lines[0] as WorkItemId;
  /** An item the improve run files for a recurring failure (design §7), through the local source as the improver. */
  const fileAsImprover = async () => {
    const source = await new LocalSource(store).fileIssue({
      project: project.key, requester_id: IMPROVER.id as UserId, title: "Recurring failure", body: "the runs", marker: "<!-- factory:improve:k:ir_1 -->",
    });
    return (await store.getWorkItemBySource(source.type, source.id))!.id;
  };
  /** A person's `/approve` of the implement run the Rule of Two held after auto mode's approval, then a step. */
  const approveRun = async (id: WorkItemId) => {
    expect(await store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: "rule_of_two" });
    expect((await cli(ME, { action: "command", command: "approve", id, text: "" })).code).toBe(0);
    await step();
  };
  /** `factory mode <mode> [--project o/r]` as `who`, with the local auth plugin's approve_merge check. */
  const mode = async (m: string, who: UserId = ME, ...rest: string[]) => {
    const action = parseModeArgs([m, ...rest]);
    if ("error" in action) throw new Error(action.error);
    return runSettings({
      store, base: baseFromConfig(cfg), repo: { owner: "o", name: "r" }, actor: who, resolveProject: async () => project,
      mayApproveMerge: async () => {
        const d = await auth.authorize({ user_id: who }, "approve_merge", { kind: "project", id: project.key });
        return d.allow ? null : d.reason;
      },
    }, action);
  };
  const setting = (key: string, value: unknown) => store.setSettingOverride({ key, project: "", value: JSON.stringify(value), actor: ME });
  const messages = async (id: WorkItemId, prefix: string) => (await store.listItemMessages(id)).filter((m) => m.marker.startsWith(prefix)).map((m) => m.body);
  const changes = async (id: WorkItemId) => store.listStateChanges(id);
  const modeRows = async () => (await store.listSettingChanges(50)).filter((c) => c.key === "mode");
  return { repo, store, controller, step, cli, create, fileAsImprover, approveRun, mode, setting, messages, changes, modeRows, project, clock, cfg };
}

const AUTO = { kind: "system", id: AUTO_ACTOR };

describe("auto mode: specs", { timeout: 60_000 }, () => {
  it("manual (no mode stored): a spec waits for /approve as before", async () => {
    const f = await autoFactory();
    const id = await f.create();
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect(await f.modeRows()).toEqual([]);
  });

  it("a spec below tier 4 with no decisions is approved with no /approve, actor system:auto, naming the mode change", async () => {
    const f = await autoFactory();
    expect((await f.mode("auto")).ok).toBe(true);
    const [flip] = await f.modeRows();
    const id = await f.create();
    await f.step();
    const approved = (await f.changes(id)).find((c) => c.reason === "spec_approved")!;
    expect(approved.actor).toEqual(AUTO);
    expect(approved.detail).toMatchObject({ approved_by: AUTO_ACTOR, mode_change: flip!.seq });
  });

  it("Rule of Two: the implement run auto mode approved is not started; the item waits for a person, and the reply says why", async () => {
    const f = await autoFactory();
    await f.mode("auto");
    const id = await f.create();
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: "rule_of_two" });
    expect((await f.store.listRuns(id)).map((r) => r.kind)).toEqual(["triage"]);
    const approved = (await f.changes(id)).find((c) => c.reason === "spec_approved")!;
    expect(approved.detail).toMatchObject({ held_by: "rule_of_two", held_run_kind: "implement" });
    const [reply] = await f.messages(id, "<!-- factory:rule-of-two:");
    expect(reply).toContain("a person must approve before it runs");
    expect(reply).toContain("Reply `/approve` to start it");
  });

  it("Rule of Two: a person's /approve starts the held implement run, with the person as actor", async () => {
    const f = await autoFactory();
    await f.mode("auto");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    const approved = (await f.changes(id)).find((c) => c.reason === "rule_of_two_approved")!;
    expect(approved.actor).toEqual({ kind: "user", id: ME });
    expect((await f.store.listRuns(id)).map((r) => r.kind)).toEqual(["triage", "implement", "review"]);
    expect((await f.changes(id)).map((c) => c.reason)).toContain("implemented");
  });

  it("a spec with decisions is approved with each proposed default, and the answers are posted in the thread", async () => {
    const decisions = [
      { text: "Fail the job, or only warn?", default: "Fail the job", owner_only: false },
      { text: "Name the step?", default: "scope", owner_only: false },
    ];
    const f = await autoFactory({ spec: { decisions } });
    await f.mode("auto");
    const id = await f.create();
    await f.step();
    const approved = (await f.changes(id)).find((c) => c.reason === "spec_approved")!;
    expect(approved.actor).toEqual(AUTO);
    expect(approved.detail).toMatchObject({ approved_by: AUTO_ACTOR, decisions: 2 });
    const spec = (await f.messages(id, "<!-- factory:spec:")).join("\n");
    expect(spec).toContain("Auto mode (`system:auto`) approves");
    expect(spec).toContain("- Fail the job, or only warn? → Fail the job");
    expect(spec).toContain("- Name the step? → scope");
  });

  it("an auto-approved spec names the approval with its tier and time, and offers no /approve: no answer block, no Approve button (issue #586)", async () => {
    const decisions = [{ text: "Fail the job, or only warn?", default: "Fail the job", owner_only: false }];
    const f = await autoFactory({ spec: { decisions } });
    await f.mode("auto");
    const id = await f.create();
    await f.step();
    const approved = (await f.changes(id)).find((c) => c.reason === "spec_approved")!;
    const tier = (await f.store.getWorkItem(id))!.tier;
    const [spec] = await f.messages(id, "<!-- factory:spec:");
    expect(spec).toContain(`Approved automatically (auto mode, tier ${tier}) at ${utcMinute(approved.at)}.`);
    expect(spec).not.toContain("To answer, reply");
    expect(spec).not.toContain("`/approve");
    // The footer a source builds its buttons from lists no approve.
    expect(footerCommands(spec!)).not.toContain("approve");
  });

  for (const [what, spec] of [
    ["an owner-only decision", { decisions: [{ text: "Drop the table?", default: "Yes", owner_only: true }] }],
    ["a decision with no flag", { decisions: [{ text: "Drop the table?", default: "Yes" }] }],
    ["a plain-text decision", { decisions: ["Drop the table?"] }],
    ["a tier 4 spec", { tier: 4 }],
    ["allowed paths on the gate list", { allowed_paths: ["prompts/"], files_to_change: ["prompts/x.md"] }],
    ["allowed paths that hold a gate path", { allowed_paths: ["src/"], files_to_change: ["src/x.ts"] }],
  ] as const) {
    it(`${what} waits for /approve, and the spec says why`, async () => {
      const f = await autoFactory({ spec });
      await f.mode("auto");
      const id = await f.create();
      await f.step();
      expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
      expect((await f.changes(id)).some((c) => c.reason === "spec_approved")).toBe(false);
      expect((await f.messages(id, "<!-- factory:spec:")).join("\n")).toContain("Auto mode is on, but this spec waits for `/approve`");
    });
  }
});

describe("auto mode: merges", { timeout: 60_000 }, () => {
  it("a reviewed local change that passed its checks merges through the local merge, actor system:auto, naming the mode change", async () => {
    const f = await autoFactory();
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const [flip] = await f.modeRows();
    const mainBefore = git(f.repo, "rev-parse", "main");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    const done = (await f.store.getWorkItem(id))!;
    expect(done).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: git(f.repo, "rev-parse", "main") });
    expect(git(f.repo, "rev-parse", "main")).not.toBe(mainBefore);
    const merged = (await f.changes(id)).find((c) => c.reason === "local_merged")!;
    expect(merged.actor).toEqual(AUTO);
    // Through merge_queued, as a person's merge: moved by system:auto with its merge key before the check.
    const reasons = (await f.changes(id)).map((c) => c.reason);
    expect(reasons.indexOf("merge_requested")).toBeGreaterThan(-1);
    expect(reasons.indexOf("merge_requested")).toBeLessThan(reasons.indexOf("merge_check_queued"));
    expect((await f.changes(id)).find((c) => c.reason === "merge_requested")).toMatchObject({
      actor: AUTO, changes: { blocked_reason: { from: "merge_pending", to: "merge_queued" } }, detail: { merge_key: expect.stringMatching(/^auto-merge:/) },
    });
    expect(merged.detail).toMatchObject({ mode_change: flip!.seq });
    expect((await f.messages(id, "<!-- factory:local-merged:")).join("")).toContain("in auto mode");
    // The red-main check passed: still auto, no alert.
    expect(await f.store.listAlerts({ limit: 10 })).toEqual([]);
    expect((await f.modeRows()).map((r) => r.new_value)).toEqual(['"auto"']);
  });

  it("the drop-back: a holding tier still merges with 1 reverted merge among its last 20", async () => {
    const f = await autoFactory({ record: { merges: 51, bad: 1 } });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect(await f.messages(id, "<!-- factory:auto-merge-held:")).toEqual([]);
  });

  it("the drop-back: after 2 reverted merges among its last 20 the tier waits for a person, and the stored setting is unchanged", async () => {
    const f = await autoFactory({ record: { merges: 52, bad: 2 } });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const settingRows = async () => (await f.store.listSettingChanges(50)).filter((c) => c.key === "auto_merge_max_tier");
    const before = await settingRows();
    const mainBefore = git(f.repo, "rev-parse", "main");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
    const held = await f.messages(id, "<!-- factory:auto-merge-held:");
    expect(held).toHaveLength(1);
    expect(held[0]).toContain("tier 2 dropped back: 2 or more of its last 20 merges were reverted or fixed forward");
    expect(await settingRows()).toEqual(before);
    expect((await f.store.listSettingOverrides()).find((o) => o.key === "auto_merge_max_tier")).toMatchObject({ value: "3" });
  });

  it("with auto_merge_max_tier at its default 0, a reviewed change waits for a person, and the reply says why", async () => {
    const f = await autoFactory();
    await f.mode("auto");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect((await f.messages(id, "<!-- factory:auto-merge-held:")).join("")).toContain("above auto_merge_max_tier (0)");
  });

  for (const [what, o] of [
    ["a tier 4 change", { reviewTier: 4 }],
    ["a change touching the gate list", { spec: { allowed_paths: ["prompts/"], files_to_change: ["prompts/x.md"] } }],
  ] as const) {
    it(`${what} stays in merge_pending and never merges, whatever its checks say`, async () => {
      const f = await autoFactory(o);
      await f.setting("auto_merge_max_tier", 3);
      await f.mode("auto");
      const mainBefore = git(f.repo, "rev-parse", "main");
      const id = await f.create();
      await f.step();
      // A spec auto mode may not approve waits for /approve; one it approved waits for a person under the Rule of Two.
      await f.cli(ME, { action: "command", command: "approve", id, text: "" });
      await f.step();
      await f.step();
      expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
      expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
      expect((await f.changes(id)).some((c) => c.reason === "local_merged")).toBe(false);
      expect(await f.messages(id, "<!-- factory:auto-merge-held:")).toHaveLength(1);
    });
  }

  it("an item the improver filed is triaged with no person starting it, and its change touching the gate list waits for a person's merge", async () => {
    const f = await autoFactory({ spec: { allowed_paths: ["prompts/"], files_to_change: ["prompts/x.md"] } });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const mainBefore = git(f.repo, "rev-parse", "main");
    const id = await f.fileAsImprover();
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ requester_id: IMPROVER.id, stage: "READY", blocked_reason: "spec_pending" });
    expect((await f.messages(id, "<!-- factory:spec:")).join("\n")).toContain("Auto mode is on, but this spec waits for `/approve`");
    await f.cli(ME, { action: "command", command: "approve", id, text: "" });
    await f.step();
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
    expect((await f.changes(id)).some((c) => c.reason === "local_merged")).toBe(false);
    expect((await f.messages(id, "<!-- factory:auto-merge-held:")).join("")).toContain("it touches the gate list (`prompts/");
  });

  it("a merge whose checks fail on the merge commit moves nothing and sends the item back to implement as a loop", async () => {
    const f = await autoFactory({ test_command: FAILS_ON_MERGE });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const mainBefore = git(f.repo, "rev-parse", "main");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", loop_count: 1 });
    expect((await f.changes(id)).map((c) => c.reason)).toContain("merge_check_failed");
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
    // Tried once for this version of the item: one refusal, not one per tick.
    const refused = await f.messages(id, "<!-- factory:refused:auto-merge:");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("The automatic merge was not applied");
    expect(refused[0]).toContain("the factory sent it back to the implementer (loop 1 of");
  });

  it("a sync source's item is never merged in auto mode: it waits as in manual mode, with no post", async () => {
    const f = await autoFactory();
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const { item: it0 } = await f.store.createWorkItem({ ...issue(7), project: f.project.key }, system);
    const r = await f.store.transition({
      id: it0.id, expected_version: it0.version, actor: system, reason: "test",
      patch: { stage: "REVIEW", tier: 1, change_ref: "7", allowed_paths: ["docs/"], blocked_on: "human", blocked_reason: "merge_pending" },
    });
    expect(r.ok).toBe(true);
    await f.controller.tickRuns();
    expect(await f.store.getWorkItem(it0.id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(await f.store.listItemMessages(it0.id)).toEqual([]);
  });
});

/** Auto mode was set back to manual once, by `system:auto`, with one `auto_stopped` alert of `cause`. */
const stopped = async (f: Awaited<ReturnType<typeof autoFactory>>, cause: string) => {
  const rows = await f.modeRows();
  expect(rows.map((r) => [r.new_value, r.actor])).toEqual([['"manual"', AUTO_ACTOR], ['"auto"', ME]]);
  const alerts = (await f.store.listAlerts({ limit: 10 })).filter((a) => a.pattern === "auto_stopped");
  expect(alerts.map((a) => a.error_code)).toEqual([cause]);
};

describe("auto mode: stop conditions", { timeout: 60_000 }, () => {
  it("red main: the checks fail on the new base tip after an auto merge, so the mode goes back to manual", async () => {
    const failing = (s: NoOpSandbox): Sandbox => new Proxy(s, {
      get: (t, k) => (k === "exec" ? async () => ({ exit_code: 1, signal: null, stdout: "", stderr: "", timed_out: false }) : Reflect.get(t, k, t)),
    });
    const f = await autoFactory({ controllerSandbox: failing });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const first = await f.create();
    await f.step();
    await f.approveRun(first);
    expect(await f.store.getWorkItem(first)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    await stopped(f, "red_main");
    // The stop is in force: its time and cause reach the Mode toggle and the system banner.
    const [alert] = (await f.store.listAlerts({ limit: 10 })).filter((a) => a.pattern === "auto_stopped");
    // The failing command printed nothing: no test names and no tail to keep.
    expect(await lastAutoStop(f.store)).toEqual({ alert_id: alert!.id, at: alert!.created_at, cause: "red_main", failing_tests: [], output_tail: null });
    const actions = await systemActions({ store: f.store, factory: null, deps: {}, now: f.clock.now(), dashboardRev: null });
    const line = actions.find((a) => a.auto_stop)!;
    expect(line.auto_stop).toMatchObject({ alert_id: alert!.id, cause: "red_main" });
    expect(line.text).toContain("Alarm: back to manual: the checks failed on the base branch after a merge");
    // The time is a field (`auto_stop.at`), never inside the sentence.
    expect(line.text).not.toMatch(/\d{4}-\d{2}-\d{2}|UTC/);
    expect(line.auto_stop!.at).toBe(alert!.created_at);
    // Manual again: the next spec waits.
    const next = await f.create();
    await f.step();
    expect(await f.store.getWorkItem(next)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
  });

  it("red main from the UI check: after an auto merge it runs on the new base tip; a failure raises one red_main alert on that tip, files its fix item and stops auto mode", async () => {
    // The change touches a UI path; the UI check passes at its merge check and fails on the base tip after the merge.
    const command = uiAfterMerge("echo 'FAIL  tests/layout.test.ts > fits'; echo layout broken; exit 1");
    const f = await autoFactory({ spec: UI_CHANGE, ui_check: { command, paths: ["web/"] } });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const first = await f.create();
    await f.step();
    await f.approveRun(first);
    expect(await f.store.getWorkItem(first)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    await stopped(f, "red_main");
    const tip = git(f.repo, "rev-parse", "main");
    const red = (await f.store.listAlerts({ limit: 10 })).filter((a) => a.pattern === "red_main");
    expect(red.map((a) => a.pattern_key)).toEqual([`red_main:${tip}`]);
    // The alert's detail keeps the sentence, the failing tests by name and the output tail (no new column).
    expect(JSON.parse(red[0]!.detail!)).toEqual({
      text: `\`${command.join(" ")}\` exited 1 on the new tip of \`main\``,
      failing_tests: ["tests/layout.test.ts > fits"],
      output_tail: "FAIL  tests/layout.test.ts > fits\nlayout broken\n",
    });
    // The overview's red_main alarm and the stop carry them to What failed.
    const actions = await systemActions({ store: f.store, factory: null, deps: {}, now: f.clock.now(), dashboardRev: null });
    expect(actions.find((a) => a.pattern === "red_main")).toMatchObject({ failing_tests: ["tests/layout.test.ts > fits"], output_tail: "FAIL  tests/layout.test.ts > fits\nlayout broken\n" });
    expect((await lastAutoStop(f.store))).toMatchObject({ cause: "red_main", failing_tests: ["tests/layout.test.ts > fits"] });
    const fixes = await f.store.db.all("SELECT intent_key FROM outbound_actions WHERE action = 'file_fix_item'");
    expect(fixes.map((r) => r.intent_key)).toEqual([`file_fix_item:red_main:${tip}`]);
  });

  it("red main from the UI check with a tail the egress scan flags: the tail is stored as null and the test names are kept", async () => {
    // The key is put together by the shell, so only the output holds it, not the command in the sentence.
    const print = "printf 'FAIL  tests/layout.test.ts > fits\\nAKIA%s\\n' ABCDEFGHIJKLMNOP; exit 1";
    const f = await autoFactory({ spec: UI_CHANGE, ui_check: { command: uiAfterMerge(print), paths: ["web/"] } });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const first = await f.create();
    await f.step();
    await f.approveRun(first);
    await stopped(f, "red_main");
    const [red] = (await f.store.listAlerts({ limit: 10 })).filter((a) => a.pattern === "red_main");
    expect(JSON.parse(red!.detail!)).toMatchObject({ failing_tests: ["tests/layout.test.ts > fits"], output_tail: null });
    expect(red!.detail).not.toContain("AKIA" + "ABCDEFGHIJKLMNOP");
  });

  it("red main at the merge check in auto mode: the change stays queued, one red_main alert is stored and auto mode stops", async () => {
    const f = await autoFactory({ spec: { allowed_paths: ["web/"], files_to_change: ["web/app.css"] }, ui_check: { command: ["sh", "-c", "exit 1"], paths: ["web/"] } });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const main = git(f.repo, "rev-parse", "main");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", loop_count: 0, merge_sha: null });
    expect(git(f.repo, "rev-parse", "main")).toBe(main);
    expect((await (await f.controller.unit("merge-queue")).entries(id)).map((e) => e.state)).toEqual(["queued"]);
    expect(await f.store.getWorkItem(id)).toMatchObject({ blocked_on: "ci", blocked_reason: "merge_queued" });
    expect((await f.store.listAlerts({ limit: 10 })).filter((a) => a.pattern === "red_main").map((a) => a.pattern_key)).toEqual([`red_main:${main}`]);
    await stopped(f, "red_main");
    // A later auto pass on the queued item records nothing new.
    await f.mode("auto");
    const before = (await f.changes(id)).length;
    await (await f.controller.unit("local-merge")).autoMergeStep();
    expect((await f.changes(id)).length).toBe(before);
    expect(await f.store.getWorkItem(id)).toMatchObject({ blocked_on: "ci", blocked_reason: "merge_queued" });
  });

  it("a burst of agent-run failures leaves the mode auto: the alarm is open and the failing item is held", async () => {
    const f = await autoFactory({ spec: { tier: 9 } });
    await f.setting("alarm_repeat_count", 1);
    await f.mode("auto");
    const id = await f.create();
    // An invalid triage answer fails its run: one failed run is a burst at alarm_repeat_count 1.
    await f.step();
    const failed = (await f.store.listRuns(id)).find((r) => r.status === "failed");
    expect(failed?.outcome).toMatchObject({ status: "failed", error_code: "invalid_output" });
    await f.controller.tickAlarms();
    await f.controller.tickAlarms();
    // Auto mode goes on: no stop alert, no settings row by system:auto.
    expect((await f.modeRows()).map((r) => [r.new_value, r.actor])).toEqual([['"auto"', ME]]);
    expect((await f.store.listAlerts({ limit: 10 })).some((a) => a.pattern === "auto_stopped")).toBe(false);
    expect(await lastAutoStop(f.store)).toBeNull();
    // The alarm shows as open.
    expect((await openAlarms(f.store, f.clock.now())).map((a) => [a.pattern, a.error_code])).toContainEqual(["repeated_error", "invalid_output"]);
    // The failing item is held for a person: its queued runs are not claimed.
    expect(await f.store.getWorkItem(id)).toMatchObject({ blocked_on: "human", blocked_reason: RECURRING_FAILURE });
    await f.store.enqueueRun({ work_item_id: id, kind: "triage", idempotency_key: "after-hold" });
    expect(await f.store.claimRun({ worker_id: "w9" as WorkerId, kinds: ["triage"], lease_ms: 60_000 })).toBeNull();
  });

  it("a child crash loop still sets the mode to manual, once, however often the alarm step runs", async () => {
    let restarts: ChildRestart[] = [];
    const f = await autoFactory({ restarts: async () => restarts });
    await f.mode("auto");
    const now = f.clock.now().getTime();
    restarts = Array.from({ length: 5 }, (_, i) => ({ at: new Date(now - i * 60_000).toISOString(), reason: `exit ${i}` }));
    await f.controller.tickAlarms();
    await f.controller.tickAlarms();
    await stopped(f, "failure_alert");
    expect(await lastAutoStop(f.store)).toMatchObject({ cause: "failure_alert" });
  });

  it("a stop whose settings write failed after its alert: the next stop sets manual, not one 6 h later", async () => {
    const budgets = { 2: 20 };
    const f = await autoFactory({ config: { settings: { ...config.settings, defaults: { ...config.settings.defaults, budgets } } } });
    await f.mode("auto");
    const write = f.store.setSettingOverride.bind(f.store);
    let failed = false;
    f.store.setSettingOverride = async (o) => {
      if (o.actor === AUTO_ACTOR && !failed) {
        failed = true;
        throw new Error("store down");
      }
      return write(o);
    };
    const first = await f.create();
    await f.step();
    await f.approveRun(first).catch(() => undefined);
    expect(failed).toBe(true);
    expect(await f.modeRows()).toHaveLength(1);
    // The alert is recorded and deduped for 6 h; a second checkpoint's stop finds the mode still auto and sets it.
    const second = await f.create();
    await f.step();
    await f.approveRun(second);
    await stopped(f, "budget_checkpoint");
  });

  it("a budget checkpoint sets the mode to manual", async () => {
    const budgets = { 2: 20 };
    const f = await autoFactory({ config: { settings: { ...config.settings, defaults: { ...config.settings.defaults, budgets } } } });
    await f.mode("auto");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    expect(await f.store.getWorkItem(id)).toMatchObject({ blocked_on: "budget", blocked_reason: "budget_checkpoint" });
    await stopped(f, "budget_checkpoint");
  });

  it("in manual mode a stop condition writes nothing", async () => {
    const f = await autoFactory({ spec: { tier: 9 } });
    await f.setting("alarm_repeat_count", 1);
    await f.create();
    await f.step();
    await f.controller.tickAlarms();
    expect(await f.modeRows()).toEqual([]);
    expect((await f.store.listAlerts({ limit: 10 })).some((a) => a.pattern === "auto_stopped")).toBe(false);
  });
});

describe("auto mode: red main reverts a bad automatic merge", { timeout: 60_000 }, () => {
  // The UI check fails on a tree holding BROKEN, except on the merge check's merged commit. Each change touches a UI
  // path (web/app.css), so the merge check runs the UI check and passes, the change lands, and the red-main check on
  // the new base tip, whose change touches that path too, runs it and fails. The first item's change is clean, so its
  // check passes and stores the green base the second item's merge lands on.
  const FAILING = "FAIL  tests/broken.test.ts > is green";
  const uiCheck = (flag = "/nonexistent") => ({
    command: uiAfterMerge(`if git grep -q BROKEN || test -f ${flag}; then echo '${FAILING}'; exit 1; fi`), paths: ["web/"],
  });
  const brokenSecond = (n: number) => (n === 2 ? "BROKEN\n" : `changed ${n}\n`);
  const alerts = async (f: Awaited<ReturnType<typeof autoFactory>>, pattern: string) =>
    (await f.store.listAlerts({ limit: 50 })).filter((a) => a.pattern === pattern);
  const fixItems = async (f: Awaited<ReturnType<typeof autoFactory>>) =>
    (await f.store.db.all("SELECT intent_key FROM outbound_actions WHERE action = 'file_fix_item'")).map((r) => String(r.intent_key));

  /** Auto mode with the tier allowed; the first item merges green. Returns the green base. */
  async function greenFirst(f: Awaited<ReturnType<typeof autoFactory>>): Promise<string> {
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const first = await f.create();
    await f.step();
    await f.approveRun(first);
    expect(await f.store.getWorkItem(first)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect(await alerts(f, "red_main")).toEqual([]);
    return git(f.repo, "rev-parse", "main");
  }

  /** The second item through auto mode up to its merge; returns its id and the merge commit it landed as. */
  async function second(f: Awaited<ReturnType<typeof autoFactory>>): Promise<{ id: WorkItemId; merge: string }> {
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    const merged = (await f.changes(id)).find((c) => c.reason === "local_merged");
    expect(merged?.actor).toEqual(AUTO);
    return { id, merge: String(merged!.changes.merge_sha!.to) };
  }

  async function reverted(opts: Opts = {}) {
    const f = await autoFactory({ spec: UI_CHANGE, ui_check: uiCheck(), change: brokenSecond, ...opts });
    const green = await greenFirst(f);
    const { id, merge } = await second(f);
    return { f, green, id, merge, tip: git(f.repo, "rev-parse", "main") };
  }

  it("a change that breaks a check on the base is reverted: main is green again, the item is back at implement with the output, auto mode goes on", async () => {
    const { f, green, id, merge, tip } = await reverted();
    // The revert sits on the merge, with the green base's tree and git's own message.
    expect(git(f.repo, "rev-parse", "main^1")).toBe(merge);
    expect(git(f.repo, "rev-parse", "main^{tree}")).toBe(git(f.repo, "rev-parse", `${green}^{tree}`));
    expect(git(f.repo, "show", "-s", "--format=%B", "main")).toContain(`This reverts commit ${merge}, reversing\nchanges made to ${green}.`);
    // The item is reopened at implement as a loop, with the failing output in the stored detail.
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", loop_count: 1, merge_sha: null, close_reason: null });
    const loop = (await f.changes(id)).find((c) => c.reason === "merge_check_failed")!;
    expect(loop.detail).toMatchObject({
      reverted: true, merge_sha: merge, revert_sha: tip, failing_tests: JSON.stringify(["tests/broken.test.ts > is green"]), output_tail: `${FAILING}\n`,
    });
    // Its branch holds the change again on top of the revert, so the next attempt lands it.
    const branch = `${f.cfg.branch_prefix}${id}`;
    expect(git(f.repo, "rev-parse", `${branch}^1`)).toBe(tip);
    expect(git(f.repo, "rev-parse", `${branch}^{tree}`)).toBe(git(f.repo, "rev-parse", `${merge}^{tree}`));
    // Still auto: one red_main alert on the merge that says it was reverted, no fix item, no stop.
    expect((await f.modeRows()).map((r) => r.new_value)).toEqual(['"auto"']);
    expect(await alerts(f, "auto_stopped")).toEqual([]);
    const red = await alerts(f, "red_main");
    expect(red.map((a) => a.pattern_key)).toEqual([`red_main:${merge}`]);
    expect(JSON.parse(red[0]!.detail!).text).toContain(`the factory reverted the merge of ${id}`);
    expect(await fixItems(f)).toEqual([]);
    // The revert tracking records it on the item as any revert.
    const marks = (await f.changes(id)).filter((c) => c.reason === "reverted");
    expect(marks.map((c) => c.detail?.reverting_commit)).toEqual([tip]);
    expect((await f.store.listVerdicts(id)).filter((v) => v.verdict === "reverted").map((v) => v.reason)).toEqual([`reverted by commit ${tip}`]);
  });

  it("a second run for the same merge (another replica) changes nothing and adds no loop", async () => {
    const { f, id, merge, tip } = await reverted();
    const before = { item: await f.store.getWorkItem(id), changes: await f.changes(id), alerts: await f.store.listAlerts({ limit: 50 }), modes: await f.modeRows() };
    const atMerge = { ...before.item!, stage: "CLOSED" as const, close_reason: "completed" as const, merge_sha: merge };
    await (await f.controller.unit("local-merge")).redMainCheck(atMerge);
    expect(git(f.repo, "rev-parse", "main")).toBe(tip);
    expect(await f.store.getWorkItem(id)).toEqual(before.item);
    expect(await f.changes(id)).toEqual(before.changes);
    expect(await f.store.listAlerts({ limit: 50 })).toEqual(before.alerts);
    expect(await f.modeRows()).toEqual(before.modes);
  });

  it("at max_loops the reverted item waits on a person instead of a new implement run", async () => {
    const { f, id, merge, tip } = await reverted({ config: { max_loops: 1 } });
    expect(git(f.repo, "rev-parse", "main^1")).toBe(merge);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "max_loops", loop_count: 0, merge_sha: null });
    expect((await f.changes(id)).find((c) => c.reason === "max_loops")?.detail).toMatchObject({ reverted: true, revert_sha: tip });
    expect((await f.store.listRuns(id)).some((r) => r.kind === "implement" && r.idempotency_key.includes(":l1:"))).toBe(false);
    expect((await f.modeRows()).map((r) => r.new_value)).toEqual(['"auto"']);
  });

  it("when the checks still fail after the revert, auto mode goes back to manual, red main is raised and the revert stays", async () => {
    const flag = join(mkdtempSync(join(tmpdir(), "sf-flag-")), "red");
    // The base turns red by itself as the revert lands: the re-run fails on the reverted tip too.
    const redAfterRevert = (s: NoOpSandbox): Sandbox => new Proxy(s, {
      get: (t, k) => (k === "revertLocal"
        ? async (...a: Parameters<NoOpSandbox["revertLocal"]>) => {
          const r = await t.revertLocal(...a);
          writeFileSync(flag, "");
          return r;
        }
        : Reflect.get(t, k, t)),
    });
    const { f, merge, tip, id } = await reverted({ ui_check: uiCheck(flag), controllerSandbox: redAfterRevert });
    expect(git(f.repo, "rev-parse", "main^1")).toBe(merge);
    expect(git(f.repo, "show", "-s", "--format=%B", "main")).toContain(`This reverts commit ${merge}`);
    await stopped(f, "red_main");
    expect((await alerts(f, "red_main")).map((a) => a.pattern_key)).toEqual([`red_main:${tip}`]);
    expect(await fixItems(f)).toEqual([`file_fix_item:red_main:${tip}`]);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", loop_count: 1 });
  });

  it("a base that was already red before the automatic merge is not blamed on it: no revert, the item stays merged, auto mode stops", async () => {
    const f = await autoFactory({ spec: UI_CHANGE, ui_check: uiCheck(), change: (n) => `changed ${n}\n` });
    await greenFirst(f);
    // A person's commit on main breaks the check after the green base was stored.
    git(f.repo, "checkout", "--quiet", "main");
    commitIn(f.repo, { "notes/red.md": "BROKEN\n" }, "red by hand");
    git(f.repo, "checkout", "--quiet", "work");
    const { id, merge } = await second(f);
    expect(git(f.repo, "rev-parse", "main")).toBe(merge);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: merge, loop_count: 0 });
    expect((await f.changes(id)).map((c) => c.reason)).not.toContain("merge_check_failed");
    await stopped(f, "red_main");
    expect((await alerts(f, "red_main")).map((a) => a.pattern_key)).toEqual([`red_main:${merge}`]);
    expect(await fixItems(f)).toEqual([`file_fix_item:red_main:${merge}`]);
  });

  it("an automatic merge older than one hour is not reverted and takes the stop", async () => {
    let late = false;
    // The red-main check of the second merge starts 61 minutes after it landed.
    const aging = (s: NoOpSandbox, clock: FakeClock): Sandbox => new Proxy(s, {
      get: (t, k) => (k === "create"
        ? async (...a: Parameters<NoOpSandbox["create"]>) => {
          if (late) clock.advance(61 * 60_000);
          return t.create(...a);
        }
        : Reflect.get(t, k, t)),
    });
    const f = await autoFactory({ spec: UI_CHANGE, ui_check: uiCheck(), change: brokenSecond, controllerSandbox: aging });
    await greenFirst(f);
    late = true;
    const { id, merge } = await second(f);
    expect(git(f.repo, "rev-parse", "main")).toBe(merge);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", merge_sha: merge, loop_count: 0 });
    await stopped(f, "red_main");
  });

  it("a merge made by a person is not reverted and takes the stop", async () => {
    const f = await autoFactory({ spec: UI_CHANGE, ui_check: uiCheck(), change: brokenSecond });
    await greenFirst(f);
    // The tier no longer merges by itself: a person merges the second change.
    await f.setting("auto_merge_max_tier", 0);
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    expect((await f.cli(ME, { action: "command", command: "merge", id, text: "" })).code).toBe(0);
    await f.step();
    const done = (await f.store.getWorkItem(id))!;
    expect(done).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect((await f.changes(id)).find((c) => c.reason === "local_merged")?.actor).toEqual({ kind: "user", id: ME });
    await (await f.controller.unit("local-merge")).redMainCheck(done);
    expect(git(f.repo, "rev-parse", "main")).toBe(done.merge_sha);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", loop_count: 0 });
    await stopped(f, "red_main");
  });
});

describe("auto mode: the flip", { timeout: 60_000 }, () => {
  it("factory mode writes one audit row naming the actor and the time; a project flip applies to that project only", async () => {
    const f = await autoFactory();
    const r = await f.mode("auto", ME, "--project", "o/r");
    expect(r).toMatchObject({ ok: true });
    const rows = await f.modeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ project: f.project.key, actor: ME, new_value: '"auto"', at: f.clock.now().toISOString() });
    const id = await f.create();
    await f.step();
    expect((await f.changes(id)).find((c) => c.reason === "spec_approved")?.actor).toEqual(AUTO);
  });

  it("a flip by anyone but the owner is refused and writes no row", async () => {
    const f = await autoFactory();
    // The first local identity is the owner; DEV is not.
    await f.store.claimOwner(ME);
    const r = await f.mode("auto", DEV);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("approve_merge");
    expect(await f.store.listSettingChanges(10)).toEqual([]);
  });
});
