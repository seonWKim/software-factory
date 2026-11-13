import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/compose.js";
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
import { RECURRING_FAILURE, type UserId, type WorkerId, type WorkItemId } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { StaticGrant } from "../src/impl/grant/static.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { Sandbox } from "../src/interfaces/sandbox.js";
import { parseModeArgs, runSettings } from "../src/settings-cmd.js";
import { FakeRunner, MemoryStorage, cleanScanner, config, prompts, silent, triageSpec } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

// Auto mode (design 03-risk, issue #444): a local factory over a real git repo, as in local-merge-flow.test.ts, with the
// live settings read from the store each tick. The mode is flipped after the controller is built, so every test also
// shows a running controller reading the new mode at its next tick, with no restart.

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

interface Opts {
  /** The triage answer, over triageSpec. */
  spec?: Record<string, unknown>;
  /** The review's tier. */
  reviewTier?: number;
  test_command?: string[];
  /** Wraps the controller's sandbox (the worker keeps the real one). */
  controllerSandbox?: (s: NoOpSandbox) => Sandbox;
  config?: Partial<FactoryConfig>;
  /** The supervisor's restart list the alarm step reads. */
  restarts?: () => Promise<readonly ChildRestart[]>;
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
    repo: { ...config.repo, path: repo, install_command: OK, test_command: opts.test_command ?? OK },
    ...opts.config,
  };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const auth = new LocalAuthProvider(store, [new StaticGrant({ roles: {}, deny: {} })]);
  const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
  const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store });
  const controller = new ControllerRole({
    store, sources: [new LocalSource(store)], auth, local_auth: auth, clock, config: cfg, log: silent, scanner: cleanScanner,
    sandbox: opts.controllerSandbox ? opts.controllerSandbox(sandbox) : sandbox, repeated_failure_rule: false, settings,
    check_env: { PATH: process.env.PATH ?? "" }, ...(opts.restarts ? { restarts: opts.restarts } : {}),
  });
  const runner = new FakeRunner({
    triage: () => ({ output: spec }),
    implement: (s) => {
      commitIn(s.sandbox.workdir, { [file]: "changed\n" }, "the change");
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
    runLocalCli({ store, identity: { user, from: "git user.email" }, project: async () => project.key, read: async () => "the body", newId: () => `id${++n}` }, a);
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
        const d = await auth.authorize({ user_id: who, attributes: {} }, "approve_merge", { kind: "project", id: project.key });
        return d.allow ? null : d.reason;
      },
    }, action);
  };
  const setting = (key: string, value: unknown) => store.setSettingOverride({ key, project: "", value: JSON.stringify(value), actor: ME });
  const messages = async (id: WorkItemId, prefix: string) => (await store.listItemMessages(id)).filter((m) => m.marker.startsWith(prefix)).map((m) => m.body);
  const changes = async (id: WorkItemId) => store.listStateChanges(id);
  const modeRows = async () => (await store.listSettingChanges(50)).filter((c) => c.key === "mode");
  return { repo, store, controller, step, cli, create, fileAsImprover, approveRun, mode, setting, messages, changes, modeRows, project, clock };
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
    expect(merged.detail).toMatchObject({ mode_change: flip!.seq });
    expect((await f.messages(id, "<!-- factory:local-merged:")).join("")).toContain("in auto mode");
    // The red-main check passed: still auto, no alert.
    expect(await f.store.listAlerts({ limit: 10 })).toEqual([]);
    expect((await f.modeRows()).map((r) => r.new_value)).toEqual(['"auto"']);
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

  it("a merge whose checks fail on the merge commit moves nothing and leaves the item in merge_pending", async () => {
    const f = await autoFactory({ test_command: FAILS_ON_MERGE });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const mainBefore = git(f.repo, "rev-parse", "main");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
    // Tried once for this version of the item: one refusal, not one per tick.
    const refused = await f.messages(id, "<!-- factory:refused:auto-merge:");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("The automatic merge was not applied");
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

describe("auto mode: stop conditions", { timeout: 60_000 }, () => {
  const stopped = async (f: Awaited<ReturnType<typeof autoFactory>>, cause: string) => {
    const rows = await f.modeRows();
    expect(rows.map((r) => [r.new_value, r.actor])).toEqual([['"manual"', AUTO_ACTOR], ['"auto"', ME]]);
    const alerts = (await f.store.listAlerts({ limit: 10 })).filter((a) => a.pattern === "auto_stopped");
    expect(alerts.map((a) => a.error_code)).toEqual([cause]);
  };

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
    expect(await lastAutoStop(f.store)).toEqual({ alert_id: alert!.id, at: alert!.created_at, cause: "red_main" });
    const actions = await systemActions({ store: f.store, factory: null, deps: {}, now: f.clock.now(), dashboardRev: null });
    const line = actions.find((a) => a.auto_stop)!;
    expect(line.auto_stop).toMatchObject({ alert_id: alert!.id, cause: "red_main" });
    expect(line.text).toContain(`Alarm: back to manual at ${utcMinute(alert!.created_at)}: the checks failed on the base branch after a merge`);
    // Manual again: the next spec waits.
    const next = await f.create();
    await f.step();
    expect(await f.store.getWorkItem(next)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
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

  it("enterprise: a flip by an account without approve_merge is refused and writes no row", async () => {
    const f = await autoFactory();
    // The first local identity is the owner; the owner makes DEV a requester.
    expect((await f.cli(ME, { action: "users_add", user: DEV, role: "requester" })).code).toBe(0);
    const r = await f.mode("auto", DEV);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("approve_merge");
    expect(await f.store.listSettingChanges(10)).toEqual([]);
  });
});
